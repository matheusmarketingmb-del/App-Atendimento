// Flow Engine: conduz uma BotIntent por várias etapas configuráveis em vez
// de responder uma única vez. Reaproveita o que já existe (nunca duplica
// regras de segurança):
//   - Tools continuam validadas/executadas só por resolveToolDecision()
//     (bot-tool-orchestrator-service.js) — bloqueio por desativada/sem
//     permissão/entidade faltando é o MESMO caminho de sempre.
//   - Base de Conhecimento continua vindo de KnowledgeSourceProvider
//     (bot-knowledge/knowledge-provider.js) — nunca inventa conteúdo.
//   - "sim"/"não"/frases de resolução reaproveitam os padrões já existentes
//     em bot-constants.js (CONFIRMATION_PATTERN/NEGATION_PATTERN/
//     RESOLUTION_POSITIVE_PATTERNS/RESOLUTION_NEGATIVE_PATTERNS).
//
// Uma BotIntent sem nenhuma BotFlowStep ativa continua exatamente como antes
// (responseMessage/toolName/Base de Conhecimento de intenção, resposta única)
// — o motor só assume quando existem etapas ativas para a intenção decidida.
const prisma = require("../database/prisma");
const { normalizeText } = require("./bot-simulator-service");
const {
  CONFIRMATION_PATTERN, NEGATION_PATTERN, RESOLUTION_NEGATIVE_PATTERNS, RESOLUTION_POSITIVE_PATTERNS,
  DEFAULT_HIGH_CONFIDENCE_THRESHOLD,
} = require("./bot-constants");
const { resolveToolDecision } = require("./bot-tool-orchestrator-service");
const { isActiveNow } = require("./bot-knowledge-source-service");
const { KnowledgeSourceProvider } = require("./bot-knowledge/knowledge-provider");
const { interpretWithProviders } = require("./bot-interpreter-service");
const { getFallbackProvider } = require("./ai/get-ai-provider");

const defaultKnowledgeProvider = new KnowledgeSourceProvider();

// Segurança (item 9): nunca encadear etapas automáticas indefinidamente —
// GOTO_STEP mal configurado (ciclo) sempre acaba em handoff, nunca trava.
const MAX_CHAIN_STEPS = 12;
const DEFAULT_MAX_ATTEMPTS = 3;
function knowledgeAccessWhere(botId) {
  return {
    OR: [
      { botAccesses: { some: { botId } } },
      { botId },
      { AND: [{ botId: null }, { botAccesses: { none: {} } }] },
    ],
  };
}

const flowStepSelect = {
  id: true, intentId: true, name: true, order: true, action: true, question: true, entityKey: true,
  required: true, knowledgeSourceId: true, toolName: true, responseMessage: true,
  nextStepId: true, onSuccessStepId: true, onFailureStepId: true, gotoStepId: true, maxAttempts: true,
  active: true, createdAt: true, updatedAt: true,
};

// ---------------------------------------------------------------------------
// CRUD (usado pela tela "Fluxo de atendimento" da intenção)
// ---------------------------------------------------------------------------

async function listFlowSteps(intentId, client = prisma) {
  return client.botFlowStep.findMany({ where: { intentId }, orderBy: { order: "asc" }, select: flowStepSelect });
}

async function getActiveOrderedSteps(intentId, client = prisma) {
  return client.botFlowStep.findMany({
    where: { intentId, active: true }, orderBy: { order: "asc" }, select: flowStepSelect,
  });
}

async function hasActiveFlow(intentId, client = prisma) {
  const count = await client.botFlowStep.count({ where: { intentId, active: true } });
  return count > 0;
}

function nextOrderFor(existingSteps) {
  return existingSteps.reduce((max, step) => Math.max(max, step.order), 0) + 1;
}

async function assertStepBelongsToIntent(intentId, stepId, client) {
  if (!stepId) return true;
  const step = await client.botFlowStep.findUnique({ where: { id: stepId }, select: { intentId: true } });
  return Boolean(step && step.intentId === intentId);
}

