// Flow Builder — motor de execução do grafo visual (BotFlowVersion.graph).
//
// Executa nó a nó a partir do estado salvo, nunca o fluxo inteiro de uma
// vez: roda até encontrar um nó que ESPERA (Pergunta/Menu = cliente,
// Intervalo = timer) ou um nó terminal (Transferir/Humano/Finalizar), e
// devolve o novo estado para ser persistido. Uma nova mensagem (ou o
// worker do timer) chama runTurn de novo com o estado salvo.
//
// Todo efeito colateral (enviar texto, transferir, IA, conhecimento) passa
// pelo `adapter` — o motor em si é puro. Dois adapters existem em
// bot-visual-flow-service.js: o real (conversa de verdade) e o de simulação
// (dry-run, nunca envia nada nem altera Conversation).

const { normalizeText } = require("./bot-simulator-service");
const { DELAY_UNITS, NODE_TYPES, isWritablePath, menuOptionHandle, normalizeGraph } = require("./bot-visual-flow-graph");

const MAX_STEPS_PER_TURN = 50;
const DEFAULT_INVALID_MESSAGE = "Não consegui entender sua resposta. Pode tentar de novo?";
const DEFAULT_MENU_INVALID_MESSAGE = "Não reconheci a opção. Responda com o número ou o nome de uma das opções:";

const STATUS = Object.freeze({
  RUNNING: "RUNNING", WAITING_CUSTOMER: "WAITING_CUSTOMER", WAITING_TIMER: "WAITING_TIMER",
  HANDED_OFF: "HANDED_OFF", COMPLETED: "COMPLETED", FAILED: "FAILED",
});
const FINISHED_STATUSES = new Set([STATUS.HANDED_OFF, STATUS.COMPLETED, STATUS.FAILED]);

// Atalhos aceitos em Condições (item "intent == wholesale", "channel == WHATSAPP").
const PATH_ALIASES = {
  intent: "bot.intent", product: "bot.product", confidence: "bot.confidence",
  needsHuman: "bot.needsHuman", action: "bot.action", channel: "conversation.channel",
};

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

function renderTemplate(template, context) {
  return String(template || "").replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g, (_match, path) => {
    const value = getPath(context, path);
    if (value === undefined || value === null) return "";
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  });
}

