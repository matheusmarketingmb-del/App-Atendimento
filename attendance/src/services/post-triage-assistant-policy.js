const MIBRO_ASSISTANT = "mibro-after-hours-assistant";
const SINCROFIT_ASSISTANT = "sincrofit-after-hours-assistant";
const COMMERCIAL_RECEPTION = "commercial-number-welcome-bot";
const WHOLESALE_RECEPTION = "sincrofit-wholesale-entry-20261028";
const MIBRO_BLACK_MESSAGE = `*MIBRO BLACK | ATÉ 40% DE DESCONTO NO PIX*

Aproveite a Mibro Black para garantir seu próximo smartwatch com preços especiais!

Selecionamos 8 modelos com condições imperdíveis. Confira:

*Linha Essential*

*1. Mibro C4*
De: R$ 549,90 | Por: R$ 388,16
*No Pix: R$ 329,94*

*2. Mibro A3*
De: R$ 769,90 | Por: R$ 543,46
*No Pix: R$ 461,94*

*Linha Lifestyle*

*3. Mibro Lite 3*
De: R$ 799,90 | Por: R$ 658,74
*No Pix: R$ 559,93*

*4. Mibro Lite 3 Pro*
De: R$ 1.049,90 | Por: R$ 864,12
*No Pix: R$ 734,93*

*Linha Esportiva Profissional*

*5. Mibro GS Active*
De: R$ 849,90 | Por: R$ 699,92
*No Pix: R$ 594,93*

*6. Mibro GS Active2*
De: R$ 1.149,90 | Por: R$ 811,69
*No Pix: R$ 689,94*

*7. Mibro GS Pro*
De: R$ 999,90 | Por: R$ 760,00
*No Pix: R$ 599,94*

*8. Mibro GS Pro 2*
De: R$ 1.349,90 | Por: R$ 1.111,68
*No Pix: R$ 944,93*

*Tecnologia, estilo e desempenho com preços que valem a pena!*

Conheça os modelos, compare as funcionalidades e aproveite as condições especiais da Mibro Black.

*Confira todos os produtos:*
https://mibrobrasil.com.br/collections/todos-os-produtos

*Ficou interessado em algum modelo?*

Responda com o nome do smartwatch e nossa equipe ajudará você a encontrar a melhor opção!

*Ofertas sujeitas à disponibilidade e às condições do site.*`;
const NORMAL_ASSISTANTS = { "mibro-assistant-observer": "cmp_mibro", "sincrofit-assistant": "cmp_sincrofit" };

function normalAssistantBrand(bot) {
  if (!bot?.featureFlags?.assistantAfterTriage || NORMAL_ASSISTANTS[bot.id] !== bot.companyId) return null;
  if (bot.id === "mibro-assistant-observer") return "Mibro Brasil";
  return bot.id === "sincrofit-assistant" ? "Sincrofit" : null;
}

function acceptsNormalAssistantAccount(bot, conversation) {
  if (!normalAssistantBrand(bot) || bot.companyId !== conversation.companyId || conversation.channel !== "META") return false;
  if (bot.id === "sincrofit-assistant") return require("./sincrofit-assistant").belongsToAssistantAccount(bot, conversation);
  const account = conversation.channelAccount?.config;
  return account?.inboundBotId === "system-triage-bot"
    || (!account?.inboundBotId && (!conversation.channelAccountId || account?.legacyEnv === true || account?.isLegacyWhatsApp === true));
}

function assistantBrand(bot) {
  if (bot?.id === MIBRO_ASSISTANT && bot.companyId === "cmp_mibro") return "Mibro Brasil";
  if (bot?.id === SINCROFIT_ASSISTANT && bot.companyId === "cmp_sincrofit") return "Sincrofit";
  return null;
}

function acceptsAssistantAccount(bot, conversation) {
  if (!assistantBrand(bot) || !bot.featureFlags?.outsideHoursAssistant
    || bot.companyId !== conversation.companyId || conversation.channel !== "META") return false;
  const account = conversation.channelAccount?.config;
  const allowed = account?.allowedCategoryIds;
  if (conversation.categoryId && allowed?.length && !allowed.includes(conversation.categoryId)
    && !allowed.includes(conversation.category?.parentId)) return false;
  if (bot.id === SINCROFIT_ASSISTANT) {
    return account?.inboundBotId === "sincrofit-system-triage-20261022"
      && bot.featureFlags.channelAccountIds?.includes(conversation.channelAccountId);
  }
  if (account?.inboundBotId) return ["system-triage-bot", COMMERCIAL_RECEPTION].includes(account.inboundBotId);
  return !conversation.channelAccountId || account?.legacyEnv === true || account?.isLegacyWhatsApp === true;
}

