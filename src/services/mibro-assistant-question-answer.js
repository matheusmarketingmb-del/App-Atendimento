// Deterministic post-triage assistant. Answers are curated from the previous knowledge database.
// No model, RAG, order lookup, invented stock/price or automatic warranty approval.
const { normalizeText } = require("./bot-schedule-utils");
const STORE_URL = "https://mibrobrasil.com.br/";
const PRODUCT_URLS = Object.fromEntries(["A3", "C4", "GS Pro", "GS Pro 2", "Lite 3", "Lite 3 Pro"].map((model) => [normalizeText(model), `${STORE_URL}products/mibro-${model.toLowerCase().replace(/\s+/g, "-")}`]));

const ANSWERS = [
  { key: "ASSIST_MIBRO_GARANTIA", sourceIds: ["cmtljoz8v009is60k6zt9zf7x"], title: "Garantia", text: "Claro, vou te explicar! A garantia é de 12 meses para defeitos de fabricação, com NF-e de compra em canal oficial ou revendedor autorizado no Brasil. Nossa equipe precisa analisar o caso antes de confirmar troca, reparo ou reembolso.\nPara facilitar, tenha em mãos modelo, pedido, NF-e e fotos ou vídeos do problema.\nSolicitação: https://mibrobrasil.com.br/pages/contact\nTermos: https://mibrobrasil.com.br/pages/termos-de-garantia" },
  { key: "ASSIST_MIBRO_SUPORTE", sourceIds: ["mibro-app", "cmtljoz8v009is60k6zt9zf7x", "cmtaghlr400c4o90ktgi15hsp"], title: "Suporte e aplicativo", text: "Vamos conferir isso juntos! Para ajudar com conexão, notificações ou funcionamento, preciso saber o modelo e o que está acontecendo. O aplicativo indicado é o Mibro Fit; funções e compatibilidade dependem do modelo.\nSe o relógio molhou, seque completamente antes de carregar e evite água quente ou vapor. A equipe pode avaliar o caso com essas informações." },
  { key: "ASSIST_MIBRO_EMPRESA", sourceIds: ["cmtljslip009ss60k1r4l61jx"], title: "Mibro Brasil", text: "Que bom ter você por aqui! A Mibro Brasil é representante oficial da marca e trabalha com produtos originais. Temos modelos com notificações, modos esportivos, chamadas Bluetooth e GPS — cada relógio tem suas próprias funções. Posso te ajudar a conhecer o modelo que você procura." },
  { key: "ASSIST_MIBRO_PAGAMENTO", sourceIds: ["cmtljr1id009os60k79vrj96f"], title: "Pagamento e entrega", text: "Você pode pagar por cartão de crédito, PIX ou boleto, conforme as condições da loja. O prazo de entrega depende da sua região e do frete escolhido, e o rastreio é enviado após a postagem.\nSe a dúvida for sobre um pedido que você já fez, nossa equipe pode conferir o pagamento e o andamento com segurança." },
  { key: "ASSIST_MIBRO_TROCAS", sourceIds: ["mibro-trocas", "cmtaghlr400c4o90ktgi15hsp"], title: "Trocas e devoluções", text: "Entendi! A política prevê solicitação de arrependimento em até 7 dias corridos após o recebimento, conforme as condições aplicáveis. Para trocas ou devoluções, nossa equipe precisa analisar a solicitação antes de confirmar o resultado.\nTenha em mãos o número do pedido, o produto e o motivo — assim conseguimos te orientar melhor." },
];

function eligibleSources(sources, now = new Date()) {
  return sources.filter((source) => source.active && source.content?.trim() && (!source.validFrom || new Date(source.validFrom) <= now) && (!source.validUntil || new Date(source.validUntil) >= now));
}

