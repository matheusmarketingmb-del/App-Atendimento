// Flow Builder — motor de execução do grafo visual (BotFlowVersion.graph).
// 100% determinístico: nenhum nó chama IA.
//
// Executa nó a nó a partir do estado salvo, nunca o fluxo inteiro de uma
// vez: roda até encontrar um nó que ESPERA (Pergunta/Menu = cliente,
// Intervalo = timer) ou um nó terminal (Transferir/Humano/Finalizar), e
// devolve o novo estado para ser persistido. Uma nova mensagem (ou o
// worker do timer) chama runTurn de novo com o estado salvo.
//
// "Ir para fluxo" troca o grafo em execução no mesmo turno (o contexto/
// variáveis seguem junto) — o estado devolvido carrega o fluxo atual em
// `state.flow` para o serviço persistir.
//
// Todo efeito colateral (enviar texto/mídia/menu, transferir, finalizar,
// carregar outro fluxo, chamar webhook) passa pelo `adapter` — o motor em si
// é puro. Dois adapters existem em bot-visual-flow-service.js: o real
// (conversa de verdade) e o de simulação (dry-run, nunca envia nada).

const { normalizeText } = require("./bot-schedule-utils");
const {
  DELAY_UNITS, NODE_TYPES, PATH_ALIASES, isWritablePath, menuOptionHandle, normalizeGraph,
} = require("./bot-visual-flow-graph");

const MAX_STEPS_PER_TURN = 50;
const MAX_FLOW_JUMPS_PER_TURN = 5;
const MENU_REPLY_PREFIX = "flow_opt:";
const DEFAULT_INVALID_MESSAGE = "Não consegui entender sua resposta. Pode tentar de novo?";
const DEFAULT_YES_NO_INVALID_MESSAGE = "Responda com SIM ou NÃO, por favor.";
const DEFAULT_MENU_INVALID_MESSAGE = "Não reconheci a opção. Responda com o número ou o nome de uma das opções:";

const STATUS = Object.freeze({
  RUNNING: "RUNNING", WAITING_CUSTOMER: "WAITING_CUSTOMER", WAITING_TIMER: "WAITING_TIMER",
  HANDED_OFF: "HANDED_OFF", COMPLETED: "COMPLETED", FAILED: "FAILED",
});
const FINISHED_STATUSES = new Set([STATUS.HANDED_OFF, STATUS.COMPLETED, STATUS.FAILED]);

// ---- contexto / variáveis --------------------------------------------------

function getPath(context, path) {
  const resolved = PATH_ALIASES[path] || path;
  let value = context;
  for (const part of String(resolved || "").split(".")) {
    if (value === null || value === undefined || typeof value !== "object") return undefined;
    if (!Object.hasOwn(value, part)) return undefined;
    value = value[part];
  }
  return value;
}

function setPath(context, path, value) {
  if (!isWritablePath(path)) return false;
  const parts = path.split(".");
  let target = context;
  for (const part of parts.slice(0, -1)) {
    if (!target[part] || typeof target[part] !== "object" || Array.isArray(target[part])) target[part] = {};
    target = target[part];
  }
  target[parts.at(-1)] = value;
  return true;
}

function renderTemplate(template, context, depth = 0) {
  return String(template || "").replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g, (_match, path) => {
    const value = getPath(context, path);
    if (value === undefined || value === null) return "";
    const rendered = typeof value === "object" ? JSON.stringify(value) : String(value);
    return depth < 3 && rendered.includes("{{") ? renderTemplate(rendered, context, depth + 1) : rendered;
  });
}

function baseContext(seed = {}) {
  return {
    contact: { ...(seed.contact || {}) },
    conversation: { ...(seed.conversation || {}) },
    bot: { ...(seed.bot || {}) },
    flow: { ...(seed.flow || {}) }, customer: {}, vars: {}, custom: {},
    _engine: { attempts: {}, visited: [] },
  };
}

// ---- condição ----------------------------------------------------------------

