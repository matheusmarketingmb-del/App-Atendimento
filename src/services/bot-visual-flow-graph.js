// Flow Builder (Editor Visual): shape do grafo, registry de tipos de nó e
// validação de publicação. Puro, sem I/O — as checagens que dependem do
// banco (setor/usuário/fluxo/resposta/endpoint/mídia existentes) recebem os
// ids válidos prontos em `refs` (ver bot-visual-flow-service.js#loadValidationRefs).
//
// Grafo salvo em BotFlow.draftGraph / BotFlowVersion.graph:
//   { nodes: [{ key, type, name, x, y, config }],
//     edges: [{ id, source, sourceHandle, target }],
//     viewport: { x, y, zoom } }
//
// Motor 100% determinístico: nenhum nó depende de IA. Adicionar um tipo novo
// = registrar mais um item em NODE_TYPES (e um handler em
// bot-visual-flow-engine.js).

const MAX_NODES = 300;
const MAX_EDGES = 900;
const MAX_TEXT = 4000;
const MAX_MENU_OPTIONS = 50;
const NODE_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const VARIABLE_PATH_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*){0,4}$/;
const TEMPLATE_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g;
const STORAGE_KEY_PATTERN = /^[a-f0-9]{32,64}\.[a-z0-9]{2,5}$/;

// Raízes que um nó pode ESCREVER (Pergunta/Menu/Variável/Webhook).
const WRITABLE_ROOTS = new Set(["customer", "flow", "vars", "custom"]);
// Variáveis de sistema (preenchidas só pelo motor) — qualquer outra coisa
// em contact./conversation./bot. é "variável inexistente".
const SYSTEM_VARIABLES = Object.freeze([
  "contact.name", "contact.firstName", "contact.phone", "contact.email", "contact.greeting", "contact.greetingComma",
  "conversation.id", "conversation.channel", "conversation.withinBusinessHours",
  "conversation.categoryName", "conversation.categoryCode",
  "bot.name", "bot.businessHours", "bot.withinBusinessHours",
  "bot.initialMessage", "bot.outsideHoursMessage", "bot.fallbackMessage", "bot.handoffMessage", "bot.categoryName",
]);
const SYSTEM_ROOTS = new Set(["contact", "conversation", "bot"]);
const FLOW_VARIABLES = Object.freeze(["flow.selectedOption", "flow.lastAnswer", "flow.lastMessage"]);
// Atalhos aceitos em Condições.
const PATH_ALIASES = Object.freeze({ channel: "conversation.channel", withinBusinessHours: "bot.withinBusinessHours" });

const CONDITION_OPERATORS = ["==", "!=", "contains", "not_contains", ">", "<", ">=", "<=", "exists", "not_exists"];
const ANSWER_TYPES = ["TEXT", "NUMBER", "EMAIL", "CPF_CNPJ", "PHONE", "YES_NO"];
const MEDIA_KINDS = ["IMAGE", "AUDIO", "VIDEO", "DOCUMENT"];
const DELAY_UNITS = { SECONDS: 1000, MINUTES: 60 * 1000, HOURS: 60 * 60 * 1000 };
const MAX_DELAY_MS = 24 * 60 * 60 * 1000;