function flowStepInput(body = {}) {
  return {
    name: String(body.name || "").trim().slice(0, 120),
    action: body.action,
    question: body.question ? String(body.question).trim().slice(0, 1000) : null,
    entityKey: body.entityKey ? String(body.entityKey).trim().slice(0, 60) : null,
    required: body.required !== false,
    knowledgeSourceId: body.knowledgeSourceId || null,
    toolName: body.toolName ? String(body.toolName).trim() : null,
    responseMessage: body.responseMessage ? String(body.responseMessage).trim().slice(0, 4000) : null,
    nextStepId: body.nextStepId || null,
    onSuccessStepId: body.onSuccessStepId || null,
    onFailureStepId: body.onFailureStepId || null,
    gotoStepId: body.gotoStepId || null,
    maxAttempts: Number.isFinite(Number(body.maxAttempts)) ? Math.min(10, Math.max(1, Math.trunc(Number(body.maxAttempts)))) : DEFAULT_MAX_ATTEMPTS,
    active: body.active !== false,
  };
}

const FLOW_STEP_ACTIONS = ["ASK_QUESTION", "USE_KNOWLEDGE", "QUERY_TOOL", "RESPOND", "RESOLVED", "HANDOFF_HUMAN", "GOTO_STEP"];
function validateStepActionFields(data) {
  if (data.action === "ASK_QUESTION" && !data.question) {
    throw Object.assign(new Error("Informe a pergunta da etapa."), { statusCode: 400 });
  }
  if (data.action === "QUERY_TOOL" && !data.toolName) {
    throw Object.assign(new Error("Selecione a Tool da etapa."), { statusCode: 400 });
  }
  if (data.action === "RESPOND" && !data.responseMessage) {
    throw Object.assign(new Error("Informe a mensagem da etapa."), { statusCode: 400 });
  }
  if (data.action === "GOTO_STEP" && !data.gotoStepId) {
    throw Object.assign(new Error("Selecione a etapa de destino."), { statusCode: 400 });
  }
}

async function assertKnowledgeSourceAccessible(intentId, knowledgeSourceId, client) {
  if (!knowledgeSourceId) return;
  const intent = await client.botIntent.findUnique({ where: { id: intentId }, select: { botId: true } });
  if (!intent) throw Object.assign(new Error("Intenção não encontrada."), { statusCode: 404 });
  const source = await client.knowledgeSource.findFirst({
    where: { id: knowledgeSourceId, ...knowledgeAccessWhere(intent.botId) },
    select: { id: true },
  });
  if (!source) {
    throw Object.assign(new Error("O conhecimento selecionado não está disponível para este Bot."), { statusCode: 400 });
  }
}

async function createFlowStep(intentId, body, client = prisma) {
  const data = flowStepInput(body);
  if (!data.name) throw Object.assign(new Error("Informe um nome para a etapa."), { statusCode: 400 });
  if (!FLOW_STEP_ACTIONS.includes(data.action)) throw Object.assign(new Error("Ação inválida."), { statusCode: 400 });
  validateStepActionFields(data);

  await assertKnowledgeSourceAccessible(intentId, data.knowledgeSourceId, client);

  for (const field of ["nextStepId", "onSuccessStepId", "onFailureStepId", "gotoStepId"]) {
    if (data[field] && !(await assertStepBelongsToIntent(intentId, data[field], client))) {
      throw Object.assign(new Error("A etapa de destino não pertence a esta intenção."), { statusCode: 400 });
    }
  }

  const existing = await listFlowSteps(intentId, client);
  return client.botFlowStep.create({
    data: { ...data, intentId, order: nextOrderFor(existing) },
    select: flowStepSelect,
  });
}

