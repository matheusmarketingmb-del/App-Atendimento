// Personalidade configurável por Bot ("Bot -> Personalidade"). Define só
// COMO o Bot responde (identidade, tom, estilo, comportamentos obrigatórios/
// proibidos, tamanho preferido). NUNCA define O QUE ele responde — isso
// continua vindo, nesta ordem de prioridade inalterada, de: Flow Engine >
// Tool > Base de Conhecimento (KnowledgeSource) > resposta configurada da
// intenção/fallback (ver bot-response-service.js). A Personalidade só entra
// DEPOIS que um desses já decidiu o conteúdo, e só reescreve a FORMA — nunca
// o conteúdo (ver buildSystemPrompt/SAFETY_FOOTER abaixo).
const prisma = require("../database/prisma");
const authorization = require("./authorization-service");
const audit = require("./audit-service");
const { resolveFeatureFlags } = require("./bot-governance-service");
const { getPrimaryProvider } = require("./ai/get-ai-provider");
const {
  DEFAULT_PERSONALITY, PERSONALITY_LIST_LIMITS, PERSONALITY_PRESET_OPTIONS, PERSONALITY_TEXT_LIMITS,
  PRESET_DEFINITIONS, RESPONSE_LENGTH_LABELS, RESPONSE_LENGTH_OPTIONS,
} = require("./bot-personality-constants");

function fail(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function assertBotManager(viewer) {
  if (!authorization.isMaster(viewer)) {
    throw authorization.forbidden("Somente uma conta Master pode gerenciar a personalidade dos Bots.");
  }
}

async function ensureBot(botId, client = prisma) {
  const bot = await client.bot.findUnique({ where: { id: botId } });
  if (!bot) throw fail("Bot não encontrado.", 404);
  return bot;
}

function optionalText(value, label, maxLength) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw fail(`${label} inválido.`);
  const text = value.trim();
  if (!text) return null;
  if (text.length > maxLength) throw fail(`${label} deve ter no máximo ${maxLength.toLocaleString("pt-BR")} caracteres.`);
  return text;
}

// Listas (tom, estilo, comportamentos) sempre vêm como array de strings
// curtas — nunca um texto livre solto, para o system prompt ficar sempre
// bem formado e a UI poder editar item por item (chips).
function optionalStringList(value, label) {
  if (value === undefined) return undefined;
  if (value === null) return [];
  if (!Array.isArray(value)) throw fail(`${label} deve ser uma lista.`);
  if (value.length > PERSONALITY_LIST_LIMITS.maxItems) {
    throw fail(`${label} deve ter no máximo ${PERSONALITY_LIST_LIMITS.maxItems} itens.`);
  }
  return value.map((item) => {
    if (typeof item !== "string" || !item.trim()) throw fail(`${label} contém um item inválido.`);
    const text = item.trim();
    if (text.length > PERSONALITY_LIST_LIMITS.maxItemLength) {
      throw fail(`Cada item de ${label} deve ter no máximo ${PERSONALITY_LIST_LIMITS.maxItemLength} caracteres.`);
    }
    return text;
  });
}

function validateResponseLength(value) {
  if (value === undefined) return undefined;
  if (!RESPONSE_LENGTH_OPTIONS.includes(value)) throw fail("Tamanho preferido de resposta inválido.");
  return value;
}

function validatePreset(value) {
  if (value === undefined) return undefined;
  if (!PERSONALITY_PRESET_OPTIONS.includes(value)) throw fail("Preset de personalidade inválido.");
  return value;
}

// Bot sem BotPersonality própria usa o default da Mibro Brasil — nunca
// fica "sem personalidade" (item "Bot sem personalidade usa default").
function getEffectivePersonality(bot) {
  return bot?.personality || DEFAULT_PERSONALITY;
}

async function getPersonality(botId, viewer) {
  assertBotManager(viewer);
  const bot = await ensureBot(botId);
  const personality = await prisma.botPersonality.findUnique({ where: { botId } });
  return { personality, effective: personality || DEFAULT_PERSONALITY, isDefault: !personality, botId: bot.id };
}