// group/label/icon alimentam a biblioteca do editor. outputs: handles fixos;
// `dynamicOutputs` = handles derivados da config (opções do Menu).
// `terminal` = encerra a execução (ou troca de fluxo). `pauses` = espera algo
// externo (cliente/timer) — usado na detecção de loop infinito.
const NODE_TYPES = {
  start: { group: "FLUXO", label: "Início", icon: "▶", outputs: ["next"] },
  goto_flow: { group: "FLUXO", label: "Ir para fluxo", icon: "↪", outputs: [], terminal: true },
  end: { group: "FLUXO", label: "Finalizar", icon: "■", outputs: [], terminal: true },

  message: { group: "MENSAGENS", label: "Mensagem", icon: "💬", outputs: ["next"] },
  menu: { group: "MENSAGENS", label: "Menu", icon: "☰", outputs: ["invalid"], optionalOutputs: ["invalid"], dynamicOutputs: true, pauses: true },
  question: { group: "MENSAGENS", label: "Pergunta", icon: "❓", outputs: ["next", "invalid"], optionalOutputs: ["invalid"], pauses: true },
  media: { group: "MENSAGENS", label: "Mídia", icon: "🖼", outputs: ["next"] },

  condition: { group: "CONTROLE", label: "Condição", icon: "⋔", outputs: ["true", "false"] },
  delay: { group: "CONTROLE", label: "Intervalo", icon: "⏱", outputs: ["next"], pauses: true },

  variable: { group: "DADOS", label: "Variável", icon: "𝑥", outputs: ["next"] },

  transfer_category: { group: "ATENDIMENTO", label: "Transferir para setor", icon: "⇄", outputs: [], terminal: true },
  transfer_user: { group: "ATENDIMENTO", label: "Transferir para atendente", icon: "👤", outputs: [], terminal: true },
  human_handoff: { group: "ATENDIMENTO", label: "Solicitar humano", icon: "🙋", outputs: [], terminal: true },

  webhook: { group: "INTEGRAÇÕES", label: "Webhook/API", icon: "⚡", outputs: ["next", "error"], optionalOutputs: ["error"] },

  // Placeholder de nós que existiam no editor antigo (IA, Conhecimento,
  // Classificar intenção, Criar Lead, Atualizar contato): rascunhos antigos
  // continuam abrindo, mas o nó bloqueia a publicação até ser removido.
  removed: { group: null, label: "Nó removido", icon: "⚠", outputs: [], hidden: true },
};
const GROUP_ORDER = ["FLUXO", "MENSAGENS", "CONTROLE", "DADOS", "ATENDIMENTO", "INTEGRAÇÕES"];
const REMOVED_TYPES = new Set(["ai", "knowledge", "classify_intent", "create_lead", "update_contact"]);
const MEDIA_TYPE_ALIASES = { image: "IMAGE", audio: "AUDIO", video: "VIDEO", document: "DOCUMENT" };

function nodeTypeCatalog() {
  return Object.entries(NODE_TYPES).filter(([, meta]) => !meta.hidden).map(([type, meta]) => ({
    type, group: meta.group, label: meta.label, icon: meta.icon,
    outputs: meta.outputs, optionalOutputs: meta.optionalOutputs || [],
    dynamicOutputs: Boolean(meta.dynamicOutputs), terminal: Boolean(meta.terminal), available: true,
  })).sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
}

function badRequest(message, details) {
  return Object.assign(new Error(message), { statusCode: 400, details });
}

function text(value, max = MAX_TEXT) {
  if (value === undefined || value === null) return "";
  return String(value).slice(0, max);
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : fallback;
}

function attempts(value) {
  return Math.min(10, Math.max(1, Math.trunc(finiteNumber(value, 3))));
}

function menuOptionHandle(optionId) {
  return `opt:${optionId}`;
}

function outputHandles(node) {
  const meta = NODE_TYPES[node.type];
  if (!meta) return [];
  const handles = [...meta.outputs];
  if (meta.dynamicOutputs && node.type === "menu") {
    for (const option of node.config?.options || []) handles.unshift(menuOptionHandle(option.id));
  }
  return handles;
}

function requiredHandles(node) {
  const meta = NODE_TYPES[node.type];
  if (!meta || meta.terminal) return [];
  const optional = new Set(meta.optionalOutputs || []);
  return outputHandles(node).filter((handle) => !optional.has(handle));
}

function keyValueList(value, max = 20) {
  return (Array.isArray(value) ? value : []).slice(0, max).map((item) => ({ key: text(item?.key, 80), value: text(item?.value, 1000) }));
}

// ---- normalização (aplicada em todo save de draft) ------------------------
// Nunca confia no shape vindo do editor: corta tamanhos, descarta campos
// desconhecidos. Não valida regras de publicação — um draft pode estar
// incompleto.