async function updateFlowStep(stepId, body, client = prisma) {
  const current = await client.botFlowStep.findUnique({ where: { id: stepId } });
  if (!current) throw Object.assign(new Error("Etapa não encontrada."), { statusCode: 404 });

  const data = flowStepInput({ ...current, ...body });
  if (!data.name) throw Object.assign(new Error("Informe um nome para a etapa."), { statusCode: 400 });
  if (!FLOW_STEP_ACTIONS.includes(data.action)) throw Object.assign(new Error("Ação inválida."), { statusCode: 400 });
  validateStepActionFields(data);

  await assertKnowledgeSourceAccessible(current.intentId, data.knowledgeSourceId, client);

  for (const field of ["nextStepId", "onSuccessStepId", "onFailureStepId", "gotoStepId"]) {
    if (data[field] === stepId) throw Object.assign(new Error("Uma etapa não pode apontar para ela mesma."), { statusCode: 400 });
    if (data[field] && !(await assertStepBelongsToIntent(current.intentId, data[field], client))) {
      throw Object.assign(new Error("A etapa de destino não pertence a esta intenção."), { statusCode: 400 });
    }
  }

  return client.botFlowStep.update({ where: { id: stepId }, data, select: flowStepSelect });
}

async function deleteFlowStep(stepId, client = prisma) {
  const current = await client.botFlowStep.findUnique({ where: { id: stepId }, select: { id: true } });
  if (!current) throw Object.assign(new Error("Etapa não encontrada."), { statusCode: 404 });
  await client.botFlowStep.delete({ where: { id: stepId } });
  return { deleted: true };
}

// Reordena TODAS as etapas ativas/inativas da intenção conforme a lista de
// ids recebida (drag-and-drop na UI) — ids fora da lista mantêm a ordem
// relativa ao final.
async function reorderFlowSteps(intentId, orderedStepIds, client = prisma) {
  if (!Array.isArray(orderedStepIds) || !orderedStepIds.length) {
    throw Object.assign(new Error("Informe a ordem das etapas."), { statusCode: 400 });
  }
  const steps = await listFlowSteps(intentId, client);
  const known = new Set(steps.map((step) => step.id));
  if (new Set(orderedStepIds).size !== orderedStepIds.length || orderedStepIds.some((id) => !known.has(id))) {
    throw Object.assign(new Error("A ordem contém etapas duplicadas ou que não pertencem à intenção."), { statusCode: 400 });
  }
  const finalOrder = [
    ...orderedStepIds.filter((id) => known.has(id)),
    ...steps.map((step) => step.id).filter((id) => !orderedStepIds.includes(id)),
  ];
  // Duas passagens: `order` tem @@unique([intentId, order]) — atribuir os
  // valores finais direto colidiria em cima dos valores atuais (ex.: mover o
  // 1º item para a posição 3 enquanto outro item ainda está com order=3).
  // Passa por um intervalo negativo temporário primeiro para nunca colidir.
  await client.$transaction([
    ...finalOrder.map((id, index) => client.botFlowStep.update({ where: { id }, data: { order: -(index + 1) } })),
    ...finalOrder.map((id, index) => client.botFlowStep.update({ where: { id }, data: { order: index + 1 } })),
  ]);
  return listFlowSteps(intentId, client);
}

// ---------------------------------------------------------------------------
// Interpretação de resposta curta no contexto da etapa atual (itens 5/6)
// ---------------------------------------------------------------------------

// Reconhece frases de resolução (item 6) — mesma fonte de padrões usada em
// todo o restante do motor de Bots (bot-constants.js), nunca duplicada aqui.
function detectFlowOutcome(message) {
  const normalized = normalizeText(message);
  if (!normalized) return null;
  // Negativo primeiro de propósito: frases como "não funcionou" contêm a
  // palavra "funcionou" (padrão positivo) dentro de uma negação — checar o
  // negativo antes evita interpretar isso como resolvido.
  if (RESOLUTION_NEGATIVE_PATTERNS.some((pattern) => pattern.test(normalized))) return "NOT_RESOLVED";
  if (RESOLUTION_POSITIVE_PATTERNS.some((pattern) => pattern.test(normalized))) return "RESOLVED";
  return null;
}

// Mais tolerante que CONFIRMATION_PATTERN/NEGATION_PATTERN (que só casam a
// mensagem inteira): uma etapa de confirmação do fluxo ("aparece no
// Bluetooth?") recebe respostas como "não, não aparece" — o padrão exato
// de mensagem curta continua checado primeiro (reaproveitado), com um
// fallback léxico simples (primeira palavra) só para este contexto.
function detectYesNo(message) {
  const normalized = normalizeText(message);
  if (!normalized) return null;
  if (CONFIRMATION_PATTERN.test(normalized)) return "YES";
  if (NEGATION_PATTERN.test(normalized)) return "NO";
  if (/^sim\b/.test(normalized)) return "YES";
  if (/^(nao|n)\b/.test(normalized)) return "NO";
  return null;
}