function listPresets() {
  return PERSONALITY_PRESET_OPTIONS.map((key) => ({
    preset: key,
    label: presetLabel(key),
    definition: key === "PERSONALIZADO" ? null : PRESET_DEFINITIONS[key],
  }));
}

function presetLabel(preset) {
  switch (preset) {
    case "TRIAGEM": return "Triagem";
    case "SUPORTE": return "Suporte";
    case "COMERCIAL": return "Comercial";
    case "POS_VENDA": return "Pós-venda";
    default: return "Personalizado";
  }
}

// Upsert completo: cria a linha na primeira edição, atualiza depois. Um
// campo omitido no PATCH mantém o valor salvo (nunca reseta sozinho).
// `preset` default PERSONALIZADO quando o payload não informa (edição manual
// de campo não vinda de "aplicar preset" sempre vira PERSONALIZADO).
async function upsertPersonality(botId, data, actor) {
  assertBotManager(actor);
  const bot = await ensureBot(botId);

  const patch = {
    assistantName: data.assistantName !== undefined ? optionalText(data.assistantName, "Nome do assistente", PERSONALITY_TEXT_LIMITS.assistantName) : undefined,
    roleDescription: data.roleDescription !== undefined ? optionalText(data.roleDescription, "Descrição do papel", PERSONALITY_TEXT_LIMITS.roleDescription) : undefined,
    tone: optionalStringList(data.tone, "Tom de voz"),
    responseStyle: optionalStringList(data.responseStyle, "Estilo de resposta"),
    mandatoryBehaviors: optionalStringList(data.mandatoryBehaviors, "Comportamentos obrigatórios"),
    forbiddenBehaviors: optionalStringList(data.forbiddenBehaviors, "Comportamentos proibidos"),
    additionalInstructions: data.additionalInstructions !== undefined ? optionalText(data.additionalInstructions, "Instruções adicionais", PERSONALITY_TEXT_LIMITS.additionalInstructions) : undefined,
    responseLength: validateResponseLength(data.responseLength),
    preset: validatePreset(data.preset) ?? "PERSONALIZADO",
  };
  // Remove chaves undefined para o Prisma não sobrescrever com null sem querer.
  Object.keys(patch).forEach((key) => patch[key] === undefined && delete patch[key]);

  const personality = await prisma.botPersonality.upsert({
    where: { botId },
    create: { botId, ...DEFAULT_PERSONALITY_CREATE_BASE(), ...patch },
    update: patch,
  });

  await audit.recordAudit({
    actor, action: "BOT_PERSONALITY_UPDATED", entityType: "BOT", entityId: bot.id,
    summary: `Atualizou a personalidade do Bot ${bot.name}`,
    details: { personality },
  });

  return personality;
}

// Base "em branco" para o create() do upsert — nunca reaproveita
// DEFAULT_PERSONALITY (que é read-only/Object.freeze e representa o
// fallback IMPLÍCITO de quem não tem registro, não um valor a persistir).
function DEFAULT_PERSONALITY_CREATE_BASE() {
  return {
    preset: "PERSONALIZADO",
    tone: [], responseStyle: [], mandatoryBehaviors: [], forbiddenBehaviors: [],
    responseLength: "MEDIUM",
  };
}