function normalizeConfig(type, config = {}) {
  const c = config && typeof config === "object" ? config : {};
  switch (type) {
    case "start":
      return {
        initialMessage: text(c.initialMessage),
        channels: Array.isArray(c.channels) ? c.channels.map((item) => text(item, 40)).slice(0, 20) : [],
        categoryId: c.categoryId ? text(c.categoryId, 64) : null,
          trigger: ["NEW_CONVERSATION", "ANY_MESSAGE", "AFTER_TRIAGE"].includes(c.trigger) ? c.trigger : "NEW_CONVERSATION",
      };
    case "message":
      return {
        source: c.source === "LIBRARY" ? "LIBRARY" : "TEXT",
        text: text(c.text),
        responseKey: text(c.responseKey, 64),
      };
    case "question":
      return {
        text: text(c.text),
        variable: text(c.variable, 80) || "flow.lastAnswer",
        answerType: ANSWER_TYPES.includes(c.answerType) ? c.answerType : "TEXT",
        invalidMessage: text(c.invalidMessage, 1000),
        maxAttempts: attempts(c.maxAttempts),
      };
    case "menu":
      return {
        text: text(c.text),
        options: (Array.isArray(c.options) ? c.options : []).slice(0, MAX_MENU_OPTIONS).map((option, index) => ({
          id: NODE_KEY_PATTERN.test(String(option?.id || "")) ? String(option.id) : `o${index + 1}`,
          label: text(option?.label, 120),
          categoryId: typeof option?.categoryId === "string" ? text(option.categoryId, 100) : null,
          categoryIds: Array.isArray(option?.categoryIds) ? option.categoryIds.filter((id) => typeof id === "string").slice(0, 100) : [],
          keywords: (Array.isArray(option?.keywords) ? option.keywords : String(option?.keywords || "").split(","))
            .map((word) => text(word, 60).trim()).filter(Boolean).slice(0, 30),
        })),
        variable: text(c.variable, 80) || "flow.selectedOption",
        invalidMessage: text(c.invalidMessage, 1000),
        maxAttempts: attempts(c.maxAttempts),
        // LIST = lista interativa do WhatsApp (até 10 opções; acima disso, ou
        // fora do WhatsApp, cai automaticamente para texto numerado).
        display: c.display === "LIST" ? "LIST" : "TEXT",
        buttonLabel: text(c.buttonLabel, 20) || "Ver opções",
      };
    case "media":
      return {
        kind: MEDIA_KINDS.includes(c.kind) ? c.kind : "IMAGE",
        storageKey: STORAGE_KEY_PATTERN.test(String(c.storageKey || "")) ? String(c.storageKey) : "",
        mimeType: text(c.mimeType, 120),
        fileName: text(c.fileName, 200),
        caption: text(c.caption, 1000),
      };
    case "condition":
      return {
        match: c.match === "ANY" ? "ANY" : "ALL",
        rules: (Array.isArray(c.rules) ? c.rules : []).slice(0, 10).map((rule) => ({
          left: text(rule?.left, 80),
          operator: CONDITION_OPERATORS.includes(rule?.operator) ? rule.operator : "==",
          right: rule?.right === undefined || rule?.right === null ? "" : text(rule.right, 200),
        })),
      };
    case "delay":
      return {
        amount: Math.max(0, finiteNumber(c.amount, 5)),
        unit: Object.hasOwn(DELAY_UNITS, c.unit) ? c.unit : "SECONDS",
      };
    case "variable":
      return { assignments: keyValueList(c.assignments) };
    case "transfer_category":
      return { categoryId: c.categoryId ? text(c.categoryId, 64) : "", message: text(c.message), reason: text(c.reason, 500) };
    case "transfer_user":
      return {
        userId: c.userId ? text(c.userId, 64) : "", categoryId: c.categoryId ? text(c.categoryId, 64) : "",
        message: text(c.message), reason: text(c.reason, 500),
      };
    case "human_handoff":
      return { reason: text(c.reason, 500), categoryId: c.categoryId ? text(c.categoryId, 64) : "", message: text(c.message) };
    case "end":
      // Padrão: finaliza a conversa. Desligado, a conversa sai do Bot como
      // HANDOFF_BOT (visível para a equipe), nunca fica parada em "BOT".
      return { message: text(c.message), finalizeConversation: c.finalizeConversation !== false };
    case "goto_flow":
      return { flowId: c.flowId ? text(c.flowId, 64) : "" };
    case "webhook":
      // Nunca aceita URL/headers/segredos vindos do editor: o nó só
      // referencia um endpoint pré-cadastrado (bot-webhook-endpoint-service.js).
      return {
        endpointKey: text(c.endpointKey, 64),
        fields: keyValueList(c.fields),
        resultVariable: text(c.resultVariable, 80) || "vars.webhook",
      };
    case "removed":
      return { originalType: text(c.originalType, 40) };
    default:
      return {};
  }
}

// Converte tipos de versões antigas do editor: mídia separada -> "media";
// IA/Conhecimento/etc. -> "removed" (bloqueia publicação, nunca executa).
function migrateLegacyNode(raw) {
  if (MEDIA_TYPE_ALIASES[raw.type]) return { ...raw, type: "media", config: { ...(raw.config || {}), kind: MEDIA_TYPE_ALIASES[raw.type] } };
  if (REMOVED_TYPES.has(raw.type)) return { ...raw, type: "removed", config: { originalType: raw.type } };
  return raw;
}