// ---------------------------------------------------------------------------
// Motor de execução
// ---------------------------------------------------------------------------

// `seedEntities` (item 6 — contexto de produto): entidades já conhecidas da
// CONVERSA inteira (ConversationBotState.contextEntities), não desta etapa —
// pré-preenche collectedEntities para que um ASK_QUESTION cujo entityKey já
// está presente seja pulado automaticamente pelo `if
// (step.entityKey && flowState.collectedEntities[step.entityKey])` já
// existente em runChain, sem precisar duplicar essa checagem aqui.
function emptyFlowState(intentId, seedEntities = null) {
  return {
    intentId,
    collectedEntities: { ...(seedEntities || {}) },
    askedQuestions: [],
    attemptedSolutions: [],
    failedSteps: [],
    stepAttempts: {},
  };
}

function cloneFlowState(state, intentId) {
  if (!state || state.activeFlowIntentId !== intentId) return emptyFlowState(intentId);
  return {
    intentId,
    collectedEntities: { ...(state.flowCollectedEntities || {}) },
    askedQuestions: [...(state.flowAskedQuestions || [])],
    attemptedSolutions: [...(state.flowAttemptedSolutions || [])],
    failedSteps: [...(state.flowFailedSteps || [])],
    stepAttempts: { ...(state.flowStepAttempts || {}) },
  };
}

// Item 1 (estado da conversa): `pendingQuestion` guarda o texto exato da
// pergunta em aberto (nulo quando o fluxo não está esperando resposta) —
// evita uma consulta extra só para exibir/auditar a pergunta pendente.
function toFlowPersist(flowState, currentStepId, resolutionStatus, pendingQuestion = null) {
  return {
    intentId: flowState.intentId,
    currentStepId: currentStepId || null,
    collectedEntities: flowState.collectedEntities,
    askedQuestions: flowState.askedQuestions,
    attemptedSolutions: flowState.attemptedSolutions,
    failedSteps: flowState.failedSteps,
    stepAttempts: flowState.stepAttempts,
    resolutionStatus,
    pendingQuestion,
  };
}

function recordAttempt(flowState, step, outcome, meta = {}) {
  flowState.attemptedSolutions.push({
    stepId: step.id, name: step.name, action: step.action, outcome, at: new Date().toISOString(), ...meta,
  });
  if (outcome === "FAILURE" && !flowState.failedSteps.includes(step.id)) flowState.failedSteps.push(step.id);
}

// Etapa que aguarda resposta do cliente: entidade livre (entityKey) ou
// confirmação sim/não (sem entityKey — ex.: "funcionou?"). Nunca conta como
// falha "silenciosa": esgotar as tentativas sempre encaminha para humano
// (item 9), nunca fica repetindo a pergunta para sempre.
function evaluateAskQuestionAnswer(step, message, flowState) {
  const attempts = (flowState.stepAttempts[step.id] || 0) + 1;
  flowState.stepAttempts[step.id] = attempts;
  const trimmed = String(message || "").trim();
  const maxAttempts = step.maxAttempts || DEFAULT_MAX_ATTEMPTS;

  if (step.entityKey) {
    if (trimmed) {
      flowState.collectedEntities[step.entityKey] = trimmed;
      return "SUCCESS";
    }
    if (!step.required) return "SUCCESS";
    return attempts >= maxAttempts ? "MAX_ATTEMPTS" : "RETRY";
  }

  const outcome = detectFlowOutcome(trimmed) === "RESOLVED" || detectYesNo(trimmed) === "YES" ? "SUCCESS"
    : detectFlowOutcome(trimmed) === "NOT_RESOLVED" || detectYesNo(trimmed) === "NO" ? "FAILURE"
      : null;
  if (outcome) return outcome;
  return attempts >= maxAttempts ? "MAX_ATTEMPTS" : "RETRY";
}

