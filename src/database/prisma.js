const { PrismaClient } = require("@prisma/client");

const base = new PrismaClient();

// Setor privado (Financeiro): Message e ConversationActivity nascem com o
// carimbo privateCategoryId do setor em que a conversa está — aplicado aqui,
// num ponto só, para que nenhum caminho de criação (webhook, envio, Bot,
// canais novos, templates…) escape. Quem já informa privateCategoryId
// (inclusive null) decide sozinho — ex.: atividades de transferência em
// inbox-service.updateConversation, que conhecem o setor de destino.
// A consulta usa o client base (fora da transação em curso): conversa criada
// na mesma transação ainda não existe lá e, corretamente, não é privada.
async function stamp(data, cache) {
  if (!data || data.privateCategoryId !== undefined || data.privateCategory !== undefined) return data;
  const conversationId = data.conversationId || data.conversation?.connect?.id;
  if (!conversationId) return data;
  if (!cache.has(conversationId)) {
    cache.set(conversationId, require("../services/private-segment-service").stampForConversation(conversationId, base));
  }
  const privateCategoryId = await cache.get(conversationId);
  if (!privateCategoryId) return data;
  return data.conversation ? { ...data, privateCategory: { connect: { id: privateCategoryId } } } : { ...data, privateCategoryId };
}

function stampingHooks() {
  return {
    async create({ args, query }) {
      return query({ ...args, data: await stamp(args.data, new Map()) });
    },
    async createMany({ args, query }) {
      const cache = new Map();
      const rows = Array.isArray(args.data) ? args.data : [args.data];
      const data = await Promise.all(rows.map((row) => stamp(row, cache)));
      return query({ ...args, data: Array.isArray(args.data) ? data : data[0] });
    },
  };
}

module.exports = base.$extends({
  query: { message: stampingHooks(), conversationActivity: stampingHooks() },
});