function normalizeGraph(input) {
  const graph = input && typeof input === "object" ? input : {};
  const rawNodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const rawEdges = Array.isArray(graph.edges) ? graph.edges : [];
  if (rawNodes.length > MAX_NODES) throw badRequest(`O fluxo pode ter no máximo ${MAX_NODES} nós.`);
  if (rawEdges.length > MAX_EDGES) throw badRequest(`O fluxo pode ter no máximo ${MAX_EDGES} conexões.`);

  const nodes = [];
  const seen = new Set();
  for (const original of rawNodes) {
    const raw = original && typeof original === "object" ? migrateLegacyNode(original) : original;
    const key = String(raw?.key || "");
    if (!NODE_KEY_PATTERN.test(key)) throw badRequest("Identificador de nó inválido.");
    if (seen.has(key)) throw badRequest(`Nó duplicado: ${key}.`);
    if (!Object.hasOwn(NODE_TYPES, raw.type)) throw badRequest(`Tipo de nó desconhecido: ${String(raw.type).slice(0, 40)}.`);
    seen.add(key);
    nodes.push({
      key, type: raw.type,
      name: text(raw.name, 120) || NODE_TYPES[raw.type].label,
      x: finiteNumber(raw.x), y: finiteNumber(raw.y),
      config: normalizeConfig(raw.type, raw.config),
    });
  }
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const edges = [];
  const edgeIds = new Set();
  for (const raw of rawEdges) {
    const source = String(raw?.source || "");
    const target = String(raw?.target || "");
    const sourceHandle = String(raw?.sourceHandle || "next").slice(0, 80);
    if (!byKey.has(source) || !byKey.has(target)) continue;
    let id = String(raw?.id || `${source}:${sourceHandle}->${target}`).slice(0, 200);
    if (edgeIds.has(id)) id = `${id}#${edges.length}`;
    edgeIds.add(id);
    edges.push({ id, source, sourceHandle, target });
  }
  const viewport = graph.viewport && typeof graph.viewport === "object"
    ? { x: finiteNumber(graph.viewport.x), y: finiteNumber(graph.viewport.y), zoom: Math.min(2, Math.max(0.2, finiteNumber(graph.viewport.zoom, 1))) }
    : { x: 0, y: 0, zoom: 1 };
  return { nodes, edges, viewport };
}

