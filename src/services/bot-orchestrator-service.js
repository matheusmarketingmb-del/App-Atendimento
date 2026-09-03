// Orquestrador: decide QUAL Bot atende uma conversa e amarra
// interpret() -> decide() -> respond() num resultado padronizado único,
// aplicando a camada de governança (feature flags, apresentação, proteção
// contra loop/ping-pong, kill switch/pausa por humano). Usado tanto pelo
// modo observação (mensagens reais) quanto, com estado totalmente separado,
// pelo simulador multi-turno da tela de Bots.
const prisma = require("../database/prisma");
const { interpret } = require("./bot-interpreter-service");
const { decide } = require("./bot-decision-service");
const { plan } = require("./bot-agent-planner-service");
const { clarificationFor } = require("./bot-tool-orchestrator-service");
const {
  normalizeCaseState, mergeCaseState, recordQuestionAsked,
} = require("./bot-case-state-service");
const { computeResponse, isPersonalityEligible } = require("./bot-response-service");
const { applyPersonality } = require("./bot-personality-service");
const {
  getState, getRecentContext, persistDecision, mergeContextEntities,
} = require("./bot-conversation-state-service");
const { getGlobalSettings, renderPresentationMessage, resolveFeatureFlags } = require("./bot-governance-service");
const { getConversationSettings } = require("./conversation-settings-service");
const { checkResponseLoop, checkSwitchWindow } = require("./bot-loop-guard-service");
const { resolveToolDecision } = require("./bot-tool-orchestrator-service");
const { resolveKnowledgeResponse } = require("./bot-knowledge-response-service");
const { captureHandoffContext } = require("./bot-handoff-service");
const { recordAiUsage } = require("./bot-ai-usage-service");
const { submitRatingFromBot, shouldRequestRating } = require("./bot-rating-service");
const flowEngine = require("./bot-flow-service");

const categorySelection = { id: true, code: true, name: true, color: true, active: true };
const botInclude = {
  defaultCategory: { select: categorySelection },
  schedules: { orderBy: { dayOfWeek: "asc" } },
  intents: {
    include: {
      category: { select: categorySelection },
      examples: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
    },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
  },
  personality: true,
};

// Camada de ESTILO (Personalidade), sempre DEPOIS de respond() já ter
// decidido o texto: só reescreve o TOM quando a origem é elegível (resposta
// de Base de Conhecimento ou de intenção/fallback — nunca Flow Engine, Tool,
// handoff, esclarecimento, social ou fora do horário, ver
// isPersonalityEligible em bot-response-service.js). Nunca lança e nunca
// muda o CONTEÚDO: em qualquer falha ou quando a personalidade não se aplica
// (flag desligada, sem provider externo configurado), devolve o texto
// original de computeResponse() inalterado.
async function respondWithPersonality({ bot, decision, interpretation, message }) {
  const computed = computeResponse({ bot, decision, interpretation });
  if (!computed.text || !isPersonalityEligible(computed.source)) {
    return { text: computed.text, personality: { applied: false, provider: null, systemPrompt: null } };
  }
  const styled = await applyPersonality({ bot, text: computed.text, message });
  return {
    text: styled.text,
    personality: {
      applied: styled.applied, provider: styled.provider, systemPrompt: styled.systemPrompt,
      assistantName: styled.assistantName || null, usage: styled.usage || null,
    },
  };
}

// Traduz a saída do Agent Planner (bot-agent-planner-service.js — action:
// RESPOND/ASK/CLARIFY/SEARCH_KNOWLEDGE/USE_TOOL/HANDOFF/WAIT/RESOLVE) para o
// MESMO formato de decisão que bot-decision-service.js#decide() sempre
// devolveu (action: RESPOND/ASK_CLARIFICATION/HANDOFF_HUMAN/QUERY_TOOL/
// NO_ACTION). É só isto que permite o Planner ser plugado sem duplicar Flow
// Engine/Tools/Knowledge: o resto do pipeline abaixo (startFlow,
// resolveToolDecision, resolveKnowledgeResponse) continua lendo
// `decision.action` exatamente como sempre leu, sem saber que o Planner
// existe. `plannerResult` completo fica pendurado na decisão só para
// diagnóstico (Observação/Simulador — item 12), nunca usado para decidir
// nada além do que já foi mapeado aqui.
function planToLegacyDecision(plannerResult, interpretation) {
  const shared = {
    categoryId: plannerResult.categoryId || null,
    withinHours: true,
    socialBehavior: interpretation.socialBehavior || null,
    greetingReply: interpretation.greetingReply || null,
    summary: plannerResult.reason,
    plannerResult,
  };

  switch (plannerResult.action) {
    case "HANDOFF":
      return { ...shared, action: "HANDOFF_HUMAN", needsClarification: false, shouldHandoff: true };
    case "ASK": {
      const question = clarificationFor([plannerResult.requiredInformation]);
      return {
        ...shared, action: "ASK_CLARIFICATION", needsClarification: true, shouldHandoff: false,
        clarificationQuestion: question,
      };
    }
    case "CLARIFY": {
      const candidates = plannerResult.candidates || [];
      const clarificationQuestion = candidates.length >= 2
        ? `Você quis dizer "${candidates[0].intentName}" ou "${candidates[1].intentName}"? Pode confirmar ou me dar mais detalhes?`
        : undefined;
      return {
        ...shared, action: "ASK_CLARIFICATION", needsClarification: true, shouldHandoff: false,
        ...(clarificationQuestion ? { clarificationQuestion } : {}),
      };
    }
    case "USE_TOOL":
      return {
        ...shared, action: "QUERY_TOOL", needsClarification: false, shouldHandoff: false,
        toolName: plannerResult.toolName, entities: plannerResult.knownEntities,
      };
    case "WAIT":
      return { ...shared, action: "NO_ACTION", needsClarification: false, shouldHandoff: false };
    // RESOLVE/SEARCH_KNOWLEDGE/RESPOND: todos viram RESPOND — o texto real é
    // resolvido a seguir por resolveKnowledgeResponse (Knowledge)/
    // bot-response-service.js (resposta configurada da intenção/fallback),
    // exatamente como o decide() legado já fazia para RESPOND.
    default:
      return { ...shared, action: "RESPOND", needsClarification: false, shouldHandoff: false };
  }
}