function prepareAnswers(sources, now = new Date()) {
  const available = new Map(eligibleSources(sources, now).map((source) => [source.id, source]));
  const answers = ANSWERS.filter((answer) => answer.sourceIds.every((id) => available.has(id))).map((answer) => ({ ...answer, category: "GERAL", text: `${answer.text}\n\nVocê também pode consultar nossa loja: ${STORE_URL}` }));
  const seen = new Set();
  const products = eligibleSources(sources, now).filter((source) => source.type === "PRODUCT" && source.product).filter((source) => {
    const key = normalizeText(source.product); if (seen.has(key)) return false; seen.add(key); return true;
  }).map((source, i) => {
    const key = `ASSIST_MIBRO_PRODUTO_${i + 1}`;
    // Product rows are already short factual summaries. Preserve qualifiers such as "até".
    const summary = source.content.length <= 550 ? source.content : source.content.split(/(?<=[.!?])\s+/).filter((part) => part.length <= 550).slice(0, 2).join(" ");
    const details = summary.split(/;\s*/).map((part) => `• ${part.trim()}`).join("\n");
    const url = PRODUCT_URLS[normalizeText(source.product.replace(/^Mibro\s+/i, ""))] || STORE_URL;
    return { key, title: source.title, product: source.product, sourceIds: [source.id], category: "GERAL", text: `Claro! Aqui vai um resumo do *${source.title}* para você conhecer melhor 😊\n\n${details || "Nossa equipe pode ajudar a conferir a ficha deste modelo."}\n\nVeja os detalhes e as condições atuais na loja: ${url}\nA duração da bateria varia conforme o uso. Preço e estoque devem ser conferidos na loja ou com nossa equipe.` };
  });
  return { answers: [...answers, ...products], products };
}