function defaultGraph() {
  return {
    nodes: [
      { key: "start", type: "start", name: "Início", x: 80, y: 160, config: normalizeConfig("start") },
      { key: "end", type: "end", name: "Finalizar", x: 420, y: 160, config: normalizeConfig("end") },
    ],
    edges: [{ id: "start:next->end", source: "start", sourceHandle: "next", target: "end" }],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

// ---- variáveis ---------------------------------------------------------------

function isWritablePath(path) {
  if (!VARIABLE_PATH_PATTERN.test(path || "")) return false;
  const [root, ...rest] = path.split(".");
  return WRITABLE_ROOTS.has(root) && rest.length >= 1;
}

function resolveAlias(path) {
  return PATH_ALIASES[path] || path;
}

// "unknown" = variável que nunca pode existir (raiz desconhecida ou variável
// de sistema inexistente) -> erro. Variáveis graváveis (customer./vars./
// custom./flow.) lidas sem ninguém gravar no fluxo viram só AVISO — podem
// vir de outro fluxo (Ir para fluxo compartilha o contexto).
function classifyVariable(rawPath) {
  const path = resolveAlias(rawPath);
  if (!VARIABLE_PATH_PATTERN.test(path)) return "invalid";
  const root = path.split(".")[0];
  if (SYSTEM_ROOTS.has(root)) return SYSTEM_VARIABLES.includes(path) ? "system" : "unknown";
  if (WRITABLE_ROOTS.has(root)) return path.includes(".") ? "writable" : "invalid";
  return "unknown";
}

function templateVariables(template) {
  return [...String(template || "").matchAll(TEMPLATE_PATTERN)].map((match) => match[1]);
}

// Todos os textos com {{variáveis}} de um nó.
function nodeTemplates(node) {
  const c = node.config || {};
  switch (node.type) {
    case "start": return [c.initialMessage];
    case "message": return c.source === "LIBRARY" ? [] : [c.text];
    case "question": case "menu": return [c.text, c.invalidMessage];
    case "media": return [c.caption];
    case "variable": return (c.assignments || []).map((item) => item.value);
    case "transfer_category": case "transfer_user": case "human_handoff": return [c.message, c.reason];
    case "end": return [c.message];
    case "webhook": return (c.fields || []).map((item) => item.value);
    default: return [];
  }
}

// Variáveis que este nó GRAVA.
function nodeWrites(node) {
  const c = node.config || {};
  switch (node.type) {
    case "question": case "menu": return [c.variable];
    case "variable": return (c.assignments || []).map((item) => item.key);
    case "webhook": return [c.resultVariable];
    default: return [];
  }
}

// ---- validação de publicação ---------------------------------------------
// Devolve { valid, errors, warnings } — errors: [{ nodeKey|null, code,
// message }] bloqueiam a publicação; warnings só informam.

function tarjanCycles(nodes, adjacency) {
  let index = 0;
  const stack = [];
  const onStack = new Set();
  const indexes = new Map();
  const lows = new Map();
  const components = [];
  function strongConnect(key) {
    indexes.set(key, index); lows.set(key, index); index += 1;
    stack.push(key); onStack.add(key);
    for (const next of adjacency.get(key) || []) {
      if (!indexes.has(next)) { strongConnect(next); lows.set(key, Math.min(lows.get(key), lows.get(next))); }
      else if (onStack.has(next)) lows.set(key, Math.min(lows.get(key), indexes.get(next)));
    }
    if (lows.get(key) === indexes.get(key)) {
      const component = [];
      let item;
      do { item = stack.pop(); onStack.delete(item); component.push(item); } while (item !== key);
      const selfLoop = component.length === 1 && (adjacency.get(key) || []).includes(key);
      if (component.length > 1 || selfLoop) components.push(component);
    }
  }
  for (const node of nodes) if (!indexes.has(node.key)) strongConnect(node.key);
  return components;
}

function validateNodeConfig(node, refs) {
  const errors = [];
  const add = (code, message) => errors.push({ nodeKey: node.key, code, message });
  const c = node.config || {};
  switch (node.type) {
    case "removed":
      add("NODE_REMOVED", `Este nó (${c.originalType || "antigo"}) não existe mais — o Bot funciona sem IA. Exclua o nó e use Mensagem/Menu/Condição.`);
      break;
    case "message":
      if (c.source === "LIBRARY") {
        if (!c.responseKey) add("MISSING_RESPONSE", "Selecione a resposta da biblioteca.");
        else if (refs.responseKeys && !refs.responseKeys.has(c.responseKey)) add("RESPONSE_NOT_FOUND", `A resposta "${c.responseKey}" não existe ou está inativa.`);
      } else if (!c.text?.trim()) add("MISSING_TEXT", "Informe o texto da mensagem.");
      break;
    case "question":
      if (!c.text?.trim()) add("MISSING_TEXT", "Informe o texto da pergunta.");
      if (!isWritablePath(c.variable)) add("INVALID_VARIABLE", "A variável deve começar com customer., flow., vars. ou custom.");
      break;
    case "menu": {
      if (!c.text?.trim()) add("MISSING_TEXT", "Informe o texto do menu.");
      if ((c.options || []).length < 2) add("MENU_OPTIONS", "O menu precisa de pelo menos 2 opções.");
      const ids = new Set();
      for (const option of c.options || []) {
        if (!option.label?.trim()) add("MENU_OPTION_LABEL", "Toda opção do menu precisa de um nome.");
        if (ids.has(option.id)) add("MENU_OPTION_DUPLICATE", "Há opções do menu com o mesmo identificador.");
        ids.add(option.id);
      }
      if (!isWritablePath(c.variable)) add("INVALID_VARIABLE", "A variável deve começar com customer., flow., vars. ou custom.");
      break;
    }
    case "media":
      if (!c.storageKey) add("MISSING_MEDIA", "Envie o arquivo de mídia.");
      else if (refs.mediaKeys && !refs.mediaKeys.has(c.storageKey)) add("MEDIA_NOT_FOUND", "O arquivo de mídia não foi encontrado no servidor. Envie de novo.");
      break;
    case "condition":
      if (!(c.rules || []).length) add("CONDITION_RULES", "Adicione pelo menos uma regra.");
      for (const rule of c.rules || []) {
        const kind = classifyVariable(rule.left || "");
        if (kind === "invalid") add("CONDITION_LEFT", "Toda regra precisa de uma variável válida (ex.: flow.selectedOption).");
        else if (kind === "unknown") add("VARIABLE_NOT_FOUND", `Variável inexistente na condição: ${rule.left}.`);
        // == / != com valor vazio comparam com "vazio" (equivale a not_exists/exists).
        if (!["exists", "not_exists", "==", "!="].includes(rule.operator) && String(rule.right ?? "").trim() === "") {
          add("CONDITION_RIGHT", `Informe o valor para comparar em "${rule.left} ${rule.operator}".`);
        }
      }
      break;
    case "delay": {
      const ms = (c.amount || 0) * DELAY_UNITS[c.unit];
      if (!(ms > 0)) add("DELAY_AMOUNT", "Informe um intervalo maior que zero.");
      if (ms > MAX_DELAY_MS) add("DELAY_TOO_LONG", "O intervalo máximo é de 24 horas.");
      break;
    }
    case "variable":
      if (!(c.assignments || []).length) add("VARIABLE_ASSIGNMENTS", "Defina pelo menos uma variável.");
      for (const item of c.assignments || []) {
        if (!isWritablePath(item.key)) add("INVALID_VARIABLE", `Variável inválida "${item.key}" — use customer., flow., vars. ou custom.`);
      }
      break;
    case "transfer_category":
      if (!c.categoryId) add("MISSING_CATEGORY", "Selecione o setor de destino.");
      else if (refs.categoryIds && !refs.categoryIds.has(c.categoryId)) add("CATEGORY_NOT_FOUND", "O setor selecionado não existe ou está inativo.");
      break;
    case "transfer_user":
      if (!c.userId) add("MISSING_USER", "Selecione o atendente.");
      else if (refs.userIds && !refs.userIds.has(c.userId)) add("USER_NOT_FOUND", "O atendente selecionado não existe ou está inativo.");
      if (c.categoryId && refs.categoryIds && !refs.categoryIds.has(c.categoryId)) add("CATEGORY_NOT_FOUND", "O setor selecionado não existe ou está inativo.");
      break;
    case "human_handoff":
      if (c.categoryId && refs.categoryIds && !refs.categoryIds.has(c.categoryId)) add("CATEGORY_NOT_FOUND", "O setor selecionado não existe ou está inativo.");
      break;
    case "start":
      if (c.categoryId && refs.categoryIds && !refs.categoryIds.has(c.categoryId)) add("CATEGORY_NOT_FOUND", "A categoria inicial não existe ou está inativa.");
      break;
    case "goto_flow":
      if (!c.flowId) add("MISSING_FLOW", "Selecione o fluxo de destino.");
      else if (refs.currentFlowId && c.flowId === refs.currentFlowId) add("GOTO_SELF", "Um fluxo não pode ir para ele mesmo — use uma conexão.");
      else if (refs.flowIds && !refs.flowIds.has(c.flowId)) add("FLOW_NOT_FOUND", "O fluxo referenciado não existe neste Bot.");
      break;
    case "webhook":
      if (!c.endpointKey) add("MISSING_ENDPOINT", "Selecione o endpoint cadastrado.");
      else if (refs.webhookKeys && !refs.webhookKeys.has(c.endpointKey)) add("ENDPOINT_NOT_FOUND", `O endpoint "${c.endpointKey}" não existe ou está inativo.`);
      if (!isWritablePath(c.resultVariable)) add("INVALID_VARIABLE", "Salve o resultado em customer., flow., vars. ou custom.");
      for (const field of c.fields || []) if (!/^[A-Za-z0-9_.-]{1,80}$/.test(field.key)) add("WEBHOOK_FIELD", `Nome de campo inválido: "${field.key}".`);
      break;
    default:
      break;
  }
  for (const template of nodeTemplates(node)) {
    for (const path of templateVariables(template)) {
      if (classifyVariable(path) === "unknown") add("VARIABLE_NOT_FOUND", `Variável inexistente: {{${path}}}.`);
    }
  }
  return errors;
}

function validateGraph(graphInput, refs = {}) {
  const graph = normalizeGraph(graphInput);
  const errors = [];
  const warnings = [];
  const starts = graph.nodes.filter((node) => node.type === "start");
  if (starts.length === 0) errors.push({ nodeKey: null, code: "NO_START", message: "O fluxo precisa de um nó Início." });
  if (starts.length > 1) for (const node of starts.slice(1)) errors.push({ nodeKey: node.key, code: "MULTIPLE_START", message: "O fluxo só pode ter um nó Início." });

  const byKey = new Map(graph.nodes.map((node) => [node.key, node]));
  const adjacency = new Map(graph.nodes.map((node) => [node.key, []]));
  const usedHandles = new Map();

  for (const edge of graph.edges) {
    const source = byKey.get(edge.source);
    if (!outputHandles(source).includes(edge.sourceHandle)) {
      errors.push({ nodeKey: source.key, code: "INVALID_EDGE", message: `Conexão saindo de uma saída inexistente (${edge.sourceHandle}).` });
      continue;
    }
    if (byKey.get(edge.target).type === "start") {
      errors.push({ nodeKey: edge.target, code: "EDGE_TO_START", message: "Nenhuma conexão pode entrar no nó Início." });
    }
    const handleKey = `${edge.source}::${edge.sourceHandle}`;
    if (usedHandles.has(handleKey)) errors.push({ nodeKey: source.key, code: "DUPLICATE_OUTPUT", message: "Cada saída pode ter só uma conexão." });
    usedHandles.set(handleKey, edge.target);
    adjacency.get(edge.source).push(edge.target);
  }

  const written = new Set(FLOW_VARIABLES);
  for (const node of graph.nodes) for (const path of nodeWrites(node)) if (path) written.add(path);

  for (const node of graph.nodes) {
    errors.push(...validateNodeConfig(node, refs));
    for (const handle of requiredHandles(node)) {
      if (!usedHandles.has(`${node.key}::${handle}`)) {
        const label = handle.startsWith("opt:")
          ? `a opção "${node.config.options.find((option) => menuOptionHandle(option.id) === handle)?.label || handle}"`
          : `a saída "${handle.toUpperCase()}"`;
        errors.push({ nodeKey: node.key, code: node.type === "menu" ? "MENU_OUTPUT_MISSING" : (node.type === "condition" ? "CONDITION_OUTPUT_MISSING" : "OUTPUT_MISSING"), message: `Conecte ${label}.` });
      }
    }
    const reads = [...nodeTemplates(node).flatMap(templateVariables), ...(node.type === "condition" ? (node.config.rules || []).map((rule) => rule.left) : [])];
    const warned = new Set();
    for (const path of reads.map(resolveAlias)) {
      if (warned.has(path) || classifyVariable(path) !== "writable" || written.has(path)) continue;
      if ([...written].some((item) => path.startsWith(`${item}.`))) continue; // ex.: vars.webhook.data.status
      warned.add(path);
      warnings.push({ nodeKey: node.key, code: "VARIABLE_NEVER_SET", message: `Nenhum nó deste fluxo preenche ${path} (ok se vier de outro fluxo).` });
    }
  }

  if (starts.length) {
    const reachable = new Set([starts[0].key]);
    const queue = [starts[0].key];
    while (queue.length) {
      for (const next of adjacency.get(queue.shift()) || []) {
        if (!reachable.has(next)) { reachable.add(next); queue.push(next); }
      }
    }
    for (const node of graph.nodes) {
      if (!reachable.has(node.key)) errors.push({ nodeKey: node.key, code: "UNREACHABLE", message: "Nó desconectado — não é alcançado a partir do Início." });
    }
  }

  for (const component of tarjanCycles(graph.nodes, adjacency)) {
    if (!component.some((key) => NODE_TYPES[byKey.get(key).type].pauses)) {
      for (const key of component) errors.push({ nodeKey: key, code: "INFINITE_LOOP", message: "Este nó faz parte de um ciclo sem pergunta/menu/intervalo — loop infinito." });
    }
  }

  return { valid: errors.length === 0, errors, warnings, graph };
}

module.exports = {
  ANSWER_TYPES, CONDITION_OPERATORS, DELAY_UNITS, FLOW_VARIABLES, MAX_DELAY_MS, MAX_MENU_OPTIONS, MEDIA_KINDS, NODE_TYPES,
  PATH_ALIASES, STORAGE_KEY_PATTERN, SYSTEM_VARIABLES, VARIABLE_PATH_PATTERN, WRITABLE_ROOTS,
  classifyVariable, defaultGraph, isWritablePath, menuOptionHandle, nodeTypeCatalog, normalizeConfig, normalizeGraph,
  outputHandles, validateGraph,
};