function baseContext(seed = {}) {
  return {
    contact: { ...(seed.contact || {}) },
    conversation: { ...(seed.conversation || {}) },
    bot: {}, flow: {}, customer: {}, vars: {}, knowledge: {},
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

// Arquitetura pronta para validações mais completas (dígito verificador de
// CPF/CNPJ etc.) — por ora só formato.
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
};

function validateAnswer(answerType, value) {
  return (ANSWER_VALIDATORS[answerType] || ANSWER_VALIDATORS.TEXT)(String(value || ""));
}

// Aceita "2", "opção 2", "suporte", "quero suporte" — nunca chama IA. Só
// escolhe por conteúdo quando exatamente UMA opção bate (evita chute).
function matchMenuOption(options, input) {
  const normalized = normalizeText(input).replace(/[!?.,;:]+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  const numberMatch = normalized.match(/^(?:opcao|opção|op|numero|n)?\s*(\d{1,2})(?:\s|$)/);
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
// execute(node, run) -> { branch } | { wait: "CUSTOMER" } | { wait: "TIMER", resumeAt } | { terminal: STATUS }
// resume(node, run, input) (só nós que esperam o cliente) -> { branch } | { stay: true }

function attemptsFor(context, nodeKey) {
  return context._engine.attempts[nodeKey] || 0;
}

async function retryOrFail(node, run, invalidText, repeatText) {
  const { context } = run;
  const attempts = attemptsFor(context, node.key) + 1;
  context._engine.attempts[node.key] = attempts;
  if (attempts >= node.config.maxAttempts) {
    delete context._engine.attempts[node.key];
    if (run.hasEdge(node.key, "invalid")) return { branch: "invalid", output: { attempts, exhausted: true } };
    // Sem saída "inválida" conectada: nunca prende o cliente num loop —
    // entrega para humano com o motivo registrado.
    await run.adapter.handoff({ reason: `Resposta inválida após ${attempts} tentativas em "${node.name}".`, categoryId: context.flow.initialCategoryId || null });
    return { terminal: STATUS.HANDED_OFF, output: { attempts, exhausted: true } };
  }
  await run.adapter.send([invalidText, repeatText].filter(Boolean).join("\n"));
  return { stay: true, output: { attempts } };
}

const HANDLERS = {
  async start(node, run) {
    const { config } = node;
    if (config.categoryId) run.context.flow.initialCategoryId = config.categoryId;
    if (config.initialMessage?.trim()) await run.adapter.send(renderTemplate(config.initialMessage, run.context));
    return { branch: "next" };
  },

  async message(node, run) {
    const textToSend = renderTemplate(node.config.text, run.context);
    await run.adapter.send(textToSend);
    return { branch: "next", output: { text: textToSend } };
  },

  async question(node, run) {
    await run.adapter.send(renderTemplate(node.config.text, run.context));
    return { wait: "CUSTOMER" };
  },
  async resumeQuestion(node, run, input) {
    const value = validateAnswer(node.config.answerType, input.text);
    if (value === null) {
      return retryOrFail(node, run, node.config.invalidMessage || DEFAULT_INVALID_MESSAGE, renderTemplate(node.config.text, run.context));
    }
    delete run.context._engine.attempts[node.key];
    setPath(run.context, node.config.variable, value);
    run.context.flow.lastAnswer = value;
    return { branch: "next", output: { variable: node.config.variable, value } };
  },

  async menu(node, run) {
    await run.adapter.send(renderMenuText(node.config, run.context));
    return { wait: "CUSTOMER" };
  },
  async resumeMenu(node, run, input) {
    const option = matchMenuOption(node.config.options || [], input.text);
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

  async ai(node, run) {
    const { config } = node;
    const message = renderTemplate(config.input, run.context) || run.context.flow.lastMessage || "";
    const result = await run.adapter.ai({ mode: config.mode, provider: config.provider, model: config.model, message });
    if (!result?.ok) {
      run.context.bot.error = result?.errorCode || "AI_UNAVAILABLE";
      const branch = run.hasEdge(node.key, "error") ? "error" : (run.hasEdge(node.key, "handoff") ? "handoff" : "next");
      return { branch, output: { ok: false, errorCode: run.context.bot.error } };
    }
    const fields = ["answer", "action", "intent", "product", "confidence", "needsHuman", "reason"];
    for (const field of fields) run.context.bot[field] = result[field] ?? null;
    delete run.context.bot.error;
    let sent = null;
    if (config.mode === "RESPOND" && config.sendAnswer && result.answer) {
      // Nunca envia direto: passa pelo mesmo gate/sender da IA atual
      // (bot-ai-gate + send-mode). Hoje o sender é DRY_RUN.
      sent = await run.adapter.sendAiAnswer(result);
    }
    const branch = result.needsHuman && run.hasEdge(node.key, "handoff") ? "handoff" : "next";
    return { branch, output: { ...Object.fromEntries(fields.map((field) => [field, result[field] ?? null])), sent } };
  },

  async knowledge(node, run) {
    const query = renderTemplate(node.config.query, run.context) || run.context.flow.lastMessage || "";
    const product = renderTemplate(node.config.product, run.context) || run.context.bot.product || null;
    const found = await run.adapter.searchKnowledge({ query, product, limit: node.config.limit });
    const results = found?.results || [];
    run.context.knowledge = {
      result: results.map((item) => item.excerpt || item.title).join("\n\n").slice(0, 4000),
      sources: results.map((item) => item.title),
      confidence: results.length ? Math.round((results[0].score || 0) * 100) / 100 : 0,
    };
    const branch = results.length || !run.hasEdge(node.key, "not_found") ? "found" : "not_found";
    return { branch, output: { query, sources: run.context.knowledge.sources, confidence: run.context.knowledge.confidence } };
  },

  async transfer_category(node, run) {
    const message = renderTemplate(node.config.message, run.context);
    const outcome = await run.adapter.transferToCategory({ categoryId: node.config.categoryId, message, reason: node.config.reason || `Fluxo "${run.flowName}"` });
    return { terminal: STATUS.HANDED_OFF, output: outcome };
  },

  async human_handoff(node, run) {
    const message = renderTemplate(node.config.message, run.context);
    const reason = renderTemplate(node.config.reason, run.context) || run.context.bot.reason || "Solicitado pelo fluxo";
    const outcome = await run.adapter.handoff({ reason, message, categoryId: node.config.categoryId || run.context.flow.initialCategoryId || null });
    return { terminal: STATUS.HANDED_OFF, output: { reason, ...outcome } };
  },

  async end(node, run) {
    if (node.config.message?.trim()) await run.adapter.send(renderTemplate(node.config.message, run.context));
    await run.adapter.finish({ finalizeConversation: node.config.finalizeConversation });
    return { terminal: STATUS.COMPLETED, output: { finalizeConversation: node.config.finalizeConversation } };
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

// input: { type: "START", text? } | { type: "MESSAGE", text } | { type: "TIMER" }
// state: null (início) ou { currentNodeKey, status, context, resumeAt }
async function runTurn({ graph, state, input, adapter, seed = {}, flowName = "", now = new Date(), maxSteps = MAX_STEPS_PER_TURN }) {
  const indexed = indexGraph(graph);
  const trace = [];
  const next = cloneState(state) || { currentNodeKey: null, status: STATUS.RUNNING, context: baseContext(seed), resumeAt: null };
  next.context._engine ||= { attempts: {}, visited: [] };
  next.context._engine.attempts ||= {};
  next.context._engine.visited ||= [];
  const run = {
    adapter, now, flowName, context: next.context,
    hasEdge: (nodeKey, handle) => indexed.edges.has(`${nodeKey}::${handle}`),
  };
  if (input?.text !== undefined && input.type !== "TIMER") run.context.flow.lastMessage = String(input.text || "");

  const record = (node, result, startedAt, extra = {}) => {
    const entry = {
      nodeKey: node.key, nodeType: node.type, nodeName: node.name,
      result, branch: extra.branch || null,
      input: sanitizeForLog(extra.input ?? null), output: sanitizeForLog(extra.output ?? null),
      error: extra.error || null, durationMs: Date.now() - startedAt,
      nextNodeKey: extra.nextNodeKey || null, timestamp: new Date().toISOString(),
    };
    trace.push(entry);
    if (!run.context._engine.visited.includes(node.key)) run.context._engine.visited.push(node.key);
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
      const startedAt = Date.now();
      try {
        const resumed = await RESUMERS[current.type](current, run, input);
        if (resumed.stay) {
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
    if (!handler || !NODE_TYPES[current.type].available) {
      return fail(current, new Error(`Tipo de nó "${current.type}" ainda não é executável.`), startedAt);
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
    if (result.wait === "CUSTOMER") {
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
  FINISHED_STATUSES, MAX_STEPS_PER_TURN, STATUS,
  baseContext, evaluateCondition, getPath, matchMenuOption, renderTemplate, runTurn, sanitizeForLog, setPath, validateAnswer,
};
