// Flow Builder (Editor Visual): shape do grafo, registry de tipos de nó e
// validação de publicação. Puro, sem I/O — as checagens que dependem do
// banco (categoria/usuário/fluxo existentes) recebem os ids válidos prontos
// em `refs` (ver bot-visual-flow-service.js#loadValidationRefs).
//
// Grafo salvo em BotFlow.draftGraph / BotFlowVersion.graph:
//   { nodes: [{ key, type, name, x, y, config }],
//     edges: [{ id, source, sourceHandle, target }],
//     viewport: { x, y, zoom } }
//
// Adicionar um tipo novo = registrar mais um item em NODE_TYPES (e um
// handler em bot-visual-flow-engine.js). `available: false` aparece na
// biblioteca como "em breve" e bloqueia a publicação se usado.

const MAX_NODES = 300;
const MAX_EDGES = 900;
const MAX_TEXT = 4000;
const NODE_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const VARIABLE_PATH_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*){0,4}$/;
// Raízes do contexto que um nó pode ESCREVER (Pergunta/Variável). contact/
// conversation/bot/knowledge são preenchidos só pelo motor.
const WRITABLE_ROOTS = new Set(["customer", "flow", "vars"]);

const CONDITION_OPERATORS = ["==", "!=", "contains", "not_contains", ">", "<", ">=", "<=", "exists", "not_exists"];
const ANSWER_TYPES = ["TEXT", "NUMBER", "EMAIL", "CPF_CNPJ", "PHONE"];
const DELAY_UNITS = { SECONDS: 1000, MINUTES: 60 * 1000, HOURS: 60 * 60 * 1000 };
const MAX_DELAY_MS = 24 * 60 * 60 * 1000;
const AI_MODES = ["UNDERSTAND", "RESPOND", "CLASSIFY", "EXTRACT", "DECIDE"];
const AI_PROVIDERS = ["LOCAL_QWEN"];

// group/label/icon alimentam a biblioteca do editor (GET .../flow-node-types).
// outputs: lista fixa de handles; `dynamicOutputs` = handles derivados da
// config (opções do Menu). `terminal` = nó sem saída (encerra a execução).
// `pauses` = nó que espera algo externo (cliente/timer) — usado na detecção
// de loop infinito.
const NODE_TYPES = {
  start: { group: "FLUXO", label: "Início", icon: "▶", outputs: ["next"], available: true },
  end: { group: "FLUXO", label: "Finalizar", icon: "■", outputs: [], terminal: true, available: true },
  goto_flow: { group: "FLUXO", label: "Ir para fluxo", icon: "↪", outputs: [], terminal: true, available: false },

  message: { group: "MENSAGENS", label: "Mensagem de texto", icon: "💬", outputs: ["next"], available: true },
  question: { group: "MENSAGENS", label: "Pergunta", icon: "❓", outputs: ["next", "invalid"], optionalOutputs: ["invalid"], pauses: true, available: true },
  menu: { group: "MENSAGENS", label: "Menu", icon: "☰", outputs: ["invalid"], optionalOutputs: ["invalid"], dynamicOutputs: true, pauses: true, available: true },

  image: { group: "MÍDIA", label: "Imagem", icon: "🖼", outputs: ["next"], available: false },
  audio: { group: "MÍDIA", label: "Áudio", icon: "🎧", outputs: ["next"], available: false },
  video: { group: "MÍDIA", label: "Vídeo", icon: "🎬", outputs: ["next"], available: false },
  document: { group: "MÍDIA", label: "Documento", icon: "📄", outputs: ["next"], available: false },

  delay: { group: "CONTROLE", label: "Intervalo", icon: "⏱", outputs: ["next"], pauses: true, available: true },
  condition: { group: "CONTROLE", label: "Condição", icon: "⋔", outputs: ["true", "false"], available: true },
  variable: { group: "CONTROLE", label: "Variável", icon: "𝑥", outputs: ["next"], available: true },

  ai: { group: "BOT / IA", label: "IA", icon: "✦", outputs: ["next", "handoff", "error"], optionalOutputs: ["handoff", "error"], available: true },
  knowledge: { group: "BOT / IA", label: "Consultar conhecimento", icon: "📚", outputs: ["found", "not_found"], optionalOutputs: ["not_found"], available: true },
  classify_intent: { group: "BOT / IA", label: "Classificar intenção", icon: "🏷", outputs: ["next"], available: false },

  transfer_category: { group: "ATENDIMENTO", label: "Transferir para setor", icon: "⇄", outputs: [], terminal: true, available: true },
  transfer_user: { group: "ATENDIMENTO", label: "Transferir para atendente", icon: "👤", outputs: [], terminal: true, available: false },
  human_handoff: { group: "ATENDIMENTO", label: "Solicitar atendimento humano", icon: "🙋", outputs: [], terminal: true, available: true },

  webhook: { group: "INTEGRAÇÕES", label: "Webhook/API", icon: "⚡", outputs: ["next", "error"], available: false },
  create_lead: { group: "INTEGRAÇÕES", label: "Criar Lead", icon: "➕", outputs: ["next", "error"], available: false },
  update_contact: { group: "INTEGRAÇÕES", label: "Atualizar contato", icon: "✎", outputs: ["next"], available: false },
};