// Retorna { text, knowledgeSourceId, knowledgeSourceTitle, knowledgeSourceVersion, conflict }
// nunca uma string solta — item 7 (auditoria: qual conhecimento foi usado) e
// item 6 (conflito nunca é resolvido escolhendo "no escuro").
async function resolveStepKnowledgeText({ step, bot, intent, flowState, client }) {
  if (step.knowledgeSourceId) {
    const row = await client.knowledgeSource.findFirst({
      where: { id: step.knowledgeSourceId, active: true, ...knowledgeAccessWhere(bot.id) },
    });
    if (row && isActiveNow(row)) {
      return { text: row.content || null, knowledgeSourceId: row.id, knowledgeSourceTitle: row.title, knowledgeSourceVersion: row.version };
    }
    return { text: null };
  }
  try {
    // Sem trecho de busca natural aqui (a etapa decide sozinha buscar
    // conhecimento, não é uma resposta livre do cliente) — string vazia usa
    // o score padrão do provider e deixa o filtro por intentId/produto (mais
    // preciso neste contexto) decidir a relevância, em vez de comparar
    // contra a última resposta curta do cliente ("sim"/"não"/etc.).
    const results = await defaultKnowledgeProvider.search("", {
      botId: bot.id, intentId: intent.id, globalIntentId: intent.globalIntentId || null,
      product: flowState?.collectedEntities?.productName || flowState?.collectedEntities?.product || null,
    });
    if (results.conflict) return { text: null, conflict: true };
    const best = results[0];
    if (!best) return { text: null };
    return { text: best.content || null, knowledgeSourceId: best.id, knowledgeSourceTitle: best.title, knowledgeSourceVersion: best.version };
  } catch (error) {
    // Nunca derruba o fluxo por falha na busca — degrada para "sem conteúdo".
    console.error("[BOT_FLOW] falha ao buscar conhecimento da etapa (ignorada)", error.message);
    return { text: null };
  }
}

// Reaproveita INTEGRALMENTE a validação/execução de Tools já existente
// (bot-tool-orchestrator-service.js): desativada, sem permissão, entidade
// obrigatória faltando etc. continuam bloqueando exatamente como no modo
// single-shot — o Flow Engine não reimplementa essa checagem.
async function resolveStepTool({ step, bot, flowState, channel, mode }) {
  const decision = await resolveToolDecision({
    bot,
    decision: { action: "QUERY_TOOL", toolName: step.toolName, entities: flowState.collectedEntities, summary: "" },
    channel,
    mode,
  });
  if (decision.toolResponseText) return { text: decision.toolResponseText, success: true };
  return { text: null, success: false, reason: decision.toolUnavailableReason || decision.clarificationQuestion || "TOOL_UNAVAILABLE" };
}

function resolveNextStepId(step, outcome) {
  if (outcome === "SUCCESS") return step.onSuccessStepId || step.nextStepId || null;
  if (outcome === "FAILURE") return step.onFailureStepId || step.nextStepId || null;
  return step.nextStepId || null;
}