function parseLiteral(raw) {
  const value = String(raw ?? "").trim();
  if (value === "" || value === "null") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value.replace(/^["']|["']$/g, "");
}

function compareRule(context, rule) {
  const left = getPath(context, rule.left);
  const right = parseLiteral(rule.right);
  const present = left !== undefined && left !== null && left !== "";
  const leftText = normalizeText(left);
  const rightText = normalizeText(right);
  switch (rule.operator) {
    case "exists": return present;
    case "not_exists": return !present;
    case "==":
      if (right === null) return !present;
      if (typeof right === "boolean") return left === right || leftText === String(right);
      return leftText === rightText;
    case "!=":
      if (right === null) return present;
      if (typeof right === "boolean") return !(left === right || leftText === String(right));
      return leftText !== rightText;
    case "contains": return present && leftText.includes(rightText);
    case "not_contains": return !present || !leftText.includes(rightText);
    case ">": case "<": case ">=": case "<=": {
      const a = Number(left); const b = Number(right);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
      if (rule.operator === ">") return a > b;
      if (rule.operator === "<") return a < b;
      if (rule.operator === ">=") return a >= b;
      return a <= b;
    }
    default: return false;
  }
}

function evaluateCondition(config, context) {
  const rules = config.rules || [];
  if (!rules.length) return false;
  return config.match === "ANY" ? rules.some((rule) => compareRule(context, rule)) : rules.every((rule) => compareRule(context, rule));
}

// ---- respostas do cliente --------------------------------------------------

const YES_WORDS = new Set(["sim", "s", "yes", "y", "claro", "ok", "pode", "isso", "positivo", "certo", "resolveu", "funcionou", "1"]);
const NO_WORDS = new Set(["nao", "n", "no", "negativo", "nunca", "nao resolveu", "nao funcionou", "2"]);

// Validação por formato (dígito verificador de CPF/CNPJ pode entrar depois
// sem mudar a interface).
const ANSWER_VALIDATORS = {
  TEXT: (value) => (value.trim() ? value.trim() : null),
  NUMBER: (value) => {
    const match = value.trim().replace(",", ".").match(/^-?\d+(\.\d+)?$/);
    return match ? Number(match[0]) : null;
  },
  EMAIL: (value) => (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim()) ? value.trim().toLowerCase() : null),
  CPF_CNPJ: (value) => {
    const digits = value.replace(/\D/g, "");
    return digits.length === 11 || digits.length === 14 ? digits : null;
  },
  PHONE: (value) => {
    const digits = value.replace(/\D/g, "");
    return digits.length >= 10 && digits.length <= 13 ? digits : null;
  },
  YES_NO: (value) => {
    const normalized = normalizeText(value).replace(/[!?.,;:]+/g, " ").replace(/\s+/g, " ").trim();
    if (YES_WORDS.has(normalized) || YES_WORDS.has(normalized.split(" ")[0])) return true;
    if (NO_WORDS.has(normalized) || NO_WORDS.has(normalized.split(" ")[0])) return false;
    return null;
  },
};

function validateAnswer(answerType, value) {
  return (ANSWER_VALIDATORS[answerType] || ANSWER_VALIDATORS.TEXT)(String(value || ""));
}

// Aceita clique na lista do WhatsApp (replyId), "2", "opção 2", "suporte",
// "quero suporte" ou um sinônimo cadastrado — nunca chama IA. Só escolhe por
// conteúdo quando exatamente UMA opção bate (evita chute).
function matchMenuOption(options, input, replyId = null) {
  if (replyId && String(replyId).startsWith(MENU_REPLY_PREFIX)) {
    const byReply = options.find((option) => option.id === String(replyId).slice(MENU_REPLY_PREFIX.length));
    if (byReply) return byReply;
  }
  const normalized = normalizeText(input).replace(/[!?.,;:]+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  const numberMatch = normalized.match(/^(?:opcao|op|numero|n)?\s*(\d{1,2})(?:\s|$)/);
  if (numberMatch) {
    const option = options[Number(numberMatch[1]) - 1];
    if (option) return option;
  }
  const termsFor = (option) => [option.label, ...(option.keywords || [])].map((term) => normalizeText(term)).filter(Boolean);
  const exact = options.filter((option) => termsFor(option).includes(normalized));
  if (exact.length === 1) return exact[0];
  const padded = ` ${normalized} `;
  const partial = options.filter((option) => termsFor(option).some((term) => padded.includes(` ${term} `)));
  return partial.length === 1 ? partial[0] : null;
}

function renderMenuText(config, context) {
  const lines = (config.options || []).map((option, index) => `${index + 1} - ${option.label}`);
  return [renderTemplate(config.text, context), ...lines].filter(Boolean).join("\n");
}

// ---- log sanitizado -----------------------------------------------------------

const SECRET_KEY_PATTERN = /secret|token|password|senha|authorization|api[-_]?key|cookie/i;

function sanitizeForLog(value, depth = 0) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string") return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  if (typeof value !== "object") return value;
  if (depth > 4) return "[…]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeForLog(item, depth + 1));
  return Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith("_")).map(([key, item]) => (
    [key, SECRET_KEY_PATTERN.test(key) ? "[redacted]" : sanitizeForLog(item, depth + 1)]
  )));
}