function isAssistantEntry(bot) {
  return bot?.type === "SYSTEM_TRIAGE"
    || (bot?.id === COMMERCIAL_RECEPTION && bot.companyId === "cmp_mibro")
    || (bot?.id === WHOLESALE_RECEPTION && bot.companyId === "cmp_sincrofit");
}

function skipPostTriageAssistant(bot, category, { outsideHours = false } = {}) {
  return category?.code === "ATACADO" && (assistantBrand(bot) ? !outsideHours
    : ["mibro-assistant-observer", "sincrofit-assistant"].includes(bot?.id));
}

function assistantIntroduction(brand) {
  return `Olá! Sou a assistente virtual com IA da ${brand}. Vou responder ao que estiver na minha base de conhecimento. Se eu não souber, encaminho sua dúvida para a equipe.`;
}

function appendPartnershipIntake(nodes, links, firstKey) {
  const questions = [
    [firstKey, "partnershipProfiles", "Em quais redes sociais você cria conteúdo? Envie os links ou @ dos seus perfis principais. Se algum dado ainda não estiver disponível, pode responder ‘pular’."],
    ["partnership_format", "partnershipFormat", "Que tipo de parceria você gostaria de propor? Pode ser review, vídeo, stories, divulgação com cupom ou outro formato."],
    ["partnership_reach", "partnershipReach", "Qual é a média de visualizações dos seus conteúdos recentes? Se puder, indique a rede e o formato, como Reels, stories ou vídeos."],
    ["partnership_rate", "partnershipRate", "Qual valor você costuma cobrar por post, vídeo ou pacote? Se tiver um mídia kit, pode incluir o link na resposta."],
  ];
  const handoff = "partnership_team";
  for (const [index, [key, variable, text]] of questions.entries()) {
    const item = { key, type: "question", name: "Proposta de parceria", config: {
      text, variable: `flow.${variable}`, answerType: "TEXT", maxAttempts: 2,
    } };
    const original = nodes.findIndex(node => node.key === key);
    if (original < 0) nodes.push(item);
    else nodes[original] = { ...nodes[original], ...item };
    links.push([key, "next", questions[index + 1]?.[0] || handoff], [key, "invalid", handoff]);
  }
  nodes.push({ key: handoff, type: "human_handoff", name: "Análise de parceria", config: {
    message: "Valeu por compartilhar sua proposta! Vou encaminhar as informações para a equipe avaliar e continuar por aqui.",
    reason: "Proposta de parceria. As respostas do cliente estão no histórico da conversa.",
  } });
}