// Percorre etapas automáticas (USE_KNOWLEDGE/QUERY_TOOL/RESPOND/GOTO_STEP)
// encadeadas até: precisar esperar uma resposta (ASK_QUESTION), terminar
// (RESOLVED/HANDOFF_HUMAN) ou esgotar o limite de segurança do encadeamento.
async function runChain({ bot, intent, stepMap, startStepId, flowState, channel, mode, client, message }) {
  const responses = [];
  let stepId = startStepId;
  let iterations = 0;

  while (stepId && iterations < MAX_CHAIN_STEPS) {
    iterations += 1;
    const step = stepMap.get(stepId);
    if (!step || !step.active) {
      // Etapa-alvo ausente/desativada: nunca trava o cliente sem resposta —
      // encaminha para humano (item 9).
      return {
        responseText: [...responses, "Vou te encaminhar para um de nossos atendentes para continuar."].join("\n\n"),
        terminal: "HANDOFF",
        summary: "Etapa de destino do fluxo não está mais disponível; encaminhado para humano.",
        flow: toFlowPersist(flowState, null, "HANDED_OFF"),
      };
    }

    if (step.action === "ASK_QUESTION") {
      // Item 1: não repetir pergunta cuja resposta já foi coletada.
      if (step.entityKey && flowState.collectedEntities[step.entityKey]) {
        stepId = resolveNextStepId(step, "SUCCESS");
        continue;
      }
      if (!flowState.askedQuestions.includes(step.id)) flowState.askedQuestions.push(step.id);
      responses.push(step.question || step.name);
      return {
        responseText: responses.join("\n\n"),
        terminal: null,
        summary: `Aguardando resposta da etapa "${step.name}".`,
        flow: toFlowPersist(flowState, step.id, "IN_PROGRESS", step.question || step.name),
      };
    }

    if (step.action === "USE_KNOWLEDGE") {
      const knowledge = await resolveStepKnowledgeText({ step, bot, intent, flowState, client });
      recordAttempt(flowState, step, knowledge.text ? "SUCCESS" : "FAILURE", {
        knowledgeSourceId: knowledge.knowledgeSourceId || null,
        knowledgeSourceTitle: knowledge.knowledgeSourceTitle || null,
        knowledgeSourceVersion: knowledge.knowledgeSourceVersion || null,
        knowledgeConflict: Boolean(knowledge.conflict),
      });
      if (knowledge.text) responses.push(knowledge.text);
      stepId = resolveNextStepId(step, knowledge.text ? "SUCCESS" : "FAILURE");
      continue;
    }

    if (step.action === "QUERY_TOOL") {
      const result = await resolveStepTool({ step, bot, flowState, channel, mode });
      recordAttempt(flowState, step, result.success ? "SUCCESS" : "FAILURE");
      if (result.success) responses.push(result.text);
      stepId = resolveNextStepId(step, result.success ? "SUCCESS" : "FAILURE");
      continue;
    }

    if (step.action === "RESPOND") {
      if (step.responseMessage) responses.push(step.responseMessage);
      recordAttempt(flowState, step, "SUCCESS");
      stepId = resolveNextStepId(step, "SUCCESS");
      continue;
    }

    if (step.action === "GOTO_STEP") {
      stepId = step.gotoStepId;
      continue;
    }

    if (step.action === "RESOLVED") {
      if (step.responseMessage) responses.push(step.responseMessage);
      return {
        responseText: responses.join("\n\n") || "Que bom que conseguimos resolver! Qualquer coisa, é só chamar.",
        terminal: "RESOLVED",
        summary: `Fluxo da intenção "${intent.name}" concluído como resolvido.`,
        flow: toFlowPersist(flowState, null, "RESOLVED"),
      };
    }

    if (step.action === "HANDOFF_HUMAN") {
      responses.push(step.responseMessage || "Vou te encaminhar para um de nossos atendentes, só um instante.");
      return {
        responseText: responses.join("\n\n"),
        terminal: "HANDOFF",
        summary: `Fluxo da intenção "${intent.name}" encaminhado para atendimento humano.`,
        flow: { ...toFlowPersist(flowState, null, "HANDED_OFF"), terminalStepName: step.name },
      };
    }

    // Ação desconhecida (defensivo): nunca trava — encaminha para humano.
    stepId = null;
  }

  // Encadeamento esgotado (loop de GOTO_STEP mal configurado) ou fim da
  // cadeia sem terminal explícito: nunca deixa o cliente sem resposta nem
  // fica girando — encaminha para humano.
  return {
    responseText: [...responses, "Vou te encaminhar para um de nossos atendentes para continuar."].join("\n\n"),
    terminal: "HANDOFF",
    summary: iterations >= MAX_CHAIN_STEPS
      ? "Limite de segurança de etapas encadeadas atingido; encaminhado para humano."
      : `Fluxo da intenção "${intent.name}" chegou ao fim sem uma conclusão explícita; encaminhado para humano.`,
    flow: toFlowPersist(flowState, null, "HANDED_OFF"),
  };
}