// ---- handlers por tipo ---------------------------------------------------------
// execute(node, run) -> { branch } | { wait: "CUSTOMER" } | { wait: "TIMER", resumeAt }
//                       | { terminal: STATUS } | { goto: flowId }
// resume(node, run, input) (só nós que esperam o cliente) -> { branch } | { stay: true } | { terminal }

async function retryOrFail(node, run, invalidText, repeatText) {
  const { context } = run;
  const attempts = (context._engine.attempts[node.key] || 0) + 1;
  context._engine.attempts[node.key] = attempts;
  if (attempts >= node.config.maxAttempts) {
    delete context._engine.attempts[node.key];
    if (run.hasEdge(node.key, "invalid")) return { branch: "invalid", output: { attempts, exhausted: true } };
    // Sem saída "inválida" conectada: nunca prende o cliente num loop —
    // entrega para humano com o motivo registrado.
    await run.adapter.handoff({ reason: `Resposta inválida após ${attempts} tentativas em "${node.name}".`, message: renderTemplate(context.bot.fallbackMessage, context), categoryId: context.flow.initialCategoryId || null });
    return { terminal: STATUS.HANDED_OFF, output: { attempts, exhausted: true } };
  }
  await run.adapter.send([invalidText, repeatText].filter(Boolean).join("\n"));
  return { stay: true, output: { attempts } };
}

async function sendMenu(node, run) {
  node = effectiveMenu(node, run.context);
  if (run.context.bot.assistantAfterTriage && !String(node.config.variable || "").startsWith("flow.rating") && node.config.options.length < 10) {
    node = { ...node, config: { ...node.config, options: [...node.config.options, { id: "assistant_back", label: "Voltar" }] } };
  }
  if (!node.config.options.length) throw new Error("Nenhuma opção disponível para este número.");
  const textToSend = renderMenuText(node.config, run.context);
  if (node.config.display === "LIST" && run.adapter.sendMenu) {
    await run.adapter.sendMenu({
      text: renderTemplate(node.config.text, run.context), fallbackText: textToSend, buttonLabel: node.config.buttonLabel,
      options: node.config.options.map((option) => ({ replyId: `${MENU_REPLY_PREFIX}${option.id}`, label: option.label })),
    });
  } else {
    await run.adapter.send(textToSend);
  }
}

function effectiveMenu(node, context) {
  const allowed = context.conversation?.allowedCategoryIds || [];
  if (!allowed.length) return node;
  return { ...node, config: { ...node.config, options: node.config.options.filter((option) => !option.categoryId || [option.categoryId, ...(option.categoryIds || [])].some((id) => allowed.includes(id))) } };
}

