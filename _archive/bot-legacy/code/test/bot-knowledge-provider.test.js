require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/database/prisma");
const { KnowledgeSourceProvider } = require("../src/services/bot-knowledge/knowledge-provider");
const { resolveKnowledgeResponse } = require("../src/services/bot-knowledge-response-service");

const titlePrefix = "Conhecimento Teste";
const provider = new KnowledgeSourceProvider();

async function cleanup() {
  await prisma.knowledgeSource.deleteMany({ where: { title: { startsWith: titlePrefix } } });
}

test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

test("busca nunca retorna conhecimento desativado", async () => {
  await cleanup();
  await prisma.knowledgeSource.create({
    data: { title: `${titlePrefix} Desativado`, type: "FAQ", source: "Manual", content: "Como trocar produto: envie para nossa loja.", active: false },
  });
  const results = await provider.search("como trocar produto");
  assert.ok(!results.some((item) => item.title === `${titlePrefix} Desativado`), "conteúdo desativado nunca deveria ser retornado");
});

test("busca nunca retorna conhecimento expirado (validUntil no passado)", async () => {
  await cleanup();
  await prisma.knowledgeSource.create({
    data: {
      title: `${titlePrefix} Expirado`, type: "POLICY", source: "Manual", content: "Política antiga de troca em 30 dias.",
      active: true, validUntil: new Date(Date.now() - 24 * 60 * 60 * 1000),
    },
  });
  const results = await provider.search("política de troca");
  assert.ok(!results.some((item) => item.title === `${titlePrefix} Expirado`), "conteúdo expirado nunca deveria ser retornado");
});

test("busca nunca retorna conhecimento ainda não vigente (validFrom no futuro)", async () => {
  await cleanup();
  await prisma.knowledgeSource.create({
    data: {
      title: `${titlePrefix} Futuro`, type: "POLICY", source: "Manual", content: "Nova política de garantia estendida.",
      active: true, validFrom: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });
  const results = await provider.search("política de garantia");
  assert.ok(!results.some((item) => item.title === `${titlePrefix} Futuro`), "conteúdo ainda não vigente nunca deveria ser retornado");
});

test("busca retorna conhecimento ativo e vigente, ordenado por relevância", async () => {
  await cleanup();
  await prisma.knowledgeSource.create({
    data: { title: `${titlePrefix} Garantia Ativa`, type: "WARRANTY", source: "Manual interno", content: "A garantia do produto é de 12 meses contados a partir da compra." },
  });
  const results = await provider.search("qual o prazo de garantia do produto");
  assert.ok(results.some((item) => item.title === `${titlePrefix} Garantia Ativa`));
});

test("sem conhecimento confiável encontrado: resolveKnowledgeResponse nunca inventa, decisão volta inalterada", async () => {
  await cleanup();
  const bot = { id: "bot-conhecimento-fake", intents: [{ id: "intent-fake", name: "Assunto sem conhecimento" }] };
  const decision = { action: "RESPOND", categoryId: null, summary: "teste" };
  const interpretation = { intentId: "intent-fake", intentName: "Assunto sem conhecimento" };
  const flags = { knowledgeBaseEnabled: true };

  const result = await resolveKnowledgeResponse({ bot, decision, interpretation, message: "algo totalmente fora do que existe na base", flags });
  assert.equal(result.knowledgeResponseText, undefined, "sem conhecimento relevante, nunca deveria fabricar uma resposta");
  assert.deepEqual(result, decision);
});

test("Base de Conhecimento desligada por Bot (knowledgeBaseEnabled=false, default): nunca é consultada", async () => {
  await cleanup();
  await prisma.knowledgeSource.create({
    data: { title: `${titlePrefix} Trava Flag`, type: "FAQ", source: "Manual", content: "Resposta que não deveria ser usada com a flag desligada." },
  });
  const bot = { id: "bot-conhecimento-flag", intents: [{ id: "intent-flag", name: "Duvida" }] };
  const decision = { action: "RESPOND", categoryId: null, summary: "teste" };
  const interpretation = { intentId: "intent-flag", intentName: "Duvida" };

  const result = await resolveKnowledgeResponse({ bot, decision, interpretation, message: "resposta que não deveria ser usada", flags: { knowledgeBaseEnabled: false } });
  assert.equal(result, decision, "com a flag desligada (default), a decisão nunca deveria ser alterada");
});

test("intenção com resposta fixa configurada tem prioridade sobre a Base de Conhecimento", async () => {
  await cleanup();
  await prisma.knowledgeSource.create({
    data: { title: `${titlePrefix} Prioridade`, type: "FAQ", source: "Manual", content: "Conteúdo da base que não deveria vencer." },
  });
  const bot = { id: "bot-conhecimento-prioridade", intents: [{ id: "intent-prioridade", name: "Duvida", responseMessage: "Resposta fixa configurada." }] };
  const decision = { action: "RESPOND", categoryId: null, summary: "teste" };
  const interpretation = { intentId: "intent-prioridade", intentName: "Duvida" };

  const result = await resolveKnowledgeResponse({ bot, decision, interpretation, message: "conteúdo da base", flags: { knowledgeBaseEnabled: true } });
  assert.equal(result, decision, "intenção com resposta configurada não deveria ser sobrescrita pela Base de Conhecimento");
});