// Inicia o fluxo de uma intenção pela primeira vez nesta conversa (chamado
// quando decide() resolveu RESPOND/QUERY_TOOL para uma intenção que tem
// etapas ativas configuradas).
async function startFlow({ bot, intent, channel, mode, client = prisma, seedEntities = null }) {
  const steps = await getActiveOrderedSteps(intent.id, client);
  if (!steps.length) return null;
  const stepMap = new Map(steps.map((step) => [step.id, step]));
  const flowState = emptyFlowState(intent.id, seedEntities);
  return runChain({ bot, intent, stepMap, startStepId: steps[0].id, flowState, channel, mode, client, message: null });
}

// ---------------------------------------------------------------------------
// Pilha de fluxos pausados por troca de assunto (itens 4/5)
// ---------------------------------------------------------------------------
const MAX_FLOW_STACK_DEPTH = 3;

// Congela o fluxo ATUAL (o que está em `state`) como um item de pilha, para
// retomar depois que a nova intenção (a que causou a troca de assunto) for
// concluída. Só faz sentido chamar quando `state` já tem um fluxo em
// andamento (currentFlowStepId preenchido) — o chamador garante isso.
function snapshotFlowFromState(state) {
  return {
    intentId: state.activeFlowIntentId,
    currentStepId: state.currentFlowStepId,
    collectedEntities: state.flowCollectedEntities || {},
    askedQuestions: state.flowAskedQuestions || [],
    attemptedSolutions: state.flowAttemptedSolutions || [],
    failedSteps: state.flowFailedSteps || [],
    stepAttempts: state.flowStepAttempts || {},
    resolutionStatus: state.flowResolutionStatus || "IN_PROGRESS",
    pendingQuestion: state.pendingQuestion || null,
  };
}

// Empilha o snapshot atual (se houver um fluxo em andamento) — nunca cresce
// sem limite: o item mais antigo é descartado ao ultrapassar
// MAX_FLOW_STACK_DEPTH (proteção contra encadear trocas de assunto para sempre).
function pushFlowStack(existingStack, state) {
  if (!state?.currentFlowStepId || !state?.activeFlowIntentId) return existingStack || [];
  const stack = [...(existingStack || []), snapshotFlowFromState(state)];
  return stack.slice(-MAX_FLOW_STACK_DEPTH);
}

// Retorna { snapshot, remainingStack } com o topo da pilha removido, ou
// { snapshot: null, remainingStack: existingStack } se vazia.
function popFlowStack(existingStack) {
  const stack = existingStack || [];
  if (!stack.length) return { snapshot: null, remainingStack: [] };
  const snapshot = stack[stack.length - 1];
  return { snapshot, remainingStack: stack.slice(0, -1) };
}

// Converte um snapshot de volta no formato persistido em ConversationBotState
// (mesmo formato de toFlowPersist) — usado para RETOMAR o fluxo anterior
// depois que a intenção que causou a troca de assunto termina.
function flowPersistFromSnapshot(snapshot) {
  return {
    intentId: snapshot.intentId,
    currentStepId: snapshot.currentStepId,
    collectedEntities: snapshot.collectedEntities,
    askedQuestions: snapshot.askedQuestions,
    attemptedSolutions: snapshot.attemptedSolutions,
    failedSteps: snapshot.failedSteps,
    stepAttempts: snapshot.stepAttempts,
    resolutionStatus: snapshot.resolutionStatus,
    pendingQuestion: snapshot.pendingQuestion,
  };
}

// Item 4 (troca de assunto): antes de tratar `message` como resposta à etapa
// atual, verifica se ela na verdade corresponde a uma intenção DIFERENTE com
// confiança alta — reaproveita o mesmo classificador local usado em todo o
// resto do motor (nunca chama IA externa aqui: é só uma checagem rápida,
// pré-etapa, sem custo de rede). Confiança abaixo do limiar do Bot nunca
// dispara a troca (evita interpretar uma resposta livre ambígua como se
// fosse outra intenção).
async function detectTopicSwitch({ bot, message, currentIntentId, context = [] }) {
  const local = getFallbackProvider();
  const result = await interpretWithProviders({ bot, message, context, primary: local, fallback: local });
  if (!result.intentId || result.intentId === currentIntentId) return { switched: false };
  const intent = (bot.intents || []).find((item) => item.id === result.intentId);
  if (!intent) return { switched: false };
  const threshold = typeof bot.highConfidenceThreshold === "number" ? bot.highConfidenceThreshold : DEFAULT_HIGH_CONFIDENCE_THRESHOLD;
  if (result.confidence < threshold) return { switched: false };
  return { switched: true, intent, interpretation: result };
}