// Um Bot atende um canal pelo campo legado `channel` (single-channel,
// comportamento original intocado) OU pelo array aditivo `channels`
// (multi-canal — item 21). Nunca duplicar intents por canal: o mesmo Bot
// só passa a ser encontrado em mais buscas, sua lógica de decisão não muda.
// `type: { not: "SYSTEM_TRIAGE" }` (item "Integrar Bot de Triagem ao sistema
// de Bots"): o Bot de Triagem nunca deve ser resolvido por este motor de
// IA/intenções — ele só é executado por triage-bot-service.js. Sem este
// filtro, o Bot de Triagem (status ACTIVE, canal META) seria escolhido aqui
// como um Bot comum, respondendo com o motor errado.
function channelMatch(channel) {
  return { OR: [{ channel }, { channels: { has: channel } }], type: { not: "SYSTEM_TRIAGE" } };
}

async function resolveBot(activeBotId, channel, client) {
  if (activeBotId) {
    const active = await client.bot.findFirst({
      where: { id: activeBotId, status: "ACTIVE", archivedAt: null, ...channelMatch(channel) },
      include: botInclude,
    });
    if (active) return active;
  }
  return client.bot.findFirst({
    where: { status: "ACTIVE", archivedAt: null, ...channelMatch(channel) },
    include: botInclude,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

async function resolveSwitchTarget(categoryId, channel, currentBotId, client) {
  return client.bot.findFirst({
    where: {
      status: "ACTIVE", archivedAt: null,
      defaultCategoryId: categoryId, id: { not: currentBotId },
      ...channelMatch(channel),
    },
    include: botInclude,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

function categoryNameFor(bot, categoryId) {
  if (!categoryId) return null;
  if (bot.defaultCategoryId === categoryId) return bot.defaultCategory?.name || null;
  const intent = (bot.intents || []).find((item) => item.categoryId === categoryId);
  return intent?.category?.name || null;
}

// Sessão "expirada": o estado operacional (intenção pendente, falhas,
// esclarecimento em aberto) não pode ser tratado como verdade para uma nova
// conversa — não apaga histórico real, só reinicia o estado do Bot.
function isSessionExpired(state, ttlMinutes, now) {
  if (!state?.updatedAt) return false;
  const elapsedMinutes = (now.getTime() - new Date(state.updatedAt).getTime()) / 60000;
  return elapsedMinutes > ttlMinutes;
}

function toStandardResult({ bot, targetBot, interpretation, decision, responseText, extras = {} }) {
  return {
    botId: targetBot.id,
    botName: targetBot.name,
    switchedFromBotId: targetBot.id !== bot.id ? bot.id : null,
    intentId: interpretation.intentId,
    intentName: interpretation.intentName,
    confidence: interpretation.confidence,
    matchedExample: interpretation.matchedExample,
    provider: interpretation.provider,
    status: interpretation.status,
    errorCode: interpretation.errorCode,
    action: decision.action,
    categoryId: decision.categoryId,
    categoryName: categoryNameFor(targetBot, decision.categoryId),
    needsClarification: decision.needsClarification,
    shouldHandoff: decision.shouldHandoff,
    withinHours: decision.withinHours,
    socialBehavior: interpretation.socialBehavior || null,
    extractedEntities: interpretation.entities,
    summary: decision.summary,
    response: responseText,
    // Item 18/19 (simulador/observação): rastro do que o motor usaria/
    // chamaria, sem nunca ter executado nada externo de verdade fora do
    // modo LIVE — reaproveita o que decide()/resolveToolDecision()/
    // resolveKnowledgeResponse() já calcularam, nunca recalcula aqui.
    toolName: decision.toolName || null,
    knowledgeSourceId: decision.knowledgeSourceId || null,
    knowledgeSourceTitle: decision.knowledgeSourceTitle || null,
    knowledgeConflict: Boolean(decision.knowledgeConflict),
    calledExternalAi: Boolean(interpretation.calledExternalAi),
    externalProvider: interpretation.externalProvider || null,
    externalAccepted: Boolean(interpretation.externalAccepted),
    externalStatus: interpretation.externalStatus || null,
    externalErrorCode: interpretation.externalErrorCode || null,
    ...extras,
  };
}

function findIntentInBot(bot, intentId) {
  return (bot.intents || []).find((intent) => intent.id === intentId) || null;
}

// Stubs de interpretation/decision para quando quem decidiu a resposta foi o
// Flow Engine (etapa em andamento ou recém-iniciada), não interpret()/decide().
// Mantêm o mesmo formato usado pelo resto do pipeline (toStandardResult,
// persistDecision) para não duplicar essa lógica.
function flowInterpretationStub(intent, outcome) {
  return {
    intentId: intent.id, intentName: intent.name, confidence: 1, matchedExample: null,
    entities: outcome.flow.collectedEntities || {}, provider: "FLOW_ENGINE", status: "OK",
    errorCode: null, socialBehavior: null,
  };
}

function flowDecisionStub(intent, outcome) {
  return {
    action: outcome.terminal === "HANDOFF" ? "HANDOFF_HUMAN" : "RESPOND",
    categoryId: intent.categoryId || null, needsClarification: false,
    shouldHandoff: outcome.terminal === "HANDOFF", withinHours: true,
    summary: outcome.summary, flowResponseText: outcome.responseText,
  };
}

// Núcleo compartilhado por orchestrate() (conversa real) e
// simulateOrchestration() (simulador): interpreta, decide, aplica proteção
// de loop/ping-pong e apresentação. Quem chama decide o que persistir.
// `state` alimenta interpret()/decide() (memória conversacional: intenção
// pendente, falhas, entidades) — pode ser null se contextEnabled estiver
// desligado ou a sessão tiver expirado. `guardState` alimenta as proteções
// de loop/troca de Bot/apresentação — só é null quando a sessão realmente
// expirou (essas proteções não dependem de contextEnabled).
// `humanPaused` (item 3): quando true, o Flow Engine nunca continua nem
// inicia um fluxo novo (congelado exatamente onde estava) — só
// interpret()/decide() seguem rodando, para Observação/sugestão de resposta
// continuarem funcionando. `flowStack`/`seedEntities` — itens 5/6.
async function runDecisionPipeline({
  bot, message, context, state, guardState, previousIntroducedAt, flags, now, channel, client, sessionExpired = false,
  toolMode = "OBSERVATION", humanPaused = false, flowStack = [], seedEntities = null,
}) {
  let interpretation;
  let decision;
  let flowUpdate = null;
  let flowStackUpdate = flowStack;
  let topicSwitchDetected = false;

  // Flow Engine (múltiplas etapas): se já existe uma etapa aguardando
  // resposta nesta conversa, a mensagem é interpretada como resposta a ELA,
  // não reclassificada do zero — mesmo espírito do carryOverFromContext já
  // existente para "sim"/"não" após esclarecimento (item 5). Nunca continua
  // um fluxo enquanto um humano estiver com a conversa (item 3).
  if (!humanPaused && flags.flowEngineEnabled !== false && state?.currentFlowStepId && state?.activeFlowIntentId) {
    const flowIntent = findIntentInBot(bot, state.activeFlowIntentId);
    if (flowIntent) {
      const outcome = await flowEngine.continueFlow({
        bot, intent: flowIntent, message, state, channel, mode: toolMode, client, context,
      });
      if (outcome.topicSwitch) {
        // Item 4/5: a mensagem não é resposta à etapa pendente — é uma
        // intenção nova. Congela o fluxo atual na pilha e cai para o
        // pipeline normal abaixo, que interpreta/decide como se não houvesse
        // fluxo em andamento (a nova intenção pode, ela mesma, ter fluxo).
        topicSwitchDetected = true;
        flowStackUpdate = flowEngine.pushFlowStack(flowStack, state);
      } else {
        interpretation = flowInterpretationStub(flowIntent, outcome);
        decision = flowDecisionStub(flowIntent, outcome);
        flowUpdate = outcome.flow;
      }
    }
  }

  let caseStateUpdate = null;

  if (!decision) {
    interpretation = await interpret({ bot, message, context, state, flags });

    if (flags.agentPlannerEnabled === true) {
      // Intent como sinal (item 2): o candidato top-1 já vem com o reforço
      // semântico de bot-semantic-normalizer.js/bot-intent-ranking-service.js
      // (typo/abreviação/paráfrase) — o `interpretation.intentId` legado,
      // usado por resolveKnowledgeResponse/Flow Engine logo abaixo, não
      // tinha esse reforço. Só promove quando o status é "OK" (um candidato
      // claro) e só quando o Planner está ligado — um Bot que não ligou a
      // flag continua com intentId exatamente como sempre foi.
      if (interpretation.intentStatus === "OK" && interpretation.intentCandidates[0]) {
        const top = interpretation.intentCandidates[0];
        interpretation = { ...interpretation, intentId: top.intentId, intentName: top.intentName, confidence: top.confidence };
      }

      // Contexto real (item 4): lido do MESMO `state` que já alimenta
      // contextEntities/flow* — nunca uma consulta extra ao banco. No
      // simulador, `state` é o objeto transitório da sessão de teste; numa
      // conversa real, é o ConversationBotState já carregado por
      // orchestrate(). Ambos os casos tratam ausência como caso vazio.
      const caseState = normalizeCaseState(state?.caseState);
      const plannerResult = plan({ bot, interpretation, caseState });
      decision = planToLegacyDecision(plannerResult, interpretation);

      // Registra a pergunta feita (ASK/CLARIFY) para nunca repeti-la
      // enquanto a resposta não chegar — mesma ideia de "não perguntar de
      // novo o que já é conhecido", agora também para PERGUNTAS já feitas,
      // não só para entidades já capturadas.
      const askedQuestion = decision.clarificationQuestion || null;
      caseStateUpdate = askedQuestion ? recordQuestionAsked(caseState, askedQuestion) : caseState;
    } else {
      decision = decide({ bot, interpretation, message, state, now, flags });
    }

    // Uma intenção com etapas configuradas (Fluxo de atendimento) é
    // conduzida pelo Flow Engine em vez da resposta/Tool/conhecimento de
    // etapa única — reaproveitando resolveToolDecision/KnowledgeProvider por
    // dentro de cada etapa, nunca reimplementando as checagens de segurança.
    if (!humanPaused && flags.flowEngineEnabled !== false && interpretation.intentId && ["RESPOND", "QUERY_TOOL"].includes(decision.action)) {
      const hasFlow = await flowEngine.hasActiveFlow(interpretation.intentId, client);
      if (hasFlow) {
        const flowIntent = findIntentInBot(bot, interpretation.intentId);
        const outcome = await flowEngine.startFlow({ bot, intent: flowIntent, channel, mode: toolMode, client, seedEntities });
        if (outcome) {
          decision = { ...decision, ...flowDecisionStub(flowIntent, outcome) };
          flowUpdate = outcome.flow;
        }
      }
    }

    if (!flowUpdate) {
      // Itens 5-8/10/11: se a decisão sugeriu QUERY_TOOL, o backend valida e
      // (só em modo LIVE) executa a Tool aqui — nunca antes de decide(), nunca
      // pela IA diretamente. Vira ASK_CLARIFICATION, RESPOND (com dado real ou
      // fallback seguro) conforme o resultado da validação.
      decision = await resolveToolDecision({ bot, decision, channel, mode: toolMode });

      // Item 4: Message -> Intent Interpreter -> Intenção -> KnowledgeProvider ->
      // conhecimento relevante -> Resposta. Só entra em jogo se a decisão ainda
      // for RESPOND (não interfere com QUERY_TOOL/ASK_CLARIFICATION/HANDOFF).
      decision = await resolveKnowledgeResponse({ bot, decision, interpretation, message, flags, contextProduct: seedEntities?.productName });
    }
  }

  // Item 5 (múltiplas intenções): a intenção que causou a troca de assunto
  // terminou (fluxo concluído/encaminhado, ou respondida sem fluxo nenhum) —
  // retoma o que estava pausado na pilha, se houver algo.
  let resumedFromStack = null;
  const reachedTerminal = flowUpdate
    ? flowUpdate.currentStepId === null
    : ["RESPOND", "HANDOFF_HUMAN"].includes(decision.action);
  if (!humanPaused && reachedTerminal && flowStackUpdate.length) {
    const { snapshot, remainingStack } = flowEngine.popFlowStack(flowStackUpdate);
    if (snapshot) {
      resumedFromStack = snapshot;
      flowUpdate = flowEngine.flowPersistFromSnapshot(snapshot);
      flowStackUpdate = remainingStack;
    }
  }

  let targetBot = bot;
  let switchInfo = {
    switchCount: guardState?.switchCount ?? 0,
    switchWindowStartedAt: guardState?.switchWindowStartedAt ?? null,
  };
  if (decision.action === "SWITCH_BOT" && decision.categoryId) {
    if (flags.autoSwitchEnabled === false) {
      decision = { ...decision, action: "RESPOND" };
    } else {
      const switchCheck = checkSwitchWindow(guardState, flags, now);
      switchInfo = { switchCount: switchCheck.switchCount, switchWindowStartedAt: switchCheck.switchWindowStartedAt };
      if (!switchCheck.allowed) {
        decision = {
          ...decision, action: "HANDOFF_HUMAN", shouldHandoff: true,
          summary: `${decision.summary} Limite de trocas de Bot na janela recente atingido (proteção contra ping-pong); encaminhando para humano.`,
        };
      } else {
        const candidate = await resolveSwitchTarget(decision.categoryId, channel, bot.id, client);
        if (candidate) targetBot = candidate;
      }
    }
  }

  let { text: responseText, personality: personalityInfo } = await respondWithPersonality({
    bot: targetBot, decision, interpretation, message,
  });

  // Item 5: sinaliza ao cliente que o assunto anterior não foi esquecido.
  if (resumedFromStack?.pendingQuestion) {
    const resumeLine = `Voltando ao que você havia perguntado antes: ${resumedFromStack.pendingQuestion}`;
    responseText = responseText ? `${responseText}\n\n${resumeLine}` : resumeLine;
  }

  const priorIntroducedAt = previousIntroducedAt === undefined
    ? (guardState?.introducedAt || null) : previousIntroducedAt;
  const shouldIntroduce = Boolean(targetBot.introduceWithName) && Boolean(responseText)
    && (!priorIntroducedAt || (sessionExpired && targetBot.reintroduceOnNewSession));
  if (shouldIntroduce) {
    const presentation = renderPresentationMessage(targetBot.presentationMessage, { botName: targetBot.name });
    responseText = `${presentation} ${responseText}`;
  }

  const loopCheck = checkResponseLoop(guardState, responseText);
  if (loopCheck.looped && !["HANDOFF_HUMAN", "NO_ACTION"].includes(decision.action)) {
    decision = {
      ...decision, action: "HANDOFF_HUMAN", shouldHandoff: true,
      summary: `${decision.summary} A mesma resposta se repetiu; proteção contra loop encaminhou para humano.`,
    };
    // HANDOFF_HUMAN nunca é elegível para reescrita de personalidade (ver
    // isPersonalityEligible) — usa computeResponse() direto, sem chamar IA
    // de novo à toa para um texto que já sabemos que sai palavra por
    // palavra.
    responseText = computeResponse({ bot: targetBot, decision, interpretation }).text;
    personalityInfo = { applied: false, provider: null, systemPrompt: null };
  }
  const finalLoop = checkResponseLoop(guardState, responseText);

  const operational = {
    ...switchInfo,
    introducedAt: shouldIntroduce ? now : priorIntroducedAt,
    lastResponseHash: finalLoop.hash,
    lastResponseRepeatCount: finalLoop.repeatCount,
  };

  // Captura de entidade no Case State (item 4): só quando o Planner rodou
  // (caseStateUpdate só é setado nesse caminho) — produto é a primeira
  // entidade "promovida" do bag genérico de intepretation.entities para o
  // caso estruturado; mesma regra de nunca sobrescrever um fato já sabido
  // com vazio (ver mergeCaseState).
  if (caseStateUpdate) {
    caseStateUpdate = mergeCaseState(caseStateUpdate, { product: interpretation.entities?.productName || null });
  }

  return {
    interpretation, decision, targetBot, responseText, operational, flow: flowUpdate,
    flowStackUpdate, topicSwitchDetected, personalityInfo, caseStateUpdate,
  };
}

// Interpreta e decide para uma conversa REAL, persistindo o estado do Bot
// nessa conversa (ConversationBotState). Não altera Conversation/Message.
async function orchestrate({
  conversationId, channel = "META", messageId = null, message, now = new Date(), executionMode = "LIVE",
}, client = prisma) {
  const state = await getState(conversationId, client);
  const bot = await resolveBot(state?.activeBotId, channel, client);
  if (!bot) return null;

  const globalSettings = await getGlobalSettings(client);
  const flags = resolveFeatureFlags(bot);
  // Configurações → Conversas (item 5): contextExpirationMinutes só é
  // explícito quando o próprio Bot o define em featureFlags; caso contrário,
  // o TTL vem do default global central (botContextTtlMinutes), não mais do
  // hardcode 120 em bot-constants.js.
  const hasExplicitBotTtl = bot.featureFlags && typeof bot.featureFlags === "object"
    && bot.featureFlags.contextExpirationMinutes !== undefined;
  const contextTtlMinutes = hasExplicitBotTtl
    ? flags.contextExpirationMinutes
    : (await getConversationSettings(client)).botContextTtlMinutes;
  const sessionExpired = isSessionExpired(state, contextTtlMinutes, now);
  const conversationalState = flags.contextEnabled && !sessionExpired ? state : null;
  const operationalState = sessionExpired ? null : state;

  // Item 3 (humano assumiu): calculado ANTES do pipeline — precisa decidir
  // se o Flow Engine/Tools rodam de verdade neste turno, não só se a
  // resposta final seria enviada. Antes desta correção, um humano podia
  // estar atendendo enquanto o Flow Engine/Tools continuavam avançando (e
  // até executando Tools reais) por baixo, só porque a resposta final não
  // era enviada — o estado ficava fora de sincronia com o que o humano via.
  let humanPaused = false;
  if (flags.handoffAutoPauseEnabled) {
    const conversation = await client.conversation.findUnique({
      where: { id: conversationId }, select: { assignedUserId: true, status: true },
    });
    humanPaused = Boolean(conversation?.assignedUserId)
      && ["EM_ATENDIMENTO", "AGUARDANDO_EQUIPE", "AGUARDANDO_CLIENTE"].includes(conversation?.status);
  }

  // Item 9 (avaliação do cliente): se a mensagem anterior pediu uma nota e
  // esta é a resposta, trata como avaliação em vez de reclassificar do zero
  // — nunca roda o pipeline normal de intenção para um dígito de 1 a 5.
  if (!humanPaused && state?.awaitingRatingScore) {
    const score = Number(String(message || "").trim());
    if (Number.isInteger(score) && score >= 1 && score <= 5) {
      await submitRatingFromBot({
        botId: bot.id, conversationId, score,
        resolvedByBot: !state.activeFlowIntentId ? false : state.flowResolutionStatus === "RESOLVED",
        handoffOccurred: Boolean(state.flowResolutionStatus === "HANDED_OFF"),
        intentId: state.activeFlowIntentId || state.lastIntentId || null,
      }, client).catch((error) => {
        console.error("[BOT_RATING] falha ao registrar avaliação vinda do cliente (ignorada)", error.message);
      });
      await client.conversationBotState.update({
        where: { conversationId }, data: { awaitingRatingScore: false },
      });
      return toStandardResult({
        bot, targetBot: bot,
        interpretation: { intentId: null, intentName: null, confidence: null, matchedExample: null, entities: {}, provider: "RATING", status: "OK", errorCode: null },
        decision: { action: "RESPOND", categoryId: null, needsClarification: false, shouldHandoff: false, withinHours: true, summary: "Avaliação do cliente registrada." },
        responseText: bot.ratingFollowupMessage || null,
        extras: { humanPaused: false, automationBlocked: false, observationAllowed: false, learningEnabled: flags.learningEnabled, ratingRecorded: true },
      });
    }
  }

  const context = flags.contextEnabled
    ? await getRecentContext(conversationId, { beforeMessageId: messageId, limit: flags.contextMaxMessages }, client)
    : [];

  // Itens 7/11: uma Tool só é executada de VERDADE quando este Bot está
  // realmente apto a responder automaticamente ao cliente (automação global
  // ligada + autoReplyEnabled do Bot) E nenhum humano assumiu a conversa
  // (item 3). Fora isso, mesmo dentro de uma conversa real, o modo é
  // "observação" — nunca chama a Tool de verdade, só registra o que teria
  // sido consultado.
  const toolMode = executionMode === "LIVE" && globalSettings.automationEnabled && bot.autoReplyEnabled && !humanPaused
    ? "LIVE" : "OBSERVATION";

  // Item 6 (contexto de produto): memória de entidades da CONVERSA inteira,
  // resetada junto com o resto do estado operacional quando a sessão expira
  // (mesmo TTL — nunca reaproveita produto de uma sessão antiga).
  const priorContextEntities = sessionExpired ? {} : (state?.contextEntities || {});
  const flowStackBefore = sessionExpired ? [] : (state?.flowStack || []);

  const {
    interpretation, decision, targetBot, responseText, operational, flow, flowStackUpdate, topicSwitchDetected,
    personalityInfo, caseStateUpdate,
  } = await runDecisionPipeline({
    bot, message, context, state: conversationalState, guardState: operationalState,
    previousIntroducedAt: state?.introducedAt || null, flags, now, channel, client, sessionExpired, toolMode,
    humanPaused, flowStack: flowStackBefore, seedEntities: priorContextEntities,
  });

  const targetFlags = targetBot.id === bot.id ? flags : resolveFeatureFlags(targetBot);

  if (decision.action === "HANDOFF_HUMAN") {
    try {
      const decisionWithCategoryName = { ...decision, categoryName: categoryNameFor(targetBot, decision.categoryId) };
      await captureHandoffContext({
        conversationId, bot: targetBot, interpretation, decision: decisionWithCategoryName, message, context,
        flow, product: priorContextEntities?.productName || interpretation.entities?.productName || null,
      }, client);
    } catch (error) {
      // Nunca pode derrubar a interpretação/observação por falha ao gravar o
      // contexto de handoff — só loga.
      console.error("[BOT_HANDOFF] falha ao capturar contexto (ignorada)", error.message);
    }
    // Item 8 (status operacional): só em execução real (LIVE — nunca em
    // simulação/observação) e só quando a conversa ainda não tem humano
    // ativo (não sobrescreve EM_ATENDIMENTO/AGUARDANDO_CLIENTE/HANDOFF_BOT/
    // FINALIZADO já existentes). Nunca lança: uma falha aqui não pode
    // impedir a resposta de handoff de ser enviada ao cliente.
    if (executionMode === "LIVE") {
      try {
        await client.conversation.updateMany({
          where: { id: conversationId, status: { in: ["NOVO", "BOT", "AGUARDANDO_EQUIPE"] } },
          data: { status: "HANDOFF_BOT" },
        });
      } catch (error) {
        console.error("[BOT_HANDOFF] falha ao marcar status HANDOFF_BOT (ignorada)", error.message);
      }
    }
  }

  const automationBlocked = !globalSettings.automationEnabled || !targetBot.autoReplyEnabled;
  const observationAllowed = globalSettings.observationEnabled && flags.observationEnabled;

  // Item 2 (expiração de contexto): a sessão expirou e nenhum fluxo NOVO
  // começou neste turno (ex.: a intenção reconhecida não tem etapas) — os
  // campos flow* de uma sessão anterior nunca podem sobreviver "escondidos"
  // no banco, senão a PRÓXIMA mensagem (já dentro da janela, updatedAt
  // acabou de ser renovado) reataria o fluxo antigo como se fosse atual.
  // Enquanto pausado por humano (item 3), o fluxo fica CONGELADO — nunca
  // resetado nem avançado, `flow` já vem null nesse caso.
  const flowToPersist = flow || (sessionExpired && !humanPaused ? flowEngine.resetFlowPersist() : null);

  const contextEntitiesUpdate = mergeContextEntities(
    mergeContextEntities(priorContextEntities, interpretation.entities),
    flow?.collectedEntities || {},
  );

  // Item 9 (avaliação do cliente): decide se esta é a hora de pedir a nota —
  // nunca em Observação, nunca duas vezes na mesma conversa, nunca enquanto
  // um humano já assumiu.
  const ratingTrigger = !humanPaused && toolMode === "LIVE"
    ? shouldRequestRating({ bot, flags, globalSettings, state, decision, flow })
    : { request: false };

  let finalResponseText = responseText;
  if (ratingTrigger.request && bot.ratingMessage) {
    finalResponseText = finalResponseText ? `${finalResponseText}\n\n${bot.ratingMessage}` : bot.ratingMessage;
  }

  await persistDecision({
    conversationId, bot: targetBot, interpretation, decision,
    operational: {
      ...operational, humanPausedAt: humanPaused ? (state?.humanPausedAt || now) : null,
      ...(ratingTrigger.request ? { ratingRequestedAt: now, awaitingRatingScore: true } : {}),
    },
    flow: flowToPersist,
    contextEntities: contextEntitiesUpdate,
    flowStack: flowStackUpdate,
    caseState: caseStateUpdate !== null ? caseStateUpdate : undefined,
  }, client);

  // Item 15 (custo/uso de IA): registra a chamada real ao provider externo,
  // independente do resultado ter virado resposta ou não — o gasto já
  // aconteceu. Nunca acontece para o simulador (simulateOrchestration não
  // passa por aqui) nem quando o fallback externo está desligado.
  if (interpretation.calledExternalAi) {
    await recordAiUsage({
      botId: targetBot.id, provider: interpretation.externalProvider || interpretation.provider, reason: "LOW_LOCAL_CONFIDENCE",
      usage: interpretation.aiUsage,
    }, client);
  }
  // Mesmo item 15, para a reescrita de personalidade: só quando ela
  // realmente chamou um provider externo (nunca para o simulador, que usa
  // simulateOrchestration() e não passa por este bloco).
  if (personalityInfo?.applied) {
    await recordAiUsage({
      botId: targetBot.id, provider: personalityInfo.provider, reason: "PERSONALITY_REPHRASE",
      usage: personalityInfo.usage,
    }, client);
  }

  // A finalização só pode ocorrer DEPOIS que uma futura camada de envio
  // confirmar a entrega da resposta. Hoje o orquestrador também é chamado
  // pelo observador passivo; portanto ele apenas sinaliza a intenção e nunca
  // altera Conversation diretamente.
  const autoFinalizeRequested = flow?.resolutionStatus === "RESOLVED"
    && flags.autoFinalizeOnResolution === true && toolMode === "LIVE" && !humanPaused;

  return toStandardResult({
    bot, targetBot, interpretation, decision, responseText: finalResponseText,
    extras: {
      humanPaused, automationBlocked, observationAllowed, learningEnabled: flags.learningEnabled,
      agentSuggestionsAllowed: targetFlags.agentSuggestionsEnabled,
      flowStepId: flow?.currentStepId ?? null, flowResolutionStatus: flow?.resolutionStatus ?? null,
      flowIntentId: flow?.intentId ?? null, flowPendingQuestion: flow?.pendingQuestion ?? null,
      autoFinalizeRequested, topicSwitchDetected, ratingRequested: ratingTrigger.request,
      // Item 7 (sugestão para o atendente): o texto que o motor calculou
      // fica sempre disponível aqui (mesmo em modo observação) — quem
      // decide persistir/mostrar ao atendente é bot-observation-service.js.
      suggestedResponseText: targetFlags.agentSuggestionsEnabled ? (finalResponseText || null) : null,
      // Personalidade (Bot -> Personalidade): mostra se o texto acima saiu
      // reescrito no tom configurado, e por qual provider — nunca indica
      // QUAL foi o conteúdo original (isso é auditoria, não UI de cliente).
      personalityApplied: Boolean(personalityInfo?.applied),
      personalityProvider: personalityInfo?.provider || null,
      personalityAssistantName: personalityInfo?.assistantName || null,
      // Agent Planner (item 3): só preenchido quando agentPlannerEnabled
      // está ligado neste Bot — auditoria leve, o detalhe completo
      // (candidatos/case state) fica só no simulador (item 12).
      plannerAction: decision.plannerResult?.action || null,
      plannerReason: decision.plannerResult?.reason || null,
    },
  });
}

// Mesma interpretação, mas para o simulador: usa um "estado" transitório
// fornecido pelo cliente (nunca a tabela ConversationBotState) e nunca troca
// de Bot fora da lista de Bots ativos do canal — apenas sinaliza a sugestão.
async function simulateOrchestration({ bot, message, context = [], state = null, now = new Date() }) {
  // O simulador deve permitir testar configurações em rascunho sem ativá-las
  // no modo observação. A cópia em memória nunca é persistida.
  const simulationBot = bot.status === "ACTIVE" ? bot : { ...bot, status: "ACTIVE" };
  const flags = resolveFeatureFlags(simulationBot);
  const priorContextEntities = state?.contextEntities || {};

  const {
    interpretation, decision, targetBot: simulatedTargetBot, responseText, operational, flow, flowStackUpdate,
    topicSwitchDetected, personalityInfo, caseStateUpdate,
  } = await runDecisionPipeline({
    bot: simulationBot, message, context, state, guardState: state, flags, now, channel: bot.channel, client: prisma,
    sessionExpired: false, flowStack: state?.flowStack || [], seedEntities: priorContextEntities,
    // O simulador é uma caixa de areia do painel administrativo (nunca fala
    // com um cliente real) — pode mostrar o comportamento real de uma Tool
    // (LIVE) sem violar a regra de "Observação nunca chama Tool de verdade"
    // (item 11), que é sobre conversas reais de clientes.
    toolMode: "LIVE",
  });
  const targetBot = simulatedTargetBot.id === simulationBot.id ? bot : simulatedTargetBot;

  const contextEntitiesUpdate = mergeContextEntities(
    mergeContextEntities(priorContextEntities, interpretation.entities),
    flow?.collectedEntities || {},
  );

  const nextState = {
    activeBotId: targetBot.id,
    lastIntentId: interpretation.intentId || null,
    lastConfidence: interpretation.confidence ?? null,
    failedInterpretations: decision.action === "ASK_CLARIFICATION" || decision.action === "HANDOFF_HUMAN"
      ? (decision.failureCount ?? 0) : 0,
    pendingClarification: decision.needsClarification || false,
    extractedEntities: interpretation.entities || {},
    lastBotAction: decision.action || null,
    contextEntities: contextEntitiesUpdate,
    flowStack: flowStackUpdate,
    ...operational,
    // Item 8/18 (Simulador): expõe intenção/etapa atual/entidades coletadas/
    // pergunta pendente do Flow Engine para a UI mostrar o progresso do
    // atendimento em etapas.
    activeFlowIntentId: flow ? flow.intentId : (state?.activeFlowIntentId ?? null),
    currentFlowStepId: flow ? flow.currentStepId : null,
    flowCollectedEntities: flow ? flow.collectedEntities : (state?.flowCollectedEntities ?? null),
    flowAskedQuestions: flow ? flow.askedQuestions : (state?.flowAskedQuestions ?? null),
    flowAttemptedSolutions: flow ? flow.attemptedSolutions : (state?.flowAttemptedSolutions ?? null),
    flowFailedSteps: flow ? flow.failedSteps : (state?.flowFailedSteps ?? null),
    flowResolutionStatus: flow ? flow.resolutionStatus : (state?.flowResolutionStatus ?? null),
    pendingQuestion: flow ? (flow.pendingQuestion ?? null) : (state?.pendingQuestion ?? null),
    // Case State (item 4/12): só atualizado quando o Agent Planner rodou
    // (flags.agentPlannerEnabled=true nesta simulação) — senão mantém o que
    // já existia na sessão de teste, igual aos campos flow* acima.
    caseState: caseStateUpdate !== null ? caseStateUpdate : (state?.caseState ?? null),
  };

  return {
    ...toStandardResult({
      bot, targetBot, interpretation, decision, responseText,
      extras: {
        topicSwitchDetected,
        // Item "Adicionar preview/teste": o simulador é o ÚNICO lugar que
        // expõe o system prompt de personalidade completo (útil para o
        // Master conferir exatamente o que seria enviado ao provider de IA
        // antes das mensagens) — nunca exposto em conversas reais
        // (orchestrate()) por não ser algo que o atendente precisa ver.
        personalityApplied: Boolean(personalityInfo?.applied),
        personalityProvider: personalityInfo?.provider || null,
        personalityAssistantName: personalityInfo?.assistantName || null,
        personalitySystemPrompt: personalityInfo?.systemPrompt || null,
        // Simulador como diagnóstico (item 12): cada estágio do pipeline
        // fica visível — normalização semântica, candidatos de intent (com
        // evidência), e a decisão estruturada do Agent Planner (quando
        // ligado). `intentCandidates`/`semantic` existem sempre (Fase 1,
        // independente da flag); `plannerResult` só quando
        // agentPlannerEnabled está ligado neste Bot.
        normalizedMessage: interpretation.semantic?.normalized || null,
        detectedConcepts: interpretation.semantic?.concepts || [],
        intentCandidates: interpretation.intentCandidates || [],
        intentStatus: interpretation.intentStatus || null,
        plannerAction: decision.plannerResult?.action || null,
        plannerReason: decision.plannerResult?.reason || null,
        plannerResult: decision.plannerResult || null,
        caseState: caseStateUpdate !== null ? caseStateUpdate : (state?.caseState ?? null),
      },
    }),
    nextState,
  };
}

// Item 2: gate único para "o Bot pode mesmo enviar esta resposta ao
// cliente?" — falso se a automação estiver bloqueada (kill switch/Bot
// desligado) OU se um humano já assumiu a conversa (humanPaused). Nunca
// envia resposta concorrente/duplicada por cima de um atendimento humano.
function shouldAutoRespond(result) {
  return Boolean(result) && !result.automationBlocked && !result.humanPaused;
}

module.exports = { botInclude, orchestrate, resolveBot, shouldAutoRespond, simulateOrchestration };