const HANDLERS = {
  async start(node, run) {
    const { config } = node;
    if (config.categoryId) run.context.flow.initialCategoryId = config.categoryId;
    if (config.initialMessage?.trim()) await run.adapter.send(renderTemplate(config.initialMessage, run.context));
    return { branch: "next" };
  },

  async message(node, run) {
    let template = node.config.text;
    if (node.config.source === "LIBRARY") {
      template = run.responses?.get(node.config.responseKey);
      if (template === undefined) throw new Error(`Resposta da biblioteca "${node.config.responseKey}" não encontrada ou inativa.`);
    }
    const textToSend = renderTemplate(template, run.context);
    await run.adapter.send(textToSend);
    return { branch: "next", output: { text: textToSend, ...(node.config.source === "LIBRARY" ? { responseKey: node.config.responseKey } : {}) } };
  },

  async media(node, run) {
    const { config } = node;
    const caption = renderTemplate(config.caption, run.context);
    await run.adapter.sendMedia({ kind: config.kind, storageKey: config.storageKey, mimeType: config.mimeType, fileName: config.fileName, caption });
    return { branch: "next", output: { kind: config.kind, fileName: config.fileName } };
  },

  async question(node, run) {
    await run.adapter.send(renderTemplate(node.config.text, run.context) + (run.context.bot.assistantAfterTriage && !String(node.config.variable || "").startsWith("flow.rating") ? "\n↩ Para retornar à opção anterior, digite Voltar." : ""));
    return { wait: "CUSTOMER" };
  },
  async resumeQuestion(node, run, input) {
    const value = validateAnswer(node.config.answerType, input.text);
    if (value === null) {
      const fallback = node.config.answerType === "YES_NO" ? DEFAULT_YES_NO_INVALID_MESSAGE : DEFAULT_INVALID_MESSAGE;
      return retryOrFail(node, run, node.config.invalidMessage || fallback, renderTemplate(node.config.text, run.context));
    }
    delete run.context._engine.attempts[node.key];
    setPath(run.context, node.config.variable, value);
    run.context.flow.lastAnswer = value;
    return { branch: "next", output: { variable: node.config.variable, value } };
  },

  async menu(node, run) {
    await sendMenu(node, run);
    return { wait: "CUSTOMER" };
  },
  async resumeMenu(node, run, input) {
    node = effectiveMenu(node, run.context);
    const option = matchMenuOption(node.config.options || [], input.text, input.replyId);
    if (!option) {
      return retryOrFail(node, run, node.config.invalidMessage || DEFAULT_MENU_INVALID_MESSAGE, renderMenuText(node.config, run.context));
    }
    delete run.context._engine.attempts[node.key];
    setPath(run.context, node.config.variable, option.label);
    run.context.flow.selectedOption = option.label;
    run.context.flow.lastAnswer = option.label;
    return { branch: menuOptionHandle(option.id), output: { option: option.label } };
  },

  async delay(node, run) {
    const ms = node.config.amount * DELAY_UNITS[node.config.unit];
    // Simulação: nunca espera de verdade, só registra quanto esperaria.
    if (run.adapter.skipDelays) return { branch: "next", output: { skippedDelayMs: ms } };
    return { wait: "TIMER", resumeAt: new Date(run.now.getTime() + ms), output: { delayMs: ms } };
  },

  async condition(node, run) {
    const result = evaluateCondition(node.config, run.context);
    return { branch: result ? "true" : "false", output: { result } };
  },

  async variable(node, run) {
    const assigned = {};
    for (const item of node.config.assignments || []) {
      const value = renderTemplate(item.value, run.context);
      if (setPath(run.context, item.key, value)) assigned[item.key] = value;
    }
    return { branch: "next", output: assigned };
  },

  async webhook(node, run) {
    const fields = Object.fromEntries((node.config.fields || []).filter((field) => field.key)
      .map((field) => [field.key, renderTemplate(field.value, run.context)]));
    const result = await run.adapter.callWebhook({ endpointKey: node.config.endpointKey, fields });
    setPath(run.context, node.config.resultVariable, { ok: Boolean(result?.ok), status: result?.status ?? null, data: result?.data ?? null });
    if (!result?.ok) {
      if (run.hasEdge(node.key, "error")) return { branch: "error", output: { ok: false, errorCode: result?.errorCode || null } };
      throw new Error(`Webhook "${node.config.endpointKey}" falhou (${result?.errorCode || "erro"}).`);
    }
    return { branch: "next", output: { ok: true, status: result.status, simulated: Boolean(result.simulated) } };
  },

  async transfer_category(node, run) {
    run.context.bot.categoryName = await run.adapter.categoryName?.(node.config.categoryId) || "";
    const message = renderTemplate(node.config.message, run.context);
    const outcome = await run.adapter.transferToCategory({ categoryId: node.config.categoryId, message, reason: renderTemplate(node.config.reason, run.context) || `Fluxo "${run.flow.name}"` });
    return { terminal: STATUS.HANDED_OFF, output: outcome };
  },

  async transfer_user(node, run) {
    const message = renderTemplate(node.config.message, run.context);
    const outcome = await run.adapter.transferToUser({
      userId: node.config.userId, categoryId: node.config.categoryId || run.context.flow.initialCategoryId || null,
      message, reason: renderTemplate(node.config.reason, run.context) || `Fluxo "${run.flow.name}"`,
    });
    return { terminal: STATUS.HANDED_OFF, output: outcome };
  },

  async human_handoff(node, run) {
    const message = renderTemplate(node.config.message, run.context);
    const reason = renderTemplate(node.config.reason, run.context) || "Solicitado pelo fluxo";
    const outcome = await run.adapter.handoff({ reason, message, categoryId: node.config.categoryId || run.context.flow.initialCategoryId || null });
    return { terminal: STATUS.HANDED_OFF, output: { reason, ...outcome } };
  },

  async end(node, run) {
    if (node.config.message?.trim()) await run.adapter.send(renderTemplate(node.config.message, run.context));
    await run.adapter.finish({ finalizeConversation: node.config.finalizeConversation });
    return { terminal: STATUS.COMPLETED, output: { finalizeConversation: node.config.finalizeConversation } };
  },

  async goto_flow(node) {
    return { goto: node.config.flowId };
  },
};