// Continua um fluxo já em andamento: interpreta `message` como resposta à
// etapa atual (`state.currentFlowStepId`) e avança.
async function continueFlow({ bot, intent, message, state, channel, mode, client = prisma, context = [] }) {
  const steps = await getActiveOrderedSteps(intent.id, client);
  const stepMap = new Map(steps.map((step) => [step.id, step]));
  const currentStep = stepMap.get(state.currentFlowStepId);
  const flowState = cloneFlowState(state, intent.id);

  if (!currentStep || !currentStep.active) {
    return {
      responseText: "Vou te encaminhar para um de nossos atendentes para continuar.",
      terminal: "HANDOFF",
      summary: "A etapa atual do fluxo não está mais disponível.",
      flow: toFlowPersist(flowState, null, "HANDED_OFF"),
    };
  }

  if (currentStep.action !== "ASK_QUESTION") {
    // Só etapas ASK_QUESTION pausam esperando o cliente — qualquer outra
    // situação aqui é defensiva (estado inconsistente), nunca trava.
    return runChain({
      bot, intent, stepMap, startStepId: currentStep.id, flowState, channel, mode, client, message,
    });
  }

  // "sim"/"não"/frases de resolução nunca disparam troca de assunto — são o
  // caminho normal e mais comum de resposta a uma etapa de confirmação.
  if (!detectYesNo(message) && !detectFlowOutcome(message)) {
    const switchResult = await detectTopicSwitch({ bot, message, currentIntentId: intent.id, context });
    if (switchResult.switched) {
      return {
        topicSwitch: switchResult, terminal: null, flow: null, responseText: null,
        summary: `Troca de assunto detectada: nova intenção "${switchResult.intent.name}" durante o fluxo "${intent.name}".`,
      };
    }
  }

  const outcome = evaluateAskQuestionAnswer(currentStep, message, flowState);

  if (outcome === "RETRY") {
    return {
      responseText: currentStep.question || currentStep.name,
      terminal: null,
      summary: `Resposta não compreendida na etapa "${currentStep.name}"; repetindo a pergunta.`,
      flow: toFlowPersist(flowState, currentStep.id, "IN_PROGRESS", currentStep.question || currentStep.name),
    };
  }

  if (outcome === "MAX_ATTEMPTS") {
    recordAttempt(flowState, currentStep, "FAILURE");
    return {
      responseText: "Vou te encaminhar para um de nossos atendentes para continuar te ajudando.",
      terminal: "HANDOFF",
      summary: `Número máximo de tentativas atingido na etapa "${currentStep.name}"; encaminhado para humano.`,
      flow: toFlowPersist(flowState, null, "HANDED_OFF"),
    };
  }

  recordAttempt(flowState, currentStep, outcome);
  const nextStepId = resolveNextStepId(currentStep, outcome);
  return runChain({ bot, intent, stepMap, startStepId: nextStepId, flowState, channel, mode, client, message });
}

// Item 2 (expiração de contexto): estado "vazio" para limpar os campos flow*
// de uma conversa cuja sessão expirou — nunca reaproveitar uma etapa/
// intenção antiga como se fosse a atual (bot-orchestrator-service.js chama
// isto quando a sessão expira e nenhum fluxo novo começou neste turno).
function resetFlowPersist() {
  return toFlowPersist(emptyFlowState(null), null, null, null);
}

module.exports = {
  FLOW_STEP_ACTIONS,
  resetFlowPersist,
  listFlowSteps,
  getActiveOrderedSteps,
  hasActiveFlow,
  createFlowStep,
  updateFlowStep,
  deleteFlowStep,
  reorderFlowSteps,
  detectFlowOutcome,
  detectYesNo,
  detectTopicSwitch,
  startFlow,
  continueFlow,
  MAX_FLOW_STACK_DEPTH,
  pushFlowStack,
  popFlowStack,
  flowPersistFromSnapshot,
};