function buildPostTriageAssistantGraph({ products = [], availableKeys = new Set() } = {}) {
  const nodes = [], edges = [];
  const node = (key, type, name, config) => nodes.push({ key, type, name, x: 80 + (nodes.length % 5) * 280, y: Math.floor(nodes.length / 5) * 190, config });
  const edge = (source, handle, target) => edges.push({ id: `${source}:${handle}:${target}`, source, sourceHandle: handle, target });
  const ask = (key, name, text, variable, answerType = "TEXT") => node(key, "question", name, { text, variable, answerType, maxAttempts: 3 });
  const topics = [
    { id: "warranty", label: "Garantia", terms: ["garantia"], answer: "ASSIST_MIBRO_GARANTIA" },
    { id: "returns", label: "Trocas e devoluções", terms: ["devolu", "troca", "arrependimento"], answer: "ASSIST_MIBRO_TROCAS" },
    { id: "orders", label: "Pedido e rastreamento", terms: ["pedido", "rastre", "não chegou", "nao chegou", "entrega"] },
    { id: "payment", label: "Pagamento e frete", terms: ["pagamento", "pagar", "pix", "boleto", "frete"], answer: "ASSIST_MIBRO_PAGAMENTO" },
    { id: "resale", label: "Atacado e revenda", terms: ["revend", "atacad", "quantidade", "distribuid"] },
    { id: "company", label: "Sobre a Mibro Brasil", terms: ["oficial", "original", "sobre a mibro", "empresa"], answer: "ASSIST_MIBRO_EMPRESA" },
    { id: "support", label: "Suporte técnico / Mibro Fit", terms: ["problema", "defeito", "não funciona", "nao funciona", "carreg", "notifica", "parea", "conex", "mibro fit", "aplicativo"], answer: "ASSIST_MIBRO_SUPORTE" },
    { id: "products", label: "Produtos e especificações", terms: ["modelo", "produto", "relógio", "relogio", "smartwatch", "gps", "bateria", "chamada", "comprar", "preço", "preco"] },
  ];
  node("start", "start", "Após a Triagem", { trigger: "AFTER_TRIAGE", channels: [], initialMessage: "{{bot.initialMessage}}" });
  node("known_need", "condition", "Triagem já coletou o problema?", { rules: [{ left: "flow.initialNeed", operator: "exists", right: "" }] });
  node("reuse_need", "variable", "Preservar problema da Triagem", { assignments: [{ key: "flow.customerProblem", value: "{{flow.initialNeed}}" }] });
  ask("problem", "Entender o problema", "Você está em {{conversation.categoryName}}. Como posso ajudar? Conte sua dúvida ou problema.", "flow.customerProblem");
  edge("start", "next", "known_need"); edge("known_need", "true", "reuse_need"); edge("known_need", "false", "problem");
  edge("reuse_need", "next", "topic_warranty"); edge("problem", "next", "topic_warranty");
  node("topics", "menu", "Escolher assunto", { text: "Não consegui identificar o assunto com segurança. Escolha uma opção:", display: "LIST", variable: "flow.topic", maxAttempts: 3, options: [...topics.map((topic) => ({ id: topic.id, label: topic.label })), { id: "human", label: "Falar com atendente" }] });
  edge("topics", "opt:human", "handoff"); edge("topics", "invalid", "handoff");
  topics.forEach((topic, i) => {
    node(`topic_${topic.id}`, "condition", `Assunto: ${topic.label}`, { match: "ANY", rules: topic.terms.map((term) => ({ left: "flow.customerProblem", operator: "contains", right: term })) });
    edge(`topic_${topic.id}`, "true", `answer_${topic.id}`);
    edge(`topic_${topic.id}`, "false", topics[i + 1] ? `topic_${topics[i + 1].id}` : "topics");
    edge("topics", `opt:${topic.id}`, `answer_${topic.id}`);
    if (topic.id === "products") {
      ask("answer_products", "Qual produto?", "Qual é o modelo do relógio? Responda apenas com o nome do modelo, por exemplo: GS Pro 2, Lite 3 ou C4.", "flow.model");
      edge("answer_products", "next", products.length ? "model_0" : "handoff");
    } else if (topic.id === "orders") {
      ask("answer_orders", "Identificar pedido", "Informe o número do pedido para a equipe consultar. Não consigo confirmar o status ou rastreio em tempo real.", "flow.orderNumber");
      edge("answer_orders", "next", "handoff");
    } else if (topic.id === "resale") {
      ask("answer_resale", "Identificar revenda", "Qual produto e quantidade você procura para atacado ou revenda? Nossa equipe vai confirmar as condições comerciais.", "flow.resaleNeed");
      edge("answer_resale", "next", "handoff");
    } else if (availableKeys.has(topic.answer)) {
      node(`answer_${topic.id}`, "message", topic.label, { source: "LIBRARY", responseKey: topic.answer });
      edge(`answer_${topic.id}`, "next", topic.id === "support" ? "support_model" : "helped");
    } else {
      node(`answer_${topic.id}`, "human_handoff", "Informação não disponível", { message: "Não tenho uma resposta cadastrada suficiente. Vou passar sua dúvida à equipe do setor escolhido.", reason: "Base anterior sem fonte ativa para este assunto" });
    }
  });
  if (availableKeys.has("ASSIST_MIBRO_SUPORTE")) {
    ask("support_model", "Modelo para suporte", "Qual é o modelo do relógio e qual aplicativo você está usando? Vou registrar isso para continuar o suporte.", "flow.model");
    edge("support_model", "next", "handoff");
  }
  products.forEach((product, i) => {
    const aliases = [...new Set([product.product, product.title, product.product.replace(/\s/g, ""), `Mibro ${product.product}`])];
    node(`model_${i}`, "condition", product.title, { match: "ANY", rules: aliases.map((alias) => ({ left: "flow.model", operator: "==", right: alias })) });
    node(`product_${i}`, "message", product.title, { source: "LIBRARY", responseKey: product.key });
    edge(`model_${i}`, "true", `product_${i}`); edge(`model_${i}`, "false", products[i + 1] ? `model_${i + 1}` : "handoff"); edge(`product_${i}`, "next", "helped");
  });
  node("helped", "menu", "Como deseja continuar?", { text: "Como você gostaria de continuar? Posso chamar a equipe do seu setor para ajudar com a compra, o pedido ou sua dúvida.", display: "LIST", variable: "flow.nextAction", maxAttempts: 3, options: [
    { id: "human", label: "Vendedor ou atendente", keywords: ["vendedor", "atendente", "falar com a equipe", "não", "não deu certo", "não funcionou", "não resolveu", "continua com problema"] },
    { id: "done", label: "Finalizar atendimento", keywords: ["sim", "finalizar", "encerrar", "obrigado", "resolveu"] },
    { id: "another", label: "Outro assunto", keywords: ["outro assunto", "menu inicial"] },
  ] });
  node("done", "end", "Orientação concluída", { message: "Tudo certo! Obrigado pelo contato 😊 Se precisar de algo mais, é só nos chamar.", finalizeConversation: true });
  node("handoff", "human_handoff", "Continuar no setor escolhido", { message: "Vou encaminhar as informações para nossa equipe deste setor continuar seu atendimento.", reason: "Dúvida: {{flow.customerProblem}} | Modelo/app: {{flow.model}} | Pedido: {{flow.orderNumber}} | Revenda: {{flow.resaleNeed}}" });
  edge("helped", "opt:human", "handoff"); edge("helped", "opt:done", "done"); edge("helped", "opt:another", "topics"); edge("helped", "invalid", "handoff");
  return { nodes, edges, viewport: { x: 0, y: 0, zoom: 0.7 } };
}

module.exports = { ANSWERS, buildPostTriageAssistantGraph, eligibleSources, prepareAnswers };