// Aplica um preset pronto (item "Adicionar presets"): substitui TODOS os
// campos de personalidade pelo conteúdo do preset (preset continua editável
// depois — só marca preset=<escolhido>, não trava a edição).
async function applyPreset(botId, presetKey, actor) {
  assertBotManager(actor);
  const bot = await ensureBot(botId);
  if (!PERSONALITY_PRESET_OPTIONS.includes(presetKey)) throw fail("Preset inválido.");
  if (presetKey === "PERSONALIZADO") throw fail('Use a edição manual para o preset "Personalizado" — ele não tem conteúdo pronto para aplicar.');

  const definition = PRESET_DEFINITIONS[presetKey];
  const data = {
    preset: definition.preset,
    assistantName: definition.assistantName,
    roleDescription: definition.roleDescription,
    tone: [...definition.tone],
    responseStyle: [...definition.responseStyle],
    mandatoryBehaviors: [...definition.mandatoryBehaviors],
    forbiddenBehaviors: [...definition.forbiddenBehaviors],
    additionalInstructions: definition.additionalInstructions,
    responseLength: definition.responseLength,
  };

  const personality = await prisma.botPersonality.upsert({
    where: { botId }, create: { botId, ...data }, update: data,
  });

  await audit.recordAudit({
    actor, action: "BOT_PERSONALITY_PRESET_APPLIED", entityType: "BOT", entityId: bot.id,
    summary: `Aplicou o preset "${presetLabel(presetKey)}" à personalidade do Bot ${bot.name}`,
    details: { preset: presetKey },
  });

  return personality;
}

// Copiar personalidade entre Bots (item "Permitir copiar personalidade
// entre Bots"). Nunca copia o próprio Bot para si mesmo; nunca falha
// silenciosamente se a origem não tiver personalidade própria — nesse caso
// copia o default explícito da Mibro Brasil (o destino passa a ter uma
// personalidade PRÓPRIA igual ao default, não fica "linkado" à origem).
async function copyPersonality(sourceBotId, targetBotId, actor) {
  assertBotManager(actor);
  if (sourceBotId === targetBotId) throw fail("Selecione um Bot de destino diferente do Bot de origem.");
  const [sourceBot, targetBot] = await Promise.all([ensureBot(sourceBotId), ensureBot(targetBotId)]);
  const sourcePersonality = await prisma.botPersonality.findUnique({ where: { botId: sourceBotId } });
  const source = sourcePersonality || DEFAULT_PERSONALITY;

  const data = {
    preset: source.preset,
    assistantName: source.assistantName,
    roleDescription: source.roleDescription,
    tone: [...source.tone],
    responseStyle: [...source.responseStyle],
    mandatoryBehaviors: [...source.mandatoryBehaviors],
    forbiddenBehaviors: [...source.forbiddenBehaviors],
    additionalInstructions: source.additionalInstructions,
    responseLength: source.responseLength,
  };

  const personality = await prisma.botPersonality.upsert({
    where: { botId: targetBotId }, create: { botId: targetBotId, ...data }, update: data,
  });

  await audit.recordAudit({
    actor, action: "BOT_PERSONALITY_COPIED", entityType: "BOT", entityId: targetBot.id,
    summary: `Copiou a personalidade do Bot ${sourceBot.name} para o Bot ${targetBot.name}`,
    details: { sourceBotId, targetBotId },
  });

  return personality;
}

// Instruções que NENHUMA personalidade pode sobrescrever, sempre anexadas
// por último no system prompt (item "Não permitir que personalidade
// sobrescreva: regras de segurança; dados reais; Knowledge; Tools; Flow
// Engine"). Nunca vem de dado do usuário/formulário — é uma constante fixa
// deste arquivo.
const SAFETY_FOOTER = [
  "Estas instruções de personalidade definem apenas o TOM e o ESTILO da resposta — nunca o CONTEÚDO.",
  "Nunca contradiga, ignore ou substitua: informações vindas da Base de Conhecimento, o resultado de uma Tool já executada, uma etapa do Fluxo de atendimento já decidida, ou um encaminhamento para atendimento humano já decidido.",
  "Use somente as informações do texto de referência fornecido a seguir. Nunca invente dados, preços, prazos, números de pedido ou funcionalidades que não estejam confirmadas nesse texto.",
  "Nunca prometa ou garanta uma função/funcionalidade do produto que não esteja explicitamente confirmada no texto de referência.",
  "Preserve o significado e TODAS as informações do texto de referência — você pode reescrever a forma (tom, estilo, tamanho), nunca o conteúdo.",
].join(" ");