function nodeTypeCatalog() {
  return Object.entries(NODE_TYPES).map(([type, meta]) => ({
    type, group: meta.group, label: meta.label, icon: meta.icon,
    outputs: meta.outputs, optionalOutputs: meta.optionalOutputs || [],
    dynamicOutputs: Boolean(meta.dynamicOutputs), terminal: Boolean(meta.terminal),
    available: meta.available,
  }));
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

function menuOptionHandle(optionId) {
  return `opt:${optionId}`;
}

// Handles de saída válidos para um nó (inclui os dinâmicos do Menu).
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

// ---- normalização (aplicada em todo save de draft) ------------------------
// Nunca confia no shape vindo do editor: corta tamanhos, descarta campos
// desconhecidos e tipos inexistentes. Não valida regras de publicação — um
// draft pode estar incompleto.

function normalizeConfig(type, config = {}) {
  const c = config && typeof config === "object" ? config : {};
  switch (type) {
    case "start":
      return {
        initialMessage: text(c.initialMessage),
        channels: Array.isArray(c.channels) ? c.channels.map((item) => text(item, 40)).slice(0, 20) : [],
        categoryId: c.categoryId ? text(c.categoryId, 64) : null,
        trigger: ["NEW_CONVERSATION", "ANY_MESSAGE"].includes(c.trigger) ? c.trigger : "NEW_CONVERSATION",
      };
    case "message":
      return { text: text(c.text) };
    case "question":
      return {
        text: text(c.text),
        variable: text(c.variable, 80) || "flow.lastAnswer",
        answerType: ANSWER_TYPES.includes(c.answerType) ? c.answerType : "TEXT",
        invalidMessage: text(c.invalidMessage, 1000),
        maxAttempts: Math.min(10, Math.max(1, Math.trunc(finiteNumber(c.maxAttempts, 3)))),
      };
    case "menu":
      return {
        text: text(c.text),
        options: (Array.isArray(c.options) ? c.options : []).slice(0, 20).map((option, index) => ({
          id: NODE_KEY_PATTERN.test(String(option?.id || "")) ? String(option.id) : `o${index + 1}`,
          label: text(option?.label, 120),
          keywords: (Array.isArray(option?.keywords) ? option.keywords : String(option?.keywords || "").split(","))
            .map((word) => text(word, 60).trim()).filter(Boolean).slice(0, 20),
        })),
        variable: text(c.variable, 80) || "flow.selectedOption",
        invalidMessage: text(c.invalidMessage, 1000),
        maxAttempts: Math.min(10, Math.max(1, Math.trunc(finiteNumber(c.maxAttempts, 3)))),
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
      return {
        assignments: (Array.isArray(c.assignments) ? c.assignments : []).slice(0, 20).map((item) => ({
          key: text(item?.key, 80), value: text(item?.value, 1000),
        })),
      };
    case "ai":
      return {
        mode: AI_MODES.includes(c.mode) ? c.mode : "UNDERSTAND",
        provider: AI_PROVIDERS.includes(c.provider) ? c.provider : "LOCAL_QWEN",
        model: text(c.model, 80),
        input: text(c.input, 500) || "{{flow.lastMessage}}",
        sendAnswer: c.sendAnswer === true,
      };
    case "knowledge":
      return {
        query: text(c.query, 500) || "{{flow.lastMessage}}",
        product: text(c.product, 120),
        limit: Math.min(10, Math.max(1, Math.trunc(finiteNumber(c.limit, 3)))),
      };
    case "transfer_category":
      return { categoryId: c.categoryId ? text(c.categoryId, 64) : "", message: text(c.message), reason: text(c.reason, 500) };
    case "transfer_user":
      return { userId: c.userId ? text(c.userId, 64) : "", shareHistory: c.shareHistory !== false, message: text(c.message) };
    case "human_handoff":
      return { reason: text(c.reason, 500), categoryId: c.categoryId ? text(c.categoryId, 64) : "", message: text(c.message) };
    case "end":
      // Padrão: finaliza a conversa. Desligado, a conversa sai do Bot como
      // HANDOFF_BOT (visível para a equipe), nunca fica parada em "BOT".
      return { message: text(c.message), finalizeConversation: c.finalizeConversation !== false };
    case "goto_flow":
      return { flowId: c.flowId ? text(c.flowId, 64) : "" };
    case "webhook":
      // Nunca aceita headers/segredos vindos do editor: o nó só referencia
      // um endpoint pré-cadastrado no backend (`endpointKey`), que resolve
      // URL/credenciais do lado do servidor (item de segurança).
      return {
        endpointKey: text(c.endpointKey, 80), method: ["GET", "POST"].includes(c.method) ? c.method : "POST",
        body: text(c.body, 2000), timeoutMs: Math.min(15000, Math.max(500, Math.trunc(finiteNumber(c.timeoutMs, 5000)))),
      };
    case "create_lead":
      return Object.fromEntries(["source", "name", "phone", "email", "cpf", "cnpj", "product", "interest", "quantity", "notes"]
        .map((field) => [field, text(c[field], 500)]).concat([["includeSummary", c.includeSummary !== false]]));
    case "update_contact":
      return { name: text(c.name, 200), email: text(c.email, 200) };
    case "image": case "audio": case "video": case "document":
      return { mediaUrl: text(c.mediaUrl, 1000), caption: text(c.caption, 1000) };
    case "classify_intent":
      return {};
    default:
      return {};
  }
}

function normalizeGraph(input) {
  const graph = input && typeof input === "object" ? input : {};
  const rawNodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const rawEdges = Array.isArray(graph.edges) ? graph.edges : [];
  if (rawNodes.length > MAX_NODES) throw badRequest(`O fluxo pode ter no máximo ${MAX_NODES} nós.`);
  if (rawEdges.length > MAX_EDGES) throw badRequest(`O fluxo pode ter no máximo ${MAX_EDGES} conexões.`);

  const nodes = [];
  const seen = new Set();
  for (const raw of rawNodes) {
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
    // Conexão para nó inexistente é descartada no save (o editor pode
    // mandar uma aresta pendurada depois de apagar um nó).
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

// ---- validação de publicação ---------------------------------------------
// Devolve { valid, errors: [{ nodeKey|null, code, message }] } — o editor
// pinta cada erro no nó correspondente.

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
  const meta = NODE_TYPES[node.type];
  if (!meta.available) add("NODE_NOT_AVAILABLE", `"${meta.label}" ainda não está disponível nesta versão — remova o nó para publicar.`);
  switch (node.type) {
    case "message":
      if (!c.text?.trim()) add("MISSING_TEXT", "Informe o texto da mensagem.");
      break;
    case "question":
      if (!c.text?.trim()) add("MISSING_TEXT", "Informe o texto da pergunta.");
      if (!isWritablePath(c.variable)) add("INVALID_VARIABLE", "A variável deve começar com customer., flow. ou vars.");
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
      if (!isWritablePath(c.variable)) add("INVALID_VARIABLE", "A variável deve começar com customer., flow. ou vars.");
      break;
    }
    case "condition":
      if (!(c.rules || []).length) add("CONDITION_RULES", "Adicione pelo menos uma regra.");
      for (const rule of c.rules || []) {
        if (!VARIABLE_PATH_PATTERN.test(rule.left || "")) add("CONDITION_LEFT", "Toda regra precisa de uma variável válida (ex.: bot.intent).");
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
        if (!isWritablePath(item.key)) add("INVALID_VARIABLE", `Variável inválida "${item.key}" — use customer., flow. ou vars.`);
      }
      break;
    case "transfer_category":
      if (!c.categoryId) add("MISSING_CATEGORY", "Selecione o setor de destino.");
      else if (refs.categoryIds && !refs.categoryIds.has(c.categoryId)) add("CATEGORY_NOT_FOUND", "O setor selecionado não existe ou está inativo.");
      break;
    case "human_handoff":
      if (c.categoryId && refs.categoryIds && !refs.categoryIds.has(c.categoryId)) add("CATEGORY_NOT_FOUND", "O setor selecionado não existe ou está inativo.");
      break;
    case "start":
      if (c.categoryId && refs.categoryIds && !refs.categoryIds.has(c.categoryId)) add("CATEGORY_NOT_FOUND", "A categoria inicial não existe ou está inativa.");
      break;
    case "transfer_user":
      if (!c.userId) add("MISSING_USER", "Selecione o atendente.");
      else if (refs.userIds && !refs.userIds.has(c.userId)) add("USER_NOT_FOUND", "O atendente selecionado não existe ou está inativo.");
      break;
    case "goto_flow":
      if (!c.flowId) add("MISSING_FLOW", "Selecione o fluxo de destino.");
      else if (refs.flowIds && !refs.flowIds.has(c.flowId)) add("FLOW_NOT_FOUND", "O fluxo referenciado não existe.");
      break;
    default:
      break;
  }
  return errors;
}

function isWritablePath(path) {
  if (!VARIABLE_PATH_PATTERN.test(path || "")) return false;
  const [root, ...rest] = path.split(".");
  return WRITABLE_ROOTS.has(root) && rest.length >= 1;
}

function validateGraph(graphInput, refs = {}) {
  const graph = normalizeGraph(graphInput);
  const errors = [];
  const starts = graph.nodes.filter((node) => node.type === "start");
  if (starts.length === 0) errors.push({ nodeKey: null, code: "NO_START", message: "O fluxo precisa de um nó Início." });
  if (starts.length > 1) for (const node of starts.slice(1)) errors.push({ nodeKey: node.key, code: "MULTIPLE_START", message: "O fluxo só pode ter um nó Início." });

  const byKey = new Map(graph.nodes.map((node) => [node.key, node]));
  const adjacency = new Map(graph.nodes.map((node) => [node.key, []]));
  const incoming = new Map(graph.nodes.map((node) => [node.key, 0]));
  const usedHandles = new Map();

  for (const edge of graph.edges) {
    const source = byKey.get(edge.source);
    const handles = outputHandles(source);
    if (!handles.includes(edge.sourceHandle)) {
      errors.push({ nodeKey: source.key, code: "INVALID_EDGE", message: `Conexão saindo de uma saída inexistente (${edge.sourceHandle}).` });
      continue;
    }
    if (byKey.get(edge.target).type === "start") {
      errors.push({ nodeKey: edge.target, code: "EDGE_TO_START", message: "Nenhuma conexão pode entrar no nó Início." });
    }
    const handleKey = `${edge.source}::${edge.sourceHandle}`;
    if (usedHandles.has(handleKey)) {
      errors.push({ nodeKey: source.key, code: "DUPLICATE_OUTPUT", message: "Cada saída pode ter só uma conexão." });
    }
    usedHandles.set(handleKey, edge.target);
    adjacency.get(edge.source).push(edge.target);
    incoming.set(edge.target, incoming.get(edge.target) + 1);
  }

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
  }

  // Nós inalcançáveis a partir do Início (desconectados).
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

  // Loop infinito óbvio: ciclo sem nenhum nó que espere o cliente/timer.
  for (const component of tarjanCycles(graph.nodes, adjacency)) {
    if (!component.some((key) => NODE_TYPES[byKey.get(key).type].pauses)) {
      for (const key of component) errors.push({ nodeKey: key, code: "INFINITE_LOOP", message: "Este nó faz parte de um ciclo sem pergunta/menu/intervalo — loop infinito." });
    }
  }

  return { valid: errors.length === 0, errors, graph };
}

module.exports = {
  ANSWER_TYPES, CONDITION_OPERATORS, DELAY_UNITS, MAX_DELAY_MS, NODE_TYPES, VARIABLE_PATH_PATTERN,
  defaultGraph, isWritablePath, menuOptionHandle, nodeTypeCatalog, normalizeConfig, normalizeGraph,
  outputHandles, validateGraph,
};
