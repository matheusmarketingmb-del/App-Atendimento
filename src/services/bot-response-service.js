// Camada de RESPOSTA: monta o texto que seria enviado, a partir de uma
// decisão já tomada. Função pura — nunca envia nada, nunca acessa o banco.
// Uma intenção com resposta configurada continua tendo prioridade; a IA só
// ajuda na interpretação (bot-interpreter-service.js), não na redação livre.
const genericClarificationQuestions = [
  "Não tenho certeza se entendi. Você pode explicar com mais detalhes o que precisa?",
  "Para te ajudar melhor, você pode me dizer, em poucas palavras, qual é o assunto? Por exemplo: pedido, garantia ou dúvida sobre produto.",
];
const negationClarificationQuestion = "Sem problemas! Pode me contar, com suas palavras, o que você precisa?";

const handoffMessage = "Vou te encaminhar para um de nossos atendentes, só um instante.";

// Respostas curtas para comportamento puramente social (sem intenção de
// negócio junto). GREETING usa decision.greetingReply, que já ecoa o
// cumprimento do cliente ("Boa tarde!"), por isso não aparece aqui.
const socialReplies = {
  THANKS: "Por nada! Qualquer coisa, é só chamar.",
  GOODBYE: "Até mais! Se precisar de algo, é só chamar por aqui.",
  SMALL_TALK: "Sou o assistente virtual da Mibro, por aqui para ajudar com pedidos, produtos e suporte. Como posso ajudar?",
};

function findIntent(bot, intentId) {
  return (bot.intents || []).find((intent) => intent.id === intentId) || null;
}

// Prefixa a resposta de negócio com o cumprimento quando a mensagem
// combinava saudação + intenção (ex.: "boa tarde, meu pedido não chegou").
function withGreetingPrefix(decision, text) {
  if (!decision.greetingReply) return text;
  return `${decision.greetingReply} ${text}`;
}

// Núcleo interno: calcula o texto E de ONDE ele veio (`source`). O `source`
// existe só para bot-personality-service.js saber em quais casos é seguro
// reescrever o TOM da resposta (ver isPersonalityEligible abaixo) — nunca
// para mudar o texto calculado aqui, que continua sendo a única fonte de
// verdade do CONTEÚDO.
function computeResponse({ bot, decision, interpretation }) {
  if (decision.action === "NO_ACTION") return { text: null, source: "NO_ACTION" };
  if (decision.outsideHours) return { text: bot.outsideHoursMessage, source: "OUTSIDE_HOURS" };

  // Flow Engine (múltiplas etapas): quando presente, o texto já foi montado
  // pelo motor de fluxo (bot-flow-service.js) a partir só das etapas
  // configuradas (pergunta, conhecimento real, resultado real de Tool ou
  // mensagem de encerramento) — tem prioridade sobre tudo abaixo, igual a
  // toolResponseText/knowledgeResponseText nunca inventam nada por cima.
  if (decision.flowResponseText) {
    return { text: withGreetingPrefix(decision, decision.flowResponseText), source: "FLOW" };
  }

  // Correção de bug pré-existente (achado pelo teste de handoff da
  // Personalidade, não introduzido por ela): HANDOFF_HUMAN precisa vir ANTES
  // do bloco social — um pedido explícito de atendente humano também marca
  // decision.socialBehavior = "HUMAN_REQUEST" (bot-social-behavior-service.js),
  // e "HUMAN_REQUEST" não está em `socialReplies`. Com a ordem antiga, esse
  // caso caía silenciosamente no fallbackMessage do Bot em vez de encaminhar
  // — nunca havia teste cobrindo justamente essa combinação.
  if (decision.action === "HANDOFF_HUMAN") {
    return { text: withGreetingPrefix(decision, handoffMessage), source: "HANDOFF" };
  }

  if (!interpretation.intentId && decision.socialBehavior && decision.socialBehavior !== "NEGATION") {
    if (decision.socialBehavior === "GREETING") {
      return { text: `${decision.greetingReply} Como posso te ajudar?`, source: "SOCIAL" };
    }
    return { text: socialReplies[decision.socialBehavior] || bot.fallbackMessage, source: "SOCIAL" };
  }

  if (decision.action === "ASK_CLARIFICATION") {
    // Itens 5-8: pergunta específica montada pelo orquestrador de Tools
    // quando falta uma entidade obrigatória (ex.: "Pode me informar o
    // número do pedido?") tem prioridade sobre as genéricas.
    if (decision.clarificationQuestion) {
      return { text: withGreetingPrefix(decision, decision.clarificationQuestion), source: "CLARIFICATION" };
    }
    if (decision.socialBehavior === "NEGATION") return { text: negationClarificationQuestion, source: "CLARIFICATION" };
    const intentForClarification = findIntent(bot, interpretation.intentId);
    if (intentForClarification) {
      return {
        text: withGreetingPrefix(decision, `Você quis dizer "${intentForClarification.name}"? Pode confirmar ou me dar mais detalhes?`),
        source: "CLARIFICATION",
      };
    }
    const index = Math.min((decision.failureCount || 1) - 1, genericClarificationQuestions.length - 1);
    return { text: withGreetingPrefix(decision, genericClarificationQuestions[index]), source: "CLARIFICATION" };
  }

  // Itens 7/8/10: quando a decisão foi resolvida a partir de uma Tool
  // (bot-tool-orchestrator-service.js), o texto já foi montado só com dados
  // reais devolvidos pela Tool (nunca inventado aqui). Tem prioridade sobre
  // a resposta configurada da intenção.
  if (decision.toolResponseText) {
    return { text: withGreetingPrefix(decision, decision.toolResponseText), source: "TOOL" };
  }

  // Item 4: resposta vinda da Base de Conhecimento (bot-knowledge-response-
  // service.js), só quando a intenção não tinha resposta fixa configurada.
  if (decision.knowledgeResponseText) {
    return { text: withGreetingPrefix(decision, decision.knowledgeResponseText), source: "KNOWLEDGE" };
  }

  // RESPOND e SWITCH_BOT usam a mesma resposta configurada: a troca de Bot é
  // interna, o cliente não deve perceber que "outro robô" assumiu.
  const intent = findIntent(bot, interpretation.intentId);
  return {
    text: withGreetingPrefix(decision, intent?.responseMessage || bot.fallbackMessage),
    source: "INTENT_OR_FALLBACK",
  };
}

// Únicas origens em que a Personalidade (bot-personality-service.js) pode
// reescrever o TOM do texto: uma resposta fixa de conhecimento/intenção/
// fallback, nunca dado estruturado de Tool, nunca etapa de Flow Engine,
// nunca handoff/esclarecimento/social/fora do horário — essas são precisas
// por natureza (dado real, transição de fluxo, encaminhamento) e saem
// SEMPRE exatamente como decididas, palavra por palavra.
const PERSONALITY_ELIGIBLE_SOURCES = Object.freeze(["KNOWLEDGE", "INTENT_OR_FALLBACK"]);
function isPersonalityEligible(source) {
  return PERSONALITY_ELIGIBLE_SOURCES.includes(source);
}

function respond({ bot, decision, interpretation }) {
  return computeResponse({ bot, decision, interpretation }).text;
}

module.exports = { respond, computeResponse, isPersonalityEligible, PERSONALITY_ELIGIBLE_SOURCES };