function buildSystemPrompt(personality) {
  const p = personality || DEFAULT_PERSONALITY;
  const lines = [];
  lines.push(`Você é ${p.assistantName || "o assistente virtual"}.`);
  if (p.roleDescription) lines.push(`Papel: ${p.roleDescription}`);
  if (p.tone?.length) lines.push(`Tom de voz: ${p.tone.join(", ")}.`);
  if (p.responseStyle?.length) lines.push(`Estilo de resposta: ${p.responseStyle.join(", ")}.`);
  if (p.mandatoryBehaviors?.length) lines.push(`Sempre: ${p.mandatoryBehaviors.join("; ")}.`);
  if (p.forbiddenBehaviors?.length) lines.push(`Nunca: ${p.forbiddenBehaviors.join("; ")}.`);
  if (p.additionalInstructions) lines.push(`Instruções adicionais: ${p.additionalInstructions}`);
  lines.push(`Tamanho preferido das respostas: ${RESPONSE_LENGTH_LABELS[p.responseLength] || RESPONSE_LENGTH_LABELS.MEDIUM}.`);
  lines.push(SAFETY_FOOTER);
  return lines.join("\n");
}

// Reescreve `text` (já decidido por Flow Engine/Tool/Knowledge/intenção —
// ver bot-response-service.js#isPersonalityEligible) no tom/estilo da
// personalidade do Bot, usando um provider de IA real. NUNCA lança: qualquer
// falha (sem provider configurado, erro de rede, resposta vazia) devolve o
// texto original inalterado — a personalidade é só um verniz, nunca pode
// impedir a resposta de sair.
//
// Reaproveita DELIBERADAMENTE o mesmo par de flags já usado para o fallback
// de classificação por IA externa (flags.externalAiFallbackEnabled +
// externalAiProvider/externalAiModel — ver bot-interpreter-service.js): um
// Master já decide ali se este Bot pode chamar IA externa; a personalidade
// não introduz um segundo toggle paralelo. Sem credencial/provider externo
// configurado, getPrimaryProvider() sempre cai no LOCAL_FALLBACK, que nunca
// reescreve nada — sem risco de mudar o comportamento de um Bot já existente
// até um Master ligar isso explicitamente.
async function applyPersonality({ bot, text, message, resolveProvider = getPrimaryProvider }) {
  if (!text) return { text, applied: false, provider: null, systemPrompt: null };

  const flags = resolveFeatureFlags(bot);
  if (flags.externalAiFallbackEnabled !== true) {
    return { text, applied: false, provider: null, systemPrompt: null };
  }

  const resolved = await resolveProvider(flags.externalAiProvider, flags.externalAiModel || undefined);
  if (!resolved?.provider || resolved.name === "LOCAL_FALLBACK") {
    return { text, applied: false, provider: resolved?.name || "LOCAL_FALLBACK", systemPrompt: null };
  }

  const personality = getEffectivePersonality(bot);
  const systemPrompt = buildSystemPrompt(personality);

  try {
    const result = await resolved.provider.generateResponse({
      bot, systemPrompt, groundingText: text, userMessage: message,
    });
    const rephrased = typeof result === "string" ? result.trim() : String(result?.text || "").trim();
    if (!rephrased) return { text, applied: false, provider: resolved.name, systemPrompt };
    return {
      text: rephrased, applied: true, provider: resolved.name, systemPrompt,
      assistantName: personality.assistantName || null, usage: result?.usage || null,
    };
  } catch (error) {
    // Nunca pode derrubar a resposta ao cliente por falha na reescrita de
    // estilo — degrada para o texto original, exatamente como
    // resolveKnowledgeResponse já faz para falha de busca.
    console.error("[BOT_PERSONALITY] falha ao reescrever resposta (ignorada, texto original mantido)", error.message);
    return { text, applied: false, provider: resolved.name, systemPrompt, error: error.message };
  }
}

module.exports = {
  applyPersonality,
  applyPreset,
  buildSystemPrompt,
  copyPersonality,
  getEffectivePersonality,
  getPersonality,
  listPresets,
  upsertPersonality,
};