const RESUMERS = { question: HANDLERS.resumeQuestion, menu: HANDLERS.resumeMenu };

// ---- loop principal -------------------------------------------------------------

function indexGraph(graphInput) {
  const graph = normalizeGraph(graphInput);
  const nodes = new Map(graph.nodes.map((node) => [node.key, node]));
  const edges = new Map(graph.edges.map((edge) => [`${edge.source}::${edge.sourceHandle}`, edge.target]));
  const start = graph.nodes.find((node) => node.type === "start") || null;
  return { graph, nodes, edges, start };
}

function cloneState(state) {
  return state ? JSON.parse(JSON.stringify(state)) : null;
}

// input: { type: "START", text? } | { type: "MESSAGE", text, replyId? } | { type: "TIMER" }
// state: null (início) ou { currentNodeKey, status, context, resumeAt, flow }
// flow: { flowId, versionId, version, name } do grafo recebido (o estado
// devolvido traz o fluxo em que a execução terminou o turno).
// responses: Map key -> texto da biblioteca "Respostas do Bot".
async function runTurn({
  graph, flow = {}, state, input, adapter, seed = {}, flowName = "", responses = new Map(),
  now = new Date(), maxSteps = MAX_STEPS_PER_TURN,
}) {
  let indexed = indexGraph(graph);
  const trace = [];
  const next = cloneState(state) || { currentNodeKey: null, status: STATUS.RUNNING, context: baseContext(seed), resumeAt: null };
  next.flow = { ...(next.flow || {}), ...flow, name: flow.name || flowName || next.flow?.name || "" };
  next.context._engine ||= { attempts: {}, visited: [] };
  next.context._engine.attempts ||= {};
  next.context._engine.visited ||= [];
  next.context.custom ||= {};
  const run = {
    adapter, now, responses, flow: next.flow, context: next.context,
    hasEdge: (nodeKey, handle) => indexed.edges.has(`${nodeKey}::${handle}`),
  };
  const inputAt = Date.now();
  const humanRequestText = input?.type === "MESSAGE" ? input.text : run.context.flow.initialNeed;
  if (!FINISHED_STATUSES.has(next.status) && run.context.bot.assistantAfterTriage && /(?:falar|conversar|quero|preciso|chamar).*(?:atendente|humano|pessoa|vendedor)|^(?:atendente|humano|pessoa|vendedor)$/.test(normalizeText(humanRequestText))) {
    await adapter.handoff({ message: "Claro, vou chamar nossa equipe para continuar seu atendimento.", reason: "Cliente pediu atendimento humano", categoryId: run.context.flow.initialCategoryId || null });
    next.status = STATUS.HANDED_OFF;
    return { state: next, trace: [{ nodeKey: next.currentNodeKey || "start", nodeType: "human_handoff", result: "DONE", output: { requestedByCustomer: true }, durationMs: Date.now() - inputAt }] };
  }
  if (input?.type === "MESSAGE" && next.context._engine.promptAt) {
    run.customerReplyMs = Math.max(0, now.getTime() - next.context._engine.promptAt);
  }
  if (run.context.bot.availabilityManaged && !run.context.bot.withinBusinessHours) {
    await adapter.send(renderTemplate(run.context.bot.closedMessage, run.context));
    next.currentNodeKey ||= indexed.start?.key;
    next.status = STATUS.WAITING_CUSTOMER;
    next.context._engine.availabilityWaiting = true;
    return { state: next, trace: [{ nodeKey: next.currentNodeKey, nodeType: "availability", result: "WAITING", input: null, output: { outsideHours: true }, durationMs: Date.now() - inputAt }] };
  }
  if (next.context._engine.availabilityWaiting) {
    delete next.context._engine.availabilityWaiting;
    next.status = STATUS.RUNNING;
  }
  if (input?.text !== undefined && input.type !== "TIMER") run.context.flow.lastMessage = String(input.text || "");

  const visitedKey = (nodeKey) => (next.flow.flowId ? `${next.flow.flowId}:${nodeKey}` : nodeKey);
  const record = (node, result, startedAt, extra = {}) => {
    const entry = {
      nodeKey: node.key, nodeType: node.type, nodeName: node.name,
      flowId: next.flow.flowId || null, flowName: next.flow.name || null, version: next.flow.version ?? null,
      result, branch: extra.branch || null,
      input: sanitizeForLog(extra.input ?? null), output: sanitizeForLog({ ...(extra.output || {}),
        quality: String(node.config?.variable || "").startsWith("flow.rating"),
        ...(extra.input && Number.isFinite(run.customerReplyMs) ? { customerReplyMs: run.customerReplyMs } : {}),
      }),
      error: extra.error || null, durationMs: Date.now() - startedAt,
      nextNodeKey: extra.nextNodeKey || null, timestamp: new Date().toISOString(),
    };
    trace.push(entry);
    if (!run.context._engine.visited.includes(visitedKey(node.key))) run.context._engine.visited.push(visitedKey(node.key));
    return entry;
  };

  const fail = async (node, error, startedAt) => {
    record(node, "ERROR", startedAt, { error: error.message?.slice(0, 500) || String(error) });
    next.status = STATUS.FAILED;
    next.error = error.message?.slice(0, 500) || "Falha no nó";
    // Nunca fica preso em silêncio: falha sem saída de erro vira handoff.
    try { await adapter.handoff({ reason: `Falha no nó "${node.name}" do fluxo: ${next.error}`, categoryId: run.context.flow.initialCategoryId || null }); }
    catch (_handoffError) { /* o status FAILED já fica registrado */ }
    return { state: next, trace };
  };

  if (FINISHED_STATUSES.has(next.status)) return { state: next, trace, ignored: true };

  let pendingBranch = null;
  let current = null;

  if (!state) {
    if (!indexed.start) {
      next.status = STATUS.FAILED;
      next.error = "Fluxo sem nó Início.";
      return { state: next, trace };
    }
    current = indexed.start;
  } else {
    current = indexed.nodes.get(next.currentNodeKey);
    if (!current) {
      next.status = STATUS.FAILED;
      next.error = "Nó atual não existe mais nesta versão do fluxo.";
      return { state: next, trace };
    }
    if (next.status === STATUS.WAITING_CUSTOMER) {
      if (input?.type !== "MESSAGE") return { state: next, trace, ignored: true };
      if (run.context.bot.assistantAfterTriage && !String(current.config.variable || "").startsWith("flow.rating") &&
          (/^(?:voltar|volte|anterior|opcao anterior)$/.test(normalizeText(input.text)) || input.replyId === `${MENU_REPLY_PREFIX}assistant_back` ||
           (current.type === "menu" && String(input.text).trim() === String(effectiveMenu(current, run.context).config.options.length + 1)))) {
        const prompts = run.context._engine.promptHistory || [];
        if (prompts.length > 1) prompts.pop();
        const previous = prompts.at(-1);
        const target = previous && indexed.nodes.get(previous.nodeKey);
        if (target && RESUMERS[target.type]) {
          run.context.flow = JSON.parse(JSON.stringify(previous.flow));
          current = target;
          next.currentNodeKey = current.key;
        }
        delete run.context._engine.attempts[current.key];
        await HANDLERS[current.type](current, run);
        next.context._engine.promptAt = now.getTime();
        record(current, "WAITING", Date.now(), { input: { text: input.text }, output: { navigation: "back" } });
        return { state: next, trace };
      }
      const startedAt = Date.now();
      try {
        const resumed = await RESUMERS[current.type](current, run, input);
        if (resumed.stay) {
          next.context._engine.promptAt = now.getTime();
          record(current, "WAITING", startedAt, { input: { text: input.text }, output: resumed.output });
          return { state: next, trace };
        }
        if (resumed.terminal) {
          record(current, "DONE", startedAt, { input: { text: input.text }, output: resumed.output });
          next.status = resumed.terminal;
          return { state: next, trace };
        }
        pendingBranch = resumed.branch;
        record(current, "OK", startedAt, { input: { text: input.text }, output: resumed.output, branch: resumed.branch, nextNodeKey: indexed.edges.get(`${current.key}::${resumed.branch}`) });
      } catch (error) {
        return fail(current, error, startedAt);
      }
    } else if (next.status === STATUS.WAITING_TIMER) {
      if (input?.type !== "TIMER") return { state: next, trace, ignored: true };
      pendingBranch = "next";
      next.resumeAt = null;
      record(current, "OK", Date.now(), { branch: "next", output: { timerElapsed: true }, nextNodeKey: indexed.edges.get(`${current.key}::next`) });
    }
  }

  next.status = STATUS.RUNNING;
  let jumps = 0;
  for (let steps = 0; steps < maxSteps; steps += 1) {
    if (pendingBranch !== null) {
      const targetKey = indexed.edges.get(`${current.key}::${pendingBranch}`);
      if (!targetKey) {
        // Saída não conectada (só acontece em draft/simulação — a publicação
        // bloqueia): encerra sem prender o cliente.
        next.status = STATUS.COMPLETED;
        next.currentNodeKey = current.key;
        return { state: next, trace };
      }
      current = indexed.nodes.get(targetKey);
      pendingBranch = null;
    }
    next.currentNodeKey = current.key;
    const startedAt = Date.now();
    const handler = HANDLERS[current.type];
    if (!handler || !NODE_TYPES[current.type] || current.type === "removed") {
      return fail(current, new Error(`O nó "${current.name}" não é executável nesta versão (remova-o do fluxo).`), startedAt);
    }
    let result;
    try {
      result = await handler(current, run);
    } catch (error) {
      if (run.hasEdge(current.key, "error")) {
        record(current, "ERROR", startedAt, { error: error.message, branch: "error", nextNodeKey: indexed.edges.get(`${current.key}::error`) });
        pendingBranch = "error";
        continue;
      }
      return fail(current, error, startedAt);
    }
    if (result.goto) {
      jumps += 1;
      if (jumps > MAX_FLOW_JUMPS_PER_TURN) return fail(current, new Error(`Mais de ${MAX_FLOW_JUMPS_PER_TURN} trocas de fluxo na mesma mensagem (possível loop entre fluxos).`), startedAt);
      let target;
      try { target = await adapter.loadFlow(result.goto); }
      catch (error) { return fail(current, error, startedAt); }
      if (!target?.graph) return fail(current, new Error("O fluxo de destino não existe ou não tem versão publicada."), startedAt);
      const targetIndex = indexGraph(target.graph);
      if (!targetIndex.start) return fail(current, new Error(`O fluxo "${target.name}" não tem nó Início.`), startedAt);
      record(current, "OK", startedAt, { output: { toFlowId: target.flowId, toFlowName: target.name }, nextNodeKey: targetIndex.start.key });
      indexed = targetIndex;
      next.flow = { flowId: target.flowId, versionId: target.versionId || null, version: target.version ?? null, name: target.name || "" };
      run.flow = next.flow;
      current = targetIndex.start;
      continue;
    }
    if (result.wait === "CUSTOMER") {
      if (run.context.bot.assistantAfterTriage && !String(current.config.variable || "").startsWith("flow.rating")) {
        const history = next.context._engine.promptHistory ||= [];
        history.push({ nodeKey: current.key, flow: JSON.parse(JSON.stringify(run.context.flow)) });
        if (history.length > 30) history.shift();
      }
      next.context._engine.promptAt = now.getTime();
      record(current, "WAITING", startedAt, { output: result.output });
      next.status = STATUS.WAITING_CUSTOMER;
      return { state: next, trace };
    }
    if (result.wait === "TIMER") {
      record(current, "WAITING", startedAt, { output: result.output });
      next.status = STATUS.WAITING_TIMER;
      next.resumeAt = result.resumeAt.toISOString();
      return { state: next, trace };
    }
    if (result.terminal) {
      record(current, "DONE", startedAt, { output: result.output });
      next.status = result.terminal;
      return { state: next, trace };
    }
    record(current, "OK", startedAt, { output: result.output, branch: result.branch, nextNodeKey: indexed.edges.get(`${current.key}::${result.branch}`) });
    pendingBranch = result.branch;
  }
  return fail(current, new Error(`Limite de ${maxSteps} passos por mensagem atingido (possível loop).`), Date.now());
}

module.exports = {
  FINISHED_STATUSES, MAX_FLOW_JUMPS_PER_TURN, MAX_STEPS_PER_TURN, MENU_REPLY_PREFIX, STATUS,
  baseContext, evaluateCondition, getPath, matchMenuOption, renderTemplate, runTurn, sanitizeForLog, setPath, validateAnswer,
};