function withNormalAssistantOpening(graph, bot, categoryCode, showMibroBlack = false) {
  const brand = normalAssistantBrand(bot);
  const start = graph.nodes.find(node => node.type === "start" && node.config?.trigger === "AFTER_TRIAGE");
  if (!brand || !start) return graph;
  const nodes = graph.nodes.map(node => {
    if (node === start) return {
      ...node, config: { ...node.config, initialMessage: `Olá! Sou o assistente virtual da ${brand}. Posso adiantar seu atendimento por aqui. Se preferir, é só pedir para falar com nossa equipe.` },
    };
    if (brand === "Sincrofit" && node.key === "product" && node.type === "question") return {
      ...node, config: { ...node.config, text: node.config.text.replace(/^Olá! Sou o assistente da Sincrofit\.\s*/, "") },
    };
    return node;
  });
  const next = graph.edges.find(edge => edge.source === start.key && edge.sourceHandle === "next");
  const has = key => nodes.some(node => node.key === key);
  const mibro = brand === "Mibro Brasil";
  const human = mibro ? "human" : "handoff";
  if (!next || !has(human) || has("normal_assistant_options")) return { ...graph, nodes };

  const code = String(categoryCode || "").replace(/^\d+_/, "");
  const support = ["SUPORTE", "ASSISTENCIA_TECNICA", "GARANTIA"].includes(code);
  const partnership = ["MARKETING", "EQUIPE_MARKETING", "PARCERIAS"].includes(code);
  const links = [];
  let edges = graph.edges;
  let label;
  let target;
  if (partnership && (mibro || has("social"))) {
    label = "Propor uma parceria";
    target = mibro ? "partnership_profiles" : "social";
    edges = edges.filter(edge => edge.source !== target);
    appendPartnershipIntake(nodes, links, target);
  } else if (mibro && has("to_router") && has("known_need")) {
    if (code === "VAREJO" || code === "COMERCIAL" || code === "GARANTIA" || code === "SUPORTE") {
      const topic = { GARANTIA: "garantia", SUPORTE: "problema no relógio" }[code] || "produto";
      label = support ? "Ver orientações" : "Conhecer os produtos";
      target = "normal_assistant_topic";
      nodes.push({ key: target, type: "variable", name: label, config: { assignments: [{ key: "flow.customerProblem", value: topic }] } });
    } else if (code === "ASSISTENCIA_TECNICA" && has("to_technical")) {
      label = "Informar o problema";
      target = "to_technical";
    } else if (code !== "ATACADO") {
      label = "Continuar atendimento";
      target = "known_need";
    }
  } else if (!mibro && has("topics")) {
    [label, target] = support ? ["Informar o problema", "product"]
      : code === "VAREJO" || code === "COMERCIAL" ? ["Conhecer os produtos", "products"] : [];
  }
  if (!target || !has(target)) return { ...graph, nodes };
  const key = "normal_assistant_options";
  const options = [{ id: "continue", label, ...(partnership ? { keywords: ["parceria", "parcerias"] } : {}) },
    { id: "human", label: "Falar com atendente" }, { id: "other", label: "Outros assuntos" }];
  if (showMibroBlack && mibro && ["VAREJO", "COMERCIAL"].includes(code)) {
    options.push({ id: "mibro_black", label: "Descontos da Mibro Black", keywords: ["mibro black", "black friday"] });
    nodes.push({ key: "mibro_black_offers", type: "message", name: "Ofertas da Mibro Black", config: {
      source: "TEXT",
      text: MIBRO_BLACK_MESSAGE,
    } });
    links.push([key, "opt:mibro_black", "mibro_black_offers"], ["mibro_black_offers", "next", key]);
  }
  nodes.push({ key, type: "menu", name: "Opções do setor", config: {
    text: "Como prefere continuar neste setor?", display: "LIST", buttonLabel: "Ver opções",
    variable: "flow.normalAssistantOption", maxAttempts: 2,
    options,
  } });
  links.push([key, "opt:continue", target], [key, "opt:human", human], [key, "opt:other", next.target], [key, "invalid", human]);
  if (target === "normal_assistant_topic") links.push([target, "next", "to_router"]);
  return { ...graph, nodes, edges: [
    ...edges.map(edge => edge === next ? { ...edge, target: key } : edge),
    ...links.map(([source, sourceHandle, target]) => ({ id: `${source}:${sourceHandle}:${target}`, source, sourceHandle, target })),
  ] };
}

function withAssistantIntroduction(graph, bot, outsideHours = false, categoryCode) {
  const brand = assistantBrand(bot);
  if (!brand) return graph;
  const introduction = assistantIntroduction(brand);
  const notice = outsideHours ? "\n\nNossa equipe está fora do expediente. Posso adiantar seu atendimento por aqui." : "";
  const presented = {
    ...graph,
    nodes: graph.nodes.map(node => node.type === "start" && node.config?.trigger === "AFTER_TRIAGE"
      ? { ...node, config: { ...node.config, initialMessage: introduction + notice } }
      : node),
  };
  const topics = presented.nodes.find(node => node.key === "topics" && node.type === "menu");
  if (bot.id !== SINCROFIT_ASSISTANT || !outsideHours || categoryCode !== "ATACADO"
    || presented.nodes.some(node => node.key === "commercial_wholesale_store")
    || !topics || topics.config.options.some(option => option.id === "wholesale")
    || !presented.nodes.some(node => node.key === "handoff")) return presented;
  return {
    ...presented,
    nodes: [
      ...presented.nodes.map(node => node === topics ? {
        ...node, config: { ...node.config, options: [...node.config.options,
          { id: "wholesale", label: "Comprar no atacado", keywords: ["atacado", "revenda"] }] },
      } : node),
      { key: "wholesale_need", type: "question", name: "Interesse no atacado", config: {
        text: "Quais produtos e quantidades você procura para atacado ou revenda? Vou deixar essas informações com o Comercial para confirmar as condições.",
        variable: "flow.wholesaleNeed", answerType: "TEXT", maxAttempts: 2,
      } },
    ],
    edges: [
      ...presented.edges,
      { id: "topics:opt:wholesale", source: "topics", sourceHandle: "opt:wholesale", target: "wholesale_need" },
      { id: "wholesale_need:next", source: "wholesale_need", sourceHandle: "next", target: "handoff" },
    ],
  };
}

module.exports = { acceptsAssistantAccount, acceptsNormalAssistantAccount, assistantBrand, assistantIntroduction,
  isAssistantEntry, normalAssistantBrand, skipPostTriageAssistant, withAssistantIntroduction, withNormalAssistantOpening };
