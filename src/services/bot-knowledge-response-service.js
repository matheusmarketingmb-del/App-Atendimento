// Item 4: separa claramente INTERPRETAR (bot-interpreter-service.js) / criar
// escolher a ação (bot-decision-service.js) / BUSCAR CONHECIMENTO (aqui) /
// RESPONDER (bot-response-service.js) como passos distintos, nunca
// misturados numa função só. Roda depois de decide() e antes de respond():
// se a decisão já é RESPOND para uma intenção reconhecida, tenta enriquecer
// com uma resposta vinda da Base de Conhecimento (KnowledgeSource). Se nada
// confiável for encontrado, NUNCA inventa — a decisão volta inalterada e
// bot-response-service.js cai na resposta configurada da intenção/fallback
// normalmente (item 10: nunca fabricar).
const { KnowledgeSourceProvider } = require("./bot-knowledge/knowledge-provider");

const defaultProvider = new KnowledgeSourceProvider();

function findIntent(bot, intentId) {
  return (bot.intents || []).find((intent) => intent.id === intentId) || null;
}

// A base de conhecimento é CONTEXTO INTERNO, nunca a resposta pronta —
// `best.content` pode ter sido colado no painel com formatação Markdown
// (títulos, listas, negrito, links, bloco de código), que nunca pode vazar
// cru para o cliente no WhatsApp. Remove só a MARCAÇÃO, sem cortar
// conteúdo; roda sempre, independente de a Personalidade (IA externa) estar
// configurada ou não (ver bot-personality-service.js#applyPersonality, que
// é opcional e não pode ser a única barreira contra Markdown bruto).
function stripMarkdown(text) {
  return String(text || "")
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```/g, "").trim())
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}[-*+]\s+/gm, "")
    .replace(/^\s{0,3}\d+\.\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|[^*])\*([^*]+)\*([^*]|$)/g, "$1$2$3")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function resolveKnowledgeResponse({
  bot, decision, interpretation, message, flags = {}, provider = defaultProvider, contextProduct = null,
}) {
  if (decision.action !== "RESPOND") return decision;
  if (flags.knowledgeBaseEnabled !== true) return decision;
  if (!interpretation.intentId) return decision;

  const intent = findIntent(bot, interpretation.intentId);
  // Uma intenção com resposta já configurada continua tendo prioridade —
  // Base de Conhecimento só complementa intenções sem resposta fixa, para
  // não sobrescrever conteúdo que um humano já revisou e aprovou.
  if (intent?.responseMessage) return decision;

  let results = [];
  try {
    results = await provider.search(message, {
      botId: bot.id, intentId: interpretation.intentId, globalIntentId: intent?.globalIntentId || null,
      // Item 5/6: prioriza o produto/modelo já coletado na conversa —
      // primeiro o que a própria mensagem trouxe agora (entidade
      // "productName"), depois o que já estava guardado no contexto da
      // conversa inteira (ConversationBotState.contextEntities, item 6) —
      // "tenho um GS Pro 2" numa mensagem anterior e "ele tem NFC?" agora
      // ainda deve priorizar conteúdo do GS Pro 2, sem perguntar de novo.
      product: interpretation.entities?.productName || contextProduct || null,
    });
  } catch (error) {
    // Busca de conhecimento nunca pode derrubar a resposta — degrada para
    // "nada encontrado" e segue o fluxo normal.
    console.error("[BOT_KNOWLEDGE] falha na busca (ignorada)", error.message);
    return decision;
  }
  if (!results.length) return decision;

  // Item 6 (conflito): nunca escolher "no escuro" entre duas fontes válidas
  // e igualmente específicas — a decisão volta inalterada (resposta segura
  // configurada da intenção/fallback), sinalizando o conflito para auditoria.
  if (results.conflict) {
    return { ...decision, knowledgeConflict: true };
  }

  const best = results[0];
  return {
    ...decision,
    knowledgeResponseText: stripMarkdown(best.content) || null,
    knowledgeSourceId: best.id,
    knowledgeSourceTitle: best.title,
    knowledgeSourceVersion: best.version,
  };
}

module.exports = { resolveKnowledgeResponse };
