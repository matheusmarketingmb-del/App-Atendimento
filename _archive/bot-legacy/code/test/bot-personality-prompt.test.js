// Testes puros (sem banco) da camada de ESTILO da Personalidade:
// buildSystemPrompt/getEffectivePersonality/applyPersonality. `resolveProvider`
// é injetado (mesmo padrão de DI já usado em bot-knowledge-response-service.js
// e bot-interpreter-service.js) para nunca depender de rede/credencial real.
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  applyPersonality, buildSystemPrompt, getEffectivePersonality,
} = require("../src/services/bot-personality-service");
const { DEFAULT_PERSONALITY } = require("../src/services/bot-personality-constants");

function botFixture(overrides = {}) {
  return {
    id: "bot-1",
    fallbackMessage: "Não entendi.",
    featureFlags: {},
    personality: null,
    ...overrides,
  };
}

test("Bot sem personalidade própria usa o default da Mibro Brasil", () => {
  const effective = getEffectivePersonality(botFixture());
  assert.equal(effective, DEFAULT_PERSONALITY);
  assert.ok(effective.forbiddenBehaviors.includes("inventar informações"));
  assert.ok(effective.mandatoryBehaviors.includes("priorizar fontes oficiais"));
});

test("Bot com personalidade própria usa exatamente o que está salvo (nunca mescla com o default)", () => {
  const own = {
    assistantName: "Zeca", roleDescription: "Vendedor", tone: ["informal"],
    responseStyle: [], mandatoryBehaviors: [], forbiddenBehaviors: [],
    additionalInstructions: null, responseLength: "SHORT",
  };
  const effective = getEffectivePersonality(botFixture({ personality: own }));
  assert.equal(effective, own);
  assert.equal(effective.forbiddenBehaviors.length, 0);
});

test("buildSystemPrompt inclui identidade, tom, sempre/nunca e o rodapé de segurança fixo", () => {
  const prompt = buildSystemPrompt(DEFAULT_PERSONALITY);
  assert.match(prompt, /Assistente virtual da Mibro Brasil/);
  assert.match(prompt, /moderno, tecnológico, jovem, confiável/);
  assert.match(prompt, /Sempre: .*priorizar fontes oficiais/);
  assert.match(prompt, /Nunca: .*inventar informações/);
  assert.match(prompt, /Nunca: .*garantir funções não confirmadas/);
  // Regras que a personalidade NUNCA pode sobrescrever (rodapé fixo, nunca
  // vindo de dado do usuário).
  assert.match(prompt, /Base de Conhecimento/);
  assert.match(prompt, /Tool já executada/);
  assert.match(prompt, /Fluxo de atendimento já decidida/);
  assert.match(prompt, /Nunca invente dados, preços, prazos/);
});

test("buildSystemPrompt de um preset customizado reflete exatamente os comportamentos proibidos configurados", () => {
  const personality = {
    assistantName: "Suporte X", roleDescription: null, tone: [], responseStyle: [],
    mandatoryBehaviors: ["nunca deixar o cliente sem resposta"],
    forbiddenBehaviors: ["prometer prazo de entrega sem confirmar no sistema"],
    additionalInstructions: null, responseLength: "MEDIUM",
  };
  const prompt = buildSystemPrompt(personality);
  assert.match(prompt, /Nunca: prometer prazo de entrega sem confirmar no sistema\./);
});

test("applyPersonality nunca chama o provider quando externalAiFallbackEnabled está desligado (default)", async () => {
  let called = false;
  const result = await applyPersonality({
    bot: botFixture(), text: "A garantia é de 12 meses.", message: "esse relógio tem NFC?",
    resolveProvider: async () => { called = true; return { name: "ANTHROPIC", provider: { generateResponse: async () => "reescrito" } }; },
  });
  assert.equal(called, false);
  assert.equal(result.applied, false);
  assert.equal(result.text, "A garantia é de 12 meses.");
});

test("applyPersonality nunca reescreve quando o provider resolvido é o LOCAL_FALLBACK (sem credencial externa)", async () => {
  const bot = botFixture({ featureFlags: { externalAiFallbackEnabled: true, externalAiProvider: "ANTHROPIC" } });
  const result = await applyPersonality({
    bot, text: "A garantia é de 12 meses.", message: "tem garantia?",
    resolveProvider: async () => ({ name: "LOCAL_FALLBACK", provider: { generateResponse: async () => "nunca deveria ser chamado" } }),
  });
  assert.equal(result.applied, false);
  assert.equal(result.text, "A garantia é de 12 meses.");
});

test("applyPersonality reescreve o texto e devolve o system prompt usado quando um provider externo está configurado", async () => {
  const bot = botFixture({ featureFlags: { externalAiFallbackEnabled: true, externalAiProvider: "GEMINI" } });
  let receivedArgs = null;
  const result = await applyPersonality({
    bot, text: "A garantia é de 12 meses.", message: "esse relógio tem NFC?",
    resolveProvider: async () => ({
      name: "GEMINI",
      provider: {
        generateResponse: async (args) => { receivedArgs = args; return { text: "Nosso produto tem 12 meses de garantia, viu? 😊", usage: { inputTokens: 10, outputTokens: 8 } }; },
      },
    }),
  });
  assert.equal(result.applied, true);
  assert.equal(result.provider, "GEMINI");
  assert.equal(result.text, "Nosso produto tem 12 meses de garantia, viu? 😊");
  assert.match(result.systemPrompt, /Nunca: .*inventar informações/);
  // A resposta original (Knowledge) é passada ao provider como ÚNICA fonte
  // de fatos permitida — nunca é a mensagem do cliente que vira o texto base.
  assert.equal(receivedArgs.groundingText, "A garantia é de 12 meses.");
  assert.equal(receivedArgs.userMessage, "esse relógio tem NFC?");
});

test("applyPersonality nunca derruba a resposta: erro do provider devolve o texto original inalterado", async () => {
  const bot = botFixture({ featureFlags: { externalAiFallbackEnabled: true, externalAiProvider: "OPENAI" } });
  const result = await applyPersonality({
    bot, text: "A garantia é de 12 meses.", message: "tem garantia?",
    resolveProvider: async () => ({ name: "OPENAI", provider: { generateResponse: async () => { throw new Error("timeout"); } } }),
  });
  assert.equal(result.applied, false);
  assert.equal(result.text, "A garantia é de 12 meses.");
});

test("applyPersonality nunca reescreve um texto vazio/nulo (nada para estilizar)", async () => {
  const bot = botFixture({ featureFlags: { externalAiFallbackEnabled: true, externalAiProvider: "ANTHROPIC" } });
  const result = await applyPersonality({ bot, text: null, message: "oi" });
  assert.equal(result.applied, false);
  assert.equal(result.text, null);
});
