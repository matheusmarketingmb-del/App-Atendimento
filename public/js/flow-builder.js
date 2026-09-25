// Editor Visual de Fluxos (Flow Builder) — canvas próprio em JS puro (sem
// dependência nova): nós em DOM, conexões em SVG. Toda regra de permissão,
// validação e execução fica no backend (bot-visual-flow-*.js); o editor só
// monta o grafo e chama a API.
(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const params = new URLSearchParams(location.search);
  const botId = params.get("botId");

  const OUTPUT_LABELS = {
    next: "Próximo", invalid: "Resposta inválida", true: "Verdadeiro", false: "Falso",
    handoff: "Precisa de humano", error: "Erro", found: "Encontrou", not_found: "Não encontrou",
  };
  const RESULT_LABELS = { OK: "ok", DONE: "fim", WAITING: "aguardando", ERROR: "erro" };
  const STATUS_LABELS = { DRAFT: "RASCUNHO", ACTIVE: "ATIVO", INACTIVE: "INATIVO" };
  const EXEC_STATUS_LABELS = {
    RUNNING: "executando", WAITING_CUSTOMER: "aguardando o cliente", WAITING_TIMER: "aguardando intervalo",
    HANDED_OFF: "entregue para a equipe", COMPLETED: "concluído", FAILED: "falhou",
  };
  const AI_MODES = { UNDERSTAND: "Entender mensagem", RESPOND: "Responder", CLASSIFY: "Classificar intenção", EXTRACT: "Extrair dados", DECIDE: "Decidir próxima ação" };
  const ANSWER_TYPES = { TEXT: "Texto livre", NUMBER: "Número", EMAIL: "E-mail", CPF_CNPJ: "CPF/CNPJ", PHONE: "Telefone" };
  const OPERATORS = ["==", "!=", "contains", "not_contains", ">", "<", ">=", "<=", "exists", "not_exists"];
  const START_CHANNELS = { META: "WhatsApp", INSTAGRAM_DIRECT: "Instagram Direct", FACEBOOK_MESSENGER: "Messenger", EMAIL: "E-mail" };
  const SAMPLE_CONTEXT = {
    contact: { name: "Maria Silva", firstName: "Maria", phone: "5511999990000", email: "maria@exemplo.com" },
    conversation: { id: "123", channel: "META" }, bot: { intent: "suporte", product: "GS Pro 2", confidence: "HIGH" },
    flow: { selectedOption: "Suporte", lastAnswer: "12345", lastMessage: "Olá" }, customer: {}, vars: {}, knowledge: {},
  };

  const state = {
    options: null, bot: null, flows: [], flow: null,
    graph: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
    selectedNode: null, selectedEdge: null, dirty: false,
    undo: [], redo: [], editSnapshotTaken: false,
    errors: [], test: null,
  };

  // ---------- utilidades --------------------------------------------------
  async function api(url, options = {}) {
    const headers = { ...(options.body ? { "Content-Type": "application/json" } : {}) };
    const response = await fetch(url, { ...options, headers });
    if (response.status === 401) { location.replace("/login.html"); throw new Error("Sessão encerrada."); }
    const body = response.status === 204 ? null : await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(body?.error || "Não foi possível concluir a operação."), { status: response.status, body });
    return body;
  }
  const flowUrl = (suffix = "") => `/api/bots/${encodeURIComponent(botId)}/visual-flows/${encodeURIComponent(state.flow.id)}${suffix}`;
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  }
  let toastTimer;
  function toast(message, isError = false) {
    const element = $("#toast");
    element.textContent = message;
    element.className = `toast show${isError ? " error" : ""}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { element.className = "toast"; }, 3600);
  }
  const uid = (prefix) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const typeMeta = (type) => state.options?.nodeTypes.find((item) => item.type === type) || { label: type, icon: "?", outputs: [], optionalOutputs: [] };
  const nodeByKey = (key) => state.graph.nodes.find((node) => node.key === key);
  function renderTemplate(template) {
    return String(template || "").replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g, (_m, path) => {
      const value = path.split(".").reduce((acc, part) => (acc && typeof acc === "object" ? acc[part] : undefined), SAMPLE_CONTEXT);
      return value === undefined || value === null ? `‹${path}›` : String(value);
    });
  }

  // ---------- histórico (desfazer/refazer) --------------------------------
  function pushHistory() {
    state.undo.push(JSON.stringify(state.graph));
    if (state.undo.length > 100) state.undo.shift();
    state.redo = [];
    markDirty();
    updateHistoryButtons();
  }
  function markDirty() {
    state.dirty = true;
    $("#fb-dirty").hidden = false;
  }
  function restoreFrom(from, to) {
    if (!from.length) return;
    to.push(JSON.stringify(state.graph));
    state.graph = JSON.parse(from.pop());
    if (state.selectedNode && !nodeByKey(state.selectedNode)) state.selectedNode = null;
    state.selectedEdge = null;
    markDirty();
    render();
    renderPanel();
    updateHistoryButtons();
  }
  function updateHistoryButtons() {
    $("#fb-undo").disabled = !state.undo.length;
    $("#fb-redo").disabled = !state.redo.length;
  }

  // ---------- saídas de cada nó -------------------------------------------
  function outputsFor(node) {
    const meta = typeMeta(node.type);
    if (meta.terminal) return [];
    const optional = new Set(meta.optionalOutputs || []);
    const outputs = [];
    if (node.type === "menu") {
      (node.config.options || []).forEach((option, index) => outputs.push({ handle: `opt:${option.id}`, label: `${index + 1}. ${option.label || "Opção"}` }));
    }
    for (const handle of meta.outputs) outputs.push({ handle, label: OUTPUT_LABELS[handle] || handle, optional: optional.has(handle) });
    return outputs;
  }

  function summaryFor(node) {
    const c = node.config || {};
    const categoryName = (id) => state.options?.categories.find((item) => item.id === id)?.name;
    switch (node.type) {
      case "start": return [c.trigger === "ANY_MESSAGE" ? "Qualquer mensagem" : "Nova conversa", c.initialMessage].filter(Boolean).join("\n");
      case "message": case "question": case "menu": return c.text || "Sem texto";
      case "delay": return `Aguardar ${c.amount} ${{ SECONDS: "segundo(s)", MINUTES: "minuto(s)", HOURS: "hora(s)" }[c.unit] || ""}`;
      case "condition": return (c.rules || []).map((rule) => `${rule.left} ${rule.operator} ${rule.right}`).join(c.match === "ANY" ? "\nOU " : "\nE ") || "Sem regras";
      case "variable": return (c.assignments || []).map((item) => `${item.key} = ${item.value}`).join("\n") || "Nenhuma variável";
      case "ai": return `${AI_MODES[c.mode] || c.mode}${c.sendAnswer ? " • responde (dry-run)" : ""}`;
      case "knowledge": return `Busca: ${c.query}`;
      case "transfer_category": return categoryName(c.categoryId) ? `Setor: ${categoryName(c.categoryId)}` : "Selecione o setor";
      case "human_handoff": return c.reason || (categoryName(c.categoryId) ? `Setor: ${categoryName(c.categoryId)}` : "Entregar para a equipe");
      case "end": return c.finalizeConversation === false ? "Encerra o Bot (conversa continua)" : "Finaliza a conversa";
      default: return typeMeta(node.type).available === false ? "Disponível em breve" : "";
    }
  }

  // ---------- canvas: render ----------------------------------------------
  const canvas = $("#fb-canvas");
  const viewportEl = $("#fb-viewport");
  const nodesEl = $("#fb-nodes");
  const edgesEl = $("#fb-edges");

  function applyViewport() {
    const { x, y, zoom } = state.graph.viewport;
    viewportEl.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
    canvas.style.backgroundPosition = `${x}px ${y}px`;
    canvas.style.backgroundSize = `${22 * zoom}px ${22 * zoom}px`;
    $("#fb-zoom-label").textContent = `${Math.round(zoom * 100)}%`;
  }

  function nodeClasses(node) {
    const classes = ["fb-node", node.type];
    if (state.selectedNode === node.key) classes.push("selected");
    if (state.errors.some((error) => error.nodeKey === node.key)) classes.push("has-error");
    if (state.test) {
      if (state.test.errored.has(node.key)) classes.push("errored");
      else if (state.test.current === node.key) classes.push("current");
      else if (state.test.visited.has(node.key)) classes.push("visited");
    }
    return classes.join(" ");
  }

  function renderNodes() {
    const connected = new Set(state.graph.edges.map((edge) => `${edge.source}::${edge.sourceHandle}`));
    nodesEl.innerHTML = state.graph.nodes.map((node) => {
      const meta = typeMeta(node.type);
      const errorCount = state.errors.filter((error) => error.nodeKey === node.key).length;
      const outputs = outputsFor(node).map((output) => `
        <div class="fb-output ${output.optional ? "optional" : ""} ${output.handle}">${escapeHtml(output.label)}
          <span class="fb-handle out ${connected.has(`${node.key}::${output.handle}`) ? "connected" : ""}" data-handle="${escapeHtml(output.handle)}" title="Arraste para conectar"></span>
        </div>`).join("");
      return `
        <div class="${nodeClasses(node)}" data-key="${escapeHtml(node.key)}" style="left:${node.x}px;top:${node.y}px">
          ${node.type === "start" ? "" : '<span class="fb-handle in" title="Entrada"></span>'}
          ${errorCount ? `<span class="fb-error-badge" title="${escapeHtml(state.errors.filter((error) => error.nodeKey === node.key).map((error) => error.message).join("\n"))}">${errorCount}</span>` : ""}
          <div class="fb-node-head"><i>${meta.icon}</i><span>${escapeHtml(meta.label)}</span>
            <div class="fb-node-tools">
              <button type="button" data-action="duplicate" title="Duplicar (Ctrl+D)">⧉</button>
              <button type="button" data-action="delete" title="Excluir (Delete)">✕</button>
            </div>
          </div>
          <div class="fb-node-body"><b>${escapeHtml(node.name)}</b><p>${escapeHtml(summaryFor(node))}</p></div>
          ${outputs ? `<div class="fb-outputs">${outputs}</div>` : ""}
        </div>`;
    }).join("");
  }

  // Coordenadas (no espaço do grafo, sem zoom) dos handles, lidas do DOM
  // via offsetLeft/offsetTop — não são afetadas pelo transform de escala.
  function handlePoint(nodeKey, handle) {
    const nodeEl = nodesEl.querySelector(`.fb-node[data-key="${CSS.escape(nodeKey)}"]`);
    const node = nodeByKey(nodeKey);
    if (!nodeEl || !node) return null;
    if (handle === "in") return { x: node.x, y: node.y + 19 };
    const handleEl = nodeEl.querySelector(`.fb-handle.out[data-handle="${CSS.escape(handle)}"]`);
    if (!handleEl) return null;
    const row = handleEl.parentElement;
    let top = row.offsetTop + handleEl.offsetTop + 7;
    let parent = row.offsetParent;
    while (parent && parent !== nodeEl) { top += parent.offsetTop; parent = parent.offsetParent; }
    return { x: node.x + nodeEl.offsetWidth, y: node.y + top };
  }

  function curve(from, to) {
    const dx = Math.max(40, Math.abs(to.x - from.x) / 2);
    return `M${from.x},${from.y} C${from.x + dx},${from.y} ${to.x - dx},${to.y} ${to.x},${to.y}`;
  }

  function renderEdges() {
    const taken = state.test?.takenEdges || new Set();
    edgesEl.innerHTML = state.graph.edges.map((edge) => {
      const from = handlePoint(edge.source, edge.sourceHandle);
      const to = handlePoint(edge.target, "in");
      if (!from || !to) return "";
      const d = curve(from, to);
      const cls = ["fb-edge", state.selectedEdge === edge.id ? "selected" : "", taken.has(`${edge.source}::${edge.sourceHandle}`) ? "taken" : ""].join(" ");
      return `<path class="fb-edge-hit" data-edge="${escapeHtml(edge.id)}" d="${d}"></path><path class="${cls}" data-edge="${escapeHtml(edge.id)}" d="${d}" marker-end="url(#fb-arrow)"></path>`;
    }).join("") + `<defs><marker id="fb-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="var(--fb-edge)"></path></marker></defs>`;
  }

  function render() {
    applyViewport();
    renderNodes();
    renderEdges();
  }

  // ---------- canvas: interação --------------------------------------------
  function toGraphPoint(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const { x, y, zoom } = state.graph.viewport;
    return { x: (clientX - rect.left - x) / zoom, y: (clientY - rect.top - y) / zoom };
  }

  let drag = null; // { kind: "pan"|"node"|"connect", ... }

  canvas.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    const handle = event.target.closest(".fb-handle.out");
    const nodeEl = event.target.closest(".fb-node");
    const edgeEl = event.target.closest("[data-edge]");
    if (event.target.closest(".fb-zoom, .fb-validation, .fb-test-legend")) return;
    if (handle && nodeEl) {
      event.preventDefault();
      drag = { kind: "connect", source: nodeEl.dataset.key, sourceHandle: handle.dataset.handle };
      return;
    }
    if (event.target.closest(".fb-node-tools")) return;
    if (nodeEl) {
      const key = nodeEl.dataset.key;
      selectNode(key);
      if (event.target.closest(".fb-node-head, .fb-node-body")) {
        const node = nodeByKey(key);
        const point = toGraphPoint(event.clientX, event.clientY);
        drag = { kind: "node", key, offsetX: point.x - node.x, offsetY: point.y - node.y, before: JSON.stringify(state.graph), moved: false };
      }
      return;
    }
    if (edgeEl) {
      state.selectedEdge = edgeEl.dataset.edge;
      state.selectedNode = null;
      renderEdges();
      renderNodes();
      renderPanel();
      return;
    }
    state.selectedEdge = null;
    if (state.selectedNode) { state.selectedNode = null; renderNodes(); renderPanel(); }
    renderEdges();
    drag = { kind: "pan", startX: event.clientX, startY: event.clientY, originX: state.graph.viewport.x, originY: state.graph.viewport.y };
    canvas.classList.add("panning");
  });

  window.addEventListener("mousemove", (event) => {
    if (!drag) return;
    if (drag.kind === "pan") {
      state.graph.viewport.x = drag.originX + event.clientX - drag.startX;
      state.graph.viewport.y = drag.originY + event.clientY - drag.startY;
      applyViewport();
    } else if (drag.kind === "node") {
      const point = toGraphPoint(event.clientX, event.clientY);
      const node = nodeByKey(drag.key);
      node.x = Math.round(point.x - drag.offsetX);
      node.y = Math.round(point.y - drag.offsetY);
      drag.moved = true;
      const element = nodesEl.querySelector(`.fb-node[data-key="${CSS.escape(drag.key)}"]`);
      element.style.left = `${node.x}px`;
      element.style.top = `${node.y}px`;
      renderEdges();
    } else if (drag.kind === "connect") {
      const from = handlePoint(drag.source, drag.sourceHandle);
      const to = toGraphPoint(event.clientX, event.clientY);
      renderEdges();
      edgesEl.insertAdjacentHTML("beforeend", `<path class="fb-edge temp" d="${curve(from, to)}"></path>`);
      nodesEl.querySelectorAll(".drop-target").forEach((element) => element.classList.remove("drop-target"));
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(".fb-node");
      if (target && target.dataset.key !== drag.source && !target.classList.contains("start")) target.classList.add("drop-target");
    }
  });

  window.addEventListener("mouseup", (event) => {
    if (!drag) return;
    const current = drag;
    drag = null;
    canvas.classList.remove("panning");
    if (current.kind === "node" && current.moved) {
      state.undo.push(current.before);
      state.redo = [];
      markDirty();
      updateHistoryButtons();
    } else if (current.kind === "pan") {
      markViewportDirty();
    } else if (current.kind === "connect") {
      nodesEl.querySelectorAll(".drop-target").forEach((element) => element.classList.remove("drop-target"));
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(".fb-node");
      if (target && target.dataset.key !== current.source && nodeByKey(target.dataset.key)?.type !== "start") {
        connect(current.source, current.sourceHandle, target.dataset.key);
      } else {
        renderEdges();
      }
    }
  });

  // Mover/zoom do canvas também é salvo (viewport), mas não entra no desfazer.
  function markViewportDirty() { if (state.flow) markDirty(); }

  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    zoomAt(event.deltaY < 0 ? 1.1 : 1 / 1.1, event.clientX - rect.left, event.clientY - rect.top);
  }, { passive: false });

  function zoomAt(factor, cx, cy) {
    const viewport = state.graph.viewport;
    const zoom = Math.min(2, Math.max(0.2, viewport.zoom * factor));
    viewport.x = cx - ((cx - viewport.x) * zoom) / viewport.zoom;
    viewport.y = cy - ((cy - viewport.y) * zoom) / viewport.zoom;
    viewport.zoom = zoom;
    applyViewport();
    markViewportDirty();
  }
  $("#fb-zoom-in").addEventListener("click", () => zoomAt(1.2, canvas.clientWidth / 2, canvas.clientHeight / 2));
  $("#fb-zoom-out").addEventListener("click", () => zoomAt(1 / 1.2, canvas.clientWidth / 2, canvas.clientHeight / 2));
  $("#fb-fit").addEventListener("click", fitView);

  function fitView() {
    if (!state.graph.nodes.length) return;
    const elements = [...nodesEl.querySelectorAll(".fb-node")];
    const minX = Math.min(...state.graph.nodes.map((node) => node.x));
    const minY = Math.min(...state.graph.nodes.map((node) => node.y));
    const maxX = Math.max(...state.graph.nodes.map((node, index) => node.x + (elements[index]?.offsetWidth || 224)));
    const maxY = Math.max(...state.graph.nodes.map((node, index) => node.y + (elements[index]?.offsetHeight || 120)));
    const padding = 60;
    const zoom = Math.min(1.2, Math.max(0.2, Math.min((canvas.clientWidth - padding * 2) / (maxX - minX || 1), (canvas.clientHeight - padding * 2) / (maxY - minY || 1))));
    state.graph.viewport = {
      zoom, x: (canvas.clientWidth - (maxX - minX) * zoom) / 2 - minX * zoom, y: (canvas.clientHeight - (maxY - minY) * zoom) / 2 - minY * zoom,
    };
    applyViewport();
    markViewportDirty();
  }

  nodesEl.addEventListener("click", (event) => {
    const button = event.target.closest(".fb-node-tools button");
    if (!button) return;
    const key = button.closest(".fb-node").dataset.key;
    if (button.dataset.action === "delete") deleteNode(key);
    if (button.dataset.action === "duplicate") duplicateNode(key);
  });

  // ---------- operações do grafo ---------------------------------------------
  function connect(source, sourceHandle, target) {
    pushHistory();
    // Cada saída tem no máximo uma conexão: conectar de novo substitui.
    state.graph.edges = state.graph.edges.filter((edge) => !(edge.source === source && edge.sourceHandle === sourceHandle));
    state.graph.edges.push({ id: `${source}:${sourceHandle}->${target}`, source, sourceHandle, target });
    render();
  }

  function addNode(type, point) {
    const meta = typeMeta(type);
    if (meta.available === false) { toast(`"${meta.label}" estará disponível em uma próxima versão.`); return; }
    if (type === "start" && state.graph.nodes.some((node) => node.type === "start")) { toast("O fluxo já tem um nó Início."); return; }
    pushHistory();
    const node = { key: uid("n"), type, name: meta.label, x: Math.round(point.x), y: Math.round(point.y), config: defaultConfig(type) };
    state.graph.nodes.push(node);
    state.selectedNode = node.key;
    render();
    renderPanel();
  }

  function defaultConfig(type) {
    switch (type) {
      case "message": return { text: "" };
      case "question": return { text: "", variable: "flow.lastAnswer", answerType: "TEXT", invalidMessage: "", maxAttempts: 3 };
      case "menu": return { text: "Como podemos ajudar?", options: [{ id: uid("o"), label: "Opção 1", keywords: [] }, { id: uid("o"), label: "Opção 2", keywords: [] }], variable: "flow.selectedOption", invalidMessage: "", maxAttempts: 3 };
      case "condition": return { match: "ALL", rules: [{ left: "bot.intent", operator: "==", right: "" }] };
      case "delay": return { amount: 5, unit: "SECONDS" };
      case "variable": return { assignments: [{ key: "vars.nome", value: "" }] };
      case "ai": return { mode: "UNDERSTAND", provider: "LOCAL_QWEN", model: "", input: "{{flow.lastMessage}}", sendAnswer: false };
      case "knowledge": return { query: "{{flow.lastMessage}}", product: "", limit: 3 };
      case "transfer_category": return { categoryId: "", message: "", reason: "" };
      case "human_handoff": return { reason: "", categoryId: "", message: "" };
      case "end": return { message: "", finalizeConversation: true };
      case "start": return { initialMessage: "", channels: [], categoryId: null, trigger: "NEW_CONVERSATION" };
      default: return {};
    }
  }

  function deleteNode(key) {
    const node = nodeByKey(key);
    if (!node) return;
    if (node.type === "start" && state.graph.nodes.filter((item) => item.type === "start").length <= 1) {
      toast("O nó Início não pode ser apagado — todo fluxo precisa de exatamente um.", true);
      return;
    }
    pushHistory();
    state.graph.nodes = state.graph.nodes.filter((item) => item.key !== key);
    state.graph.edges = state.graph.edges.filter((edge) => edge.source !== key && edge.target !== key);
    if (state.selectedNode === key) state.selectedNode = null;
    render();
    renderPanel();
  }

  function duplicateNode(key) {
    const node = nodeByKey(key);
    if (!node) return;
    if (node.type === "start") { toast("O nó Início não pode ser duplicado."); return; }
    pushHistory();
    const copy = { ...clone(node), key: uid("n"), name: `${node.name} (cópia)`, x: node.x + 40, y: node.y + 40 };
    if (copy.type === "menu") copy.config.options = copy.config.options.map((option) => ({ ...option, id: uid("o") }));
    state.graph.nodes.push(copy);
    state.selectedNode = copy.key;
    render();
    renderPanel();
  }

  function deleteEdge(id) {
    pushHistory();
    state.graph.edges = state.graph.edges.filter((edge) => edge.id !== id);
    state.selectedEdge = null;
    render();
    renderPanel();
  }

  function selectNode(key) {
    if (state.selectedNode === key) return;
    state.selectedNode = key;
    state.selectedEdge = null;
    renderNodes();
    renderEdges();
    showPanel("props");
    renderPanel();
  }

  document.addEventListener("keydown", (event) => {
    const typing = event.target.closest("input, textarea, select");
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === "s") { event.preventDefault(); saveDraft(); return; }
    if (typing) return;
    if (mod && event.key.toLowerCase() === "z" && !event.shiftKey) { event.preventDefault(); restoreFrom(state.undo, state.redo); }
    else if (mod && (event.key.toLowerCase() === "y" || (event.key.toLowerCase() === "z" && event.shiftKey))) { event.preventDefault(); restoreFrom(state.redo, state.undo); }
    else if (mod && event.key.toLowerCase() === "d" && state.selectedNode) { event.preventDefault(); duplicateNode(state.selectedNode); }
    else if (event.key === "Delete" || event.key === "Backspace") {
      if (state.selectedEdge) deleteEdge(state.selectedEdge);
      else if (state.selectedNode) deleteNode(state.selectedNode);
    }
  });
  $("#fb-undo").addEventListener("click", () => restoreFrom(state.undo, state.redo));
  $("#fb-redo").addEventListener("click", () => restoreFrom(state.redo, state.undo));

  // ---------- biblioteca ---------------------------------------------------------
  function renderLibrary() {
    const term = $("#fb-library-search").value.trim().toLowerCase();
    const groups = new Map();
    for (const item of state.options.nodeTypes) {
      if (item.type === "start") continue;
      if (term && !item.label.toLowerCase().includes(term)) continue;
      if (!groups.has(item.group)) groups.set(item.group, []);
      groups.get(item.group).push(item);
    }
    $("#fb-library-list").innerHTML = [...groups].map(([group, items]) => `
      <div class="fb-lib-group"><h4>${escapeHtml(group)}</h4>
        ${items.map((item) => `<div class="fb-lib-item ${item.available ? "" : "soon"}" draggable="${item.available}" data-type="${item.type}" role="button" tabindex="0">
          <i>${item.icon}</i>${escapeHtml(item.label)}${item.available ? "" : "<small>EM BREVE</small>"}</div>`).join("")}
      </div>`).join("");
  }
  $("#fb-library-search").addEventListener("input", renderLibrary);
  $("#fb-library-list").addEventListener("dragstart", (event) => {
    const item = event.target.closest(".fb-lib-item");
    if (!item) return;
    event.dataTransfer.setData("text/fb-node-type", item.dataset.type);
    event.dataTransfer.effectAllowed = "copy";
  });
  $("#fb-library-list").addEventListener("click", (event) => {
    const item = event.target.closest(".fb-lib-item");
    if (!item) return;
    const center = toGraphPoint(canvas.getBoundingClientRect().left + canvas.clientWidth / 2 - 112, canvas.getBoundingClientRect().top + canvas.clientHeight / 2 - 50);
    addNode(item.dataset.type, center);
  });
  canvas.addEventListener("dragover", (event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; });
  canvas.addEventListener("drop", (event) => {
    event.preventDefault();
    const type = event.dataTransfer.getData("text/fb-node-type");
    if (!type) return;
    const point = toGraphPoint(event.clientX, event.clientY);
    addNode(type, { x: point.x - 112, y: point.y - 20 });
  });

  // ---------- painel de propriedades -------------------------------------------
  function showPanel(name) {
    document.querySelectorAll(".fb-panel-tabs button").forEach((button) => button.classList.toggle("active", button.dataset.panel === name));
    $("#fb-panel-props").hidden = name !== "props";
    $("#fb-panel-test").hidden = name !== "test";
    $("#fb-panel-versions").hidden = name !== "versions";
    if (name === "versions") renderVersions();
  }
  document.querySelector(".fb-panel-tabs").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-panel]");
    if (button) showPanel(button.dataset.panel);
  });

  const categoryOptions = (selected, allowEmpty = true) => `${allowEmpty ? '<option value="">— nenhum —</option>' : '<option value="">Selecione o setor</option>'}${
    state.options.categories.map((category) => {
      const parent = state.options.categories.find((item) => item.id === category.parentId);
      return `<option value="${category.id}" ${category.id === selected ? "selected" : ""}>${escapeHtml(parent ? `${parent.name}: ${category.name}` : category.name)}</option>`;
    }).join("")}`;
  const select = (field, options, value) => `<select data-field="${field}">${Object.entries(options).map(([key, label]) => `<option value="${key}" ${key === value ? "selected" : ""}>${escapeHtml(label)}</option>`).join("")}</select>`;
  const variableChips = () => `<div class="fb-chips">${state.options.variables.slice(0, 12).map((variable) => `<button type="button" data-insert="{{${variable}}}">${variable}</button>`).join("")}</div>`;
  const variablesDatalist = () => `<datalist id="fb-vars">${state.options.variables.map((variable) => `<option value="${variable}"></option>`).join("")}</datalist>`;

  function nodeForm(node) {
    const c = node.config;
    switch (node.type) {
      case "start": return `
        <label>Quando iniciar ${select("trigger", { NEW_CONVERSATION: "Nova conversa (uma vez por sessão)", ANY_MESSAGE: "Nova conversa (sempre que voltar à fila sem setor)" }, c.trigger)}</label>
        <label>Mensagem inicial (opcional)<textarea data-field="initialMessage" placeholder="Olá {{contact.firstName}}!">${escapeHtml(c.initialMessage)}</textarea></label>
        ${variableChips()}
        <label>Categoria inicial (usada como setor padrão de handoff)<select data-field="categoryId">${categoryOptions(c.categoryId)}</select></label>
        <div><label>Canais (vazio = todos os canais do Bot)</label><div class="fb-list">${Object.entries(START_CHANNELS).map(([key, label]) => `<label class="fb-check"><input type="checkbox" data-channel="${key}" ${(c.channels || []).includes(key) ? "checked" : ""}> ${label}</label>`).join("")}</div></div>`;
      case "message": return `
        <label>Texto<textarea data-field="text" placeholder="Olá {{contact.firstName}}, como podemos ajudar?">${escapeHtml(c.text)}</textarea></label>
        ${variableChips()}
        <div><span class="fb-kicker">PRÉ-VISUALIZAÇÃO</span><div class="fb-preview" id="fb-preview">${escapeHtml(renderTemplate(c.text) || "…")}</div></div>`;
      case "question": return `
        <label>Pergunta<textarea data-field="text" placeholder="Qual modelo do seu Mibro?">${escapeHtml(c.text)}</textarea></label>
        ${variableChips()}
        <div class="fb-row">
          <label>Salvar em<input data-field="variable" list="fb-vars" value="${escapeHtml(c.variable)}" placeholder="customer.watchModel"></label>
          <label>Tipo de resposta ${select("answerType", ANSWER_TYPES, c.answerType)}</label>
        </div>
        <div class="fb-row">
          <label>Tentativas<input data-field="maxAttempts" type="number" min="1" max="10" value="${c.maxAttempts}"></label>
        </div>
        <label>Mensagem quando a resposta for inválida<input data-field="invalidMessage" value="${escapeHtml(c.invalidMessage)}" placeholder="Não consegui entender sua resposta..."></label>
        <p class="fb-note">Sem a saída "Resposta inválida" conectada, após as tentativas a conversa vai para atendimento humano.</p>`;
      case "menu": return `
        <label>Texto do menu<textarea data-field="text">${escapeHtml(c.text)}</textarea></label>
        <div><span class="fb-kicker">OPÇÕES</span><div class="fb-list" id="fb-menu-options">${(c.options || []).map((option, index) => `
          <div class="fb-list-item" data-index="${index}">
            <div class="fb-list-top"><b>${index + 1}</b><input data-option-field="label" value="${escapeHtml(option.label)}" placeholder="Nome da opção">
              <button type="button" class="fb-mini" data-option-move="-1" title="Subir">↑</button><button type="button" class="fb-mini" data-option-move="1" title="Descer">↓</button><button type="button" class="fb-mini danger" data-option-remove title="Remover">✕</button></div>
            <input data-option-field="keywords" value="${escapeHtml((option.keywords || []).join(", "))}" placeholder="Palavras-chave extras (opcional, separadas por vírgula)">
          </div>`).join("")}</div>
          <button type="button" class="fb-add" data-option-add>+ opção</button></div>
        <p class="fb-note">O cliente pode responder com o número, o nome da opção ou uma frase com ele ("quero suporte"). Cada opção tem sua própria saída no card.</p>
        <div class="fb-row"><label>Salvar escolha em<input data-field="variable" list="fb-vars" value="${escapeHtml(c.variable)}"></label>
          <label>Tentativas<input data-field="maxAttempts" type="number" min="1" max="10" value="${c.maxAttempts}"></label></div>
        <label>Mensagem para opção não reconhecida<input data-field="invalidMessage" value="${escapeHtml(c.invalidMessage)}"></label>`;
      case "condition": return `
        <label>Combinar regras ${select("match", { ALL: "Todas verdadeiras (E)", ANY: "Qualquer uma (OU)" }, c.match)}</label>
        <div class="fb-list" id="fb-rules">${(c.rules || []).map((rule, index) => `
          <div class="fb-rule" data-index="${index}">
            <input data-rule-field="left" list="fb-vars" value="${escapeHtml(rule.left)}" placeholder="bot.intent">
            <select data-rule-field="operator">${OPERATORS.map((op) => `<option ${op === rule.operator ? "selected" : ""}>${op}</option>`).join("")}</select>
            <input data-rule-field="right" value="${escapeHtml(rule.right)}" placeholder="valor" ${["exists", "not_exists"].includes(rule.operator) ? "disabled" : ""}>
            <button type="button" class="fb-mini danger" data-rule-remove>✕</button>
          </div>`).join("")}</div>
        <button type="button" class="fb-add" data-rule-add>+ regra</button>
        <p class="fb-note">Exemplos: <code>intent == wholesale</code>, <code>customer.cnpj != null</code>, <code>channel == META</code>. Saídas: Verdadeiro e Falso.</p>`;
      case "delay": return `
        <div class="fb-row"><label>Quanto<input data-field="amount" type="number" min="1" value="${c.amount}"></label>
          <label>Unidade ${select("unit", { SECONDS: "segundos", MINUTES: "minutos", HOURS: "horas" }, c.unit)}</label></div>
        <p class="fb-note">O servidor não fica esperando: a execução é agendada e retomada automaticamente. Máximo de 24 horas.</p>`;
      case "variable": return `
        <div class="fb-list" id="fb-assignments">${(c.assignments || []).map((item, index) => `
          <div class="fb-rule" data-index="${index}" style="grid-template-columns:1fr 1fr 24px">
            <input data-assign-field="key" list="fb-vars" value="${escapeHtml(item.key)}" placeholder="vars.origem">
            <input data-assign-field="value" value="${escapeHtml(item.value)}" placeholder="valor ou {{variavel}}">
            <button type="button" class="fb-mini danger" data-assign-remove>✕</button>
          </div>`).join("")}</div>
        <button type="button" class="fb-add" data-assign-add>+ variável</button>
        <p class="fb-note">Só é possível escrever em <code>customer.*</code>, <code>flow.*</code> e <code>vars.*</code>.</p>`;
      case "ai": return `
        <label>Modo ${select("mode", AI_MODES, c.mode)}</label>
        <div class="fb-row"><label>Provedor ${select("provider", Object.fromEntries(state.options.aiProviders.map((item) => [item.id, item.label])), c.provider)}</label>
          <label>Modelo (opcional)<input data-field="model" value="${escapeHtml(c.model)}" placeholder="padrão do Bot"></label></div>
        <label>Entrada<input data-field="input" value="${escapeHtml(c.input)}"></label>
        <label class="fb-check"><input type="checkbox" data-field="sendAnswer" ${c.sendAnswer ? "checked" : ""}> Enviar a resposta da IA ao cliente (modo Responder)</label>
        <p class="fb-note warn">A resposta passa pelos mesmos guards e gate de envio da IA atual. Nesta versão o envio de respostas de IA continua em <b>dry-run</b>: nada gerado pela IA sai para o cliente.</p>
        <p class="fb-note">Saídas disponíveis para os próximos nós: <code>bot.answer</code>, <code>bot.action</code>, <code>bot.intent</code>, <code>bot.product</code>, <code>bot.confidence</code>, <code>bot.needsHuman</code>, <code>bot.reason</code>. A base de conhecimento usada é a do RAG da IA local.</p>`;
      case "knowledge": return `
        <label>Pergunta<input data-field="query" value="${escapeHtml(c.query)}"></label>
        <div class="fb-row"><label>Produto (opcional)<input data-field="product" value="${escapeHtml(c.product)}" placeholder="{{bot.product}}"></label>
          <label>Máx. resultados<input data-field="limit" type="number" min="1" max="10" value="${c.limit}"></label></div>
        <p class="fb-note">Usa a Base de Conhecimento já existente. Resultado em <code>knowledge.result</code>, <code>knowledge.sources</code> e <code>knowledge.confidence</code>.</p>`;
      case "transfer_category": return `
        <label>Setor de destino<select data-field="categoryId">${categoryOptions(c.categoryId, false)}</select></label>
        <label>Mensagem ao cliente (opcional)<textarea data-field="message">${escapeHtml(c.message)}</textarea></label>
        <label>Motivo (histórico/auditoria)<input data-field="reason" value="${escapeHtml(c.reason)}"></label>
        <p class="fb-note">A conversa sai do Bot, entra na fila do setor sem responsável e a transferência fica registrada no histórico.</p>`;
      case "human_handoff": return `
        <label>Motivo do handoff<input data-field="reason" value="${escapeHtml(c.reason)}" placeholder="{{bot.reason}}"></label>
        <label>Setor (opcional)<select data-field="categoryId">${categoryOptions(c.categoryId)}</select></label>
        <label>Mensagem ao cliente (opcional)<textarea data-field="message">${escapeHtml(c.message)}</textarea></label>`;
      case "end": return `
        <label>Mensagem final (opcional)<textarea data-field="message">${escapeHtml(c.message)}</textarea></label>
        <label class="fb-check"><input type="checkbox" data-field="finalizeConversation" ${c.finalizeConversation !== false ? "checked" : ""}> Finalizar a conversa</label>
        <p class="fb-note">Desmarcado: o Bot encerra e a conversa fica visível para a equipe.</p>`;
      default: return `<p class="fb-note warn">Este elemento estará disponível em uma próxima versão. Fluxos com ele não podem ser publicados.</p>`;
    }
  }

  function renderPanel() {
    const panel = $("#fb-panel-props");
    if (state.selectedEdge) {
      panel.innerHTML = `<span class="fb-kicker">CONEXÃO</span><h3>Conexão selecionada</h3><div class="fb-panel-actions"><button type="button" class="fb-ghost" id="fb-delete-edge">Excluir conexão</button></div>`;
      $("#fb-delete-edge").addEventListener("click", () => deleteEdge(state.selectedEdge));
      return;
    }
    const node = nodeByKey(state.selectedNode);
    if (!node) {
      panel.innerHTML = `<div class="fb-empty">Selecione um nó para configurar.<br><br>Arraste da biblioteca para o canvas, conecte a saída (○) de um nó na entrada de outro e clique em uma conexão para excluí-la.<br><br><b>Atalhos:</b> Ctrl+S salvar • Ctrl+Z/Y desfazer/refazer • Ctrl+D duplicar • Delete excluir</div>`;
      return;
    }
    const meta = typeMeta(node.type);
    const errors = state.errors.filter((error) => error.nodeKey === node.key);
    panel.innerHTML = `
      <span class="fb-kicker">${escapeHtml(meta.label.toUpperCase())}</span><h3>${escapeHtml(node.name)}</h3>
      ${errors.length ? `<div class="fb-node-errors"><b>Corrija antes de publicar:</b><ul>${errors.map((error) => `<li>${escapeHtml(error.message)}</li>`).join("")}</ul></div>` : ""}
      <div class="fb-form">
        <label>Nome do nó<input data-name value="${escapeHtml(node.name)}" maxlength="120"></label>
        ${nodeForm(node)}
      </div>
      ${variablesDatalist()}
      <div class="fb-panel-actions">
        <button type="button" class="fb-ghost" data-panel-action="duplicate" ${node.type === "start" ? "disabled" : ""}>Duplicar</button>
        <button type="button" class="fb-ghost" data-panel-action="delete">Excluir nó</button>
      </div>`;
  }

  // Um snapshot de desfazer por "sessão de edição" do campo (foco), não por tecla.
  function beginEdit() {
    if (!state.editSnapshotTaken) { pushHistory(); state.editSnapshotTaken = true; }
  }
  const panelProps = $("#fb-panel-props");
  panelProps.addEventListener("focusout", () => { state.editSnapshotTaken = false; });

  function refreshNodeCard() {
    renderNodes();
    renderEdges();
  }

  panelProps.addEventListener("input", (event) => {
    const node = nodeByKey(state.selectedNode);
    if (!node) return;
    const target = event.target;
    const c = node.config;
    if (target.matches("[data-name]")) { beginEdit(); node.name = target.value; refreshNodeCard(); return; }
    if (target.matches("[data-field]")) {
      beginEdit();
      const field = target.dataset.field;
      if (target.type === "checkbox") c[field] = target.checked;
      else if (target.type === "number") c[field] = Number(target.value);
      else if (field === "categoryId") c[field] = target.value || (node.type === "start" ? null : "");
      else c[field] = target.value;
      if (field === "text" && $("#fb-preview")) $("#fb-preview").textContent = renderTemplate(c.text) || "…";
      refreshNodeCard();
      return;
    }
    if (target.matches("[data-channel]")) {
      beginEdit();
      c.channels = [...panelProps.querySelectorAll("[data-channel]:checked")].map((input) => input.dataset.channel);
      state.editSnapshotTaken = false;
      return;
    }
    const optionRow = target.closest("#fb-menu-options .fb-list-item");
    if (optionRow && target.dataset.optionField) {
      beginEdit();
      const option = c.options[Number(optionRow.dataset.index)];
      if (target.dataset.optionField === "keywords") option.keywords = target.value.split(",").map((word) => word.trim()).filter(Boolean);
      else option.label = target.value;
      refreshNodeCard();
      return;
    }
    const ruleRow = target.closest("#fb-rules .fb-rule");
    if (ruleRow && target.dataset.ruleField) {
      beginEdit();
      c.rules[Number(ruleRow.dataset.index)][target.dataset.ruleField] = target.value;
      if (target.dataset.ruleField === "operator") renderPanel();
      refreshNodeCard();
      return;
    }
    const assignRow = target.closest("#fb-assignments .fb-rule");
    if (assignRow && target.dataset.assignField) {
      beginEdit();
      c.assignments[Number(assignRow.dataset.index)][target.dataset.assignField] = target.value;
      refreshNodeCard();
    }
  });
  panelProps.addEventListener("change", (event) => {
    if (event.target.matches("select[data-field], select[data-rule-field]")) state.editSnapshotTaken = false;
  });

  panelProps.addEventListener("click", (event) => {
    const node = nodeByKey(state.selectedNode);
    if (!node) return;
    const c = node.config;
    const button = event.target.closest("button");
    if (!button) return;
    const structural = (fn) => { pushHistory(); fn(); state.editSnapshotTaken = false; render(); renderPanel(); };
    if (button.dataset.insert) {
      const field = panelProps.querySelector("textarea[data-field]");
      if (!field) return;
      beginEdit();
      const start = field.selectionStart ?? field.value.length;
      field.value = `${field.value.slice(0, start)}${button.dataset.insert}${field.value.slice(field.selectionEnd ?? start)}`;
      c[field.dataset.field] = field.value;
      if ($("#fb-preview")) $("#fb-preview").textContent = renderTemplate(field.value);
      refreshNodeCard();
      field.focus();
      return;
    }
    if (button.dataset.panelAction === "delete") return deleteNode(node.key);
    if (button.dataset.panelAction === "duplicate") return duplicateNode(node.key);
    if (button.hasAttribute("data-option-add")) return structural(() => c.options.push({ id: uid("o"), label: `Opção ${c.options.length + 1}`, keywords: [] }));
    const optionRow = button.closest("#fb-menu-options .fb-list-item");
    if (optionRow) {
      const index = Number(optionRow.dataset.index);
      if (button.hasAttribute("data-option-remove")) {
        return structural(() => {
          const [removed] = c.options.splice(index, 1);
          state.graph.edges = state.graph.edges.filter((edge) => !(edge.source === node.key && edge.sourceHandle === `opt:${removed.id}`));
        });
      }
      if (button.dataset.optionMove) {
        const to = index + Number(button.dataset.optionMove);
        if (to < 0 || to >= c.options.length) return;
        return structural(() => { const [item] = c.options.splice(index, 1); c.options.splice(to, 0, item); });
      }
    }
    if (button.hasAttribute("data-rule-add")) return structural(() => c.rules.push({ left: "", operator: "==", right: "" }));
    if (button.hasAttribute("data-rule-remove")) return structural(() => c.rules.splice(Number(button.closest(".fb-rule").dataset.index), 1));
    if (button.hasAttribute("data-assign-add")) return structural(() => c.assignments.push({ key: "vars.", value: "" }));
    if (button.hasAttribute("data-assign-remove")) return structural(() => c.assignments.splice(Number(button.closest(".fb-rule").dataset.index), 1));
  });

  // ---------- salvar / validar / publicar --------------------------------------
  function renderHeader() {
    const flow = state.flow;
    $("#fb-bot-name").textContent = state.bot ? `Bot • ${state.bot.name}` : "";
    $("#back-to-bot").href = "/bots";
    $("#fb-flow-select").innerHTML = state.flows.map((item) => `<option value="${item.id}" ${item.id === flow?.id ? "selected" : ""}>${escapeHtml(item.name)}${item.isDefault ? " (padrão)" : ""}</option>`).join("");
    $("#fb-flow-name").value = flow?.name || "";
    $("#fb-status").textContent = STATUS_LABELS[flow?.status] || "—";
    $("#fb-status").className = `status-badge ${flow?.status === "ACTIVE" ? "ACTIVE" : flow?.status === "INACTIVE" ? "PAUSED" : ""}`;
    $("#fb-version").textContent = flow?.activeVersion ? `versão publicada: v${flow.activeVersion}` : "sem versão publicada";
    $("#fb-toggle-status").textContent = flow?.status === "ACTIVE" ? "Desativar" : "Ativar";
    $("#fb-toggle-status").disabled = !flow?.activeVersion;
    $("#fb-dirty").hidden = !state.dirty;
    const usingFlow = state.bot?.executionMode === "FLOW_BUILDER";
    $("#fb-mode-text").textContent = usingFlow ? "Este Bot executa o fluxo padrão do Editor Visual." : "Este Bot usa o motor atual (intenções/triagem).";
    $("#fb-mode-toggle").textContent = usingFlow ? "Voltar ao motor atual" : "Usar Editor Visual";
  }

  async function saveDraft({ quiet = false } = {}) {
    if (!state.flow) return false;
    try {
      const saved = await api(flowUrl("/draft"), {
        method: "PUT",
        body: JSON.stringify({ name: $("#fb-flow-name").value, graph: state.graph, expectedDraftUpdatedAt: state.flow.draftUpdatedAt }),
      });
      applyFlow(saved, { keepView: true });
      state.dirty = false;
      renderHeader();
      if (!quiet) toast("Rascunho salvo. A versão publicada não foi alterada.");
      return true;
    } catch (error) {
      toast(error.message, true);
      return false;
    }
  }

  function showValidation(errors, { ok = false } = {}) {
    state.errors = errors;
    const box = $("#fb-validation");
    if (ok) {
      box.hidden = false;
      box.className = "fb-validation ok";
      box.innerHTML = "<b>✓ Fluxo válido</b>Nenhum problema encontrado.";
      setTimeout(() => { box.hidden = true; }, 3500);
    } else if (errors.length) {
      box.hidden = false;
      box.className = "fb-validation";
      box.innerHTML = `<b>${errors.length} problema(s) para publicar</b><ul>${errors.map((error) => `<li><button type="button" data-goto="${escapeHtml(error.nodeKey || "")}">${escapeHtml(error.nodeKey ? `${nodeByKey(error.nodeKey)?.name || error.nodeKey}: ` : "")}${escapeHtml(error.message)}</button></li>`).join("")}</ul>`;
    } else {
      box.hidden = true;
    }
    render();
    renderPanel();
  }
  $("#fb-validation").addEventListener("click", (event) => {
    const key = event.target.closest("[data-goto]")?.dataset.goto;
    if (!key || !nodeByKey(key)) return;
    selectNode(key);
    const node = nodeByKey(key);
    state.graph.viewport.x = canvas.clientWidth / 2 - (node.x + 112) * state.graph.viewport.zoom;
    state.graph.viewport.y = canvas.clientHeight / 2 - (node.y + 50) * state.graph.viewport.zoom;
    applyViewport();
  });

  async function validate() {
    try {
      const result = await api(flowUrl("/validate"), { method: "POST", body: JSON.stringify({ graph: state.graph }) });
      showValidation(result.errors, { ok: result.valid });
      return result.valid;
    } catch (error) { toast(error.message, true); return false; }
  }

  async function publish() {
    if (!(await saveDraft({ quiet: true }))) return;
    try {
      const published = await api(flowUrl("/publish"), { method: "POST", body: "{}" });
      applyFlow(published, { keepView: true });
      showValidation([], { ok: true });
      await loadFlowList();
      toast(`Versão v${published.activeVersion} publicada. A versão anterior continua disponível para rollback.`);
    } catch (error) {
      if (error.body?.errors) showValidation(error.body.errors);
      toast(error.message, true);
    }
  }

  async function toggleStatus() {
    try {
      const updated = await api(flowUrl("/status"), { method: "PATCH", body: JSON.stringify({ status: state.flow.status === "ACTIVE" ? "INACTIVE" : "ACTIVE" }) });
      applyFlow(updated, { keepView: true, keepGraph: true });
      await loadFlowList();
      toast(updated.status === "ACTIVE" ? "Fluxo ativado." : "Fluxo desativado.");
    } catch (error) { toast(error.message, true); }
  }

  async function toggleExecutionMode() {
    const toFlow = state.bot.executionMode !== "FLOW_BUILDER";
    const question = toFlow
      ? "Usar o fluxo padrão publicado como motor deste Bot?\n\nEle só responde clientes quando o Bot estiver ATIVO e com a auto-resposta ligada. Respostas geradas por IA continuam em dry-run."
      : "Voltar este Bot para o motor atual? O fluxo continua salvo.";
    if (!window.confirm(question)) return;
    try {
      const result = await api(`/api/bots/${encodeURIComponent(botId)}/execution-mode`, { method: "PATCH", body: JSON.stringify({ executionMode: toFlow ? "FLOW_BUILDER" : "LEGACY" }) });
      state.bot.executionMode = result.executionMode;
      renderHeader();
      toast(toFlow ? "Bot agora usa o Editor Visual." : "Bot voltou ao motor atual.");
    } catch (error) { toast(error.message, true); }
  }

  $("#fb-save").addEventListener("click", () => saveDraft());
  $("#fb-validate").addEventListener("click", validate);
  $("#fb-publish").addEventListener("click", publish);
  $("#fb-toggle-status").addEventListener("click", toggleStatus);
  $("#fb-mode-toggle").addEventListener("click", toggleExecutionMode);
  $("#fb-flow-name").addEventListener("input", markDirty);
  $("#fb-test").addEventListener("click", () => { showPanel("test"); resetTest(); $("#fb-test-input").focus(); });

  // ---------- versões -------------------------------------------------------------
  function renderVersions() {
    const panel = $("#fb-panel-versions");
    const versions = state.flow?.versions || [];
    panel.innerHTML = `<span class="fb-kicker">VERSÕES PUBLICADAS</span><h3>Histórico</h3>
      <p class="fb-note">Salvar altera só o rascunho. Publicar cria uma nova versão; as anteriores ficam guardadas para rollback. Conversas em andamento terminam na versão em que começaram.</p>
      <div style="margin-top:10px">${versions.length ? versions.map((version) => `
        <div class="fb-version-item ${version.version === state.flow.activeVersion ? "active" : ""}">
          <b>v${version.version}${version.label ? ` • ${escapeHtml(version.label)}` : ""}${version.version === state.flow.activeVersion ? " • em uso" : ""}</b>
          <small>${new Date(version.createdAt).toLocaleString("pt-BR")} • ${escapeHtml(version.publishedByName || "—")}</small>
          <div>
            ${version.version === state.flow.activeVersion ? "" : `<button type="button" class="fb-ghost" data-rollback="${version.version}">Usar esta versão</button>`}
            <button type="button" class="fb-ghost" data-restore="${version.version}">Copiar para o rascunho</button>
          </div>
        </div>`).join("") : '<div class="fb-empty">Nenhuma versão publicada ainda.</div>'}</div>`;
  }
  $("#fb-panel-versions").addEventListener("click", async (event) => {
    const rollback = event.target.closest("[data-rollback]")?.dataset.rollback;
    const restore = event.target.closest("[data-restore]")?.dataset.restore;
    try {
      if (rollback) {
        if (!window.confirm(`Voltar a versão em uso para v${rollback}? O rascunho não é alterado.`)) return;
        applyFlow(await api(flowUrl(`/versions/${rollback}/rollback`), { method: "POST", body: "{}" }), { keepView: true, keepGraph: true });
        toast(`Versão v${rollback} em uso.`);
      } else if (restore) {
        if (state.dirty && !window.confirm("Substituir o rascunho atual (com alterações não salvas) por esta versão?")) return;
        applyFlow(await api(flowUrl(`/versions/${restore}/restore-draft`), { method: "POST", body: "{}" }), { keepView: false });
        state.undo = []; state.redo = []; updateHistoryButtons();
        toast(`Rascunho substituído pela v${restore}. Publique para colocar em uso.`);
      }
      renderVersions();
    } catch (error) { toast(error.message, true); }
  });

  // ---------- simulador / debug --------------------------------------------------
  function resetTest() {
    state.test = { simState: null, visited: new Set(), errored: new Set(), current: null, takenEdges: new Set(), turns: [] };
    $("#fb-test-transcript").innerHTML = "";
    $("#fb-test-trace").innerHTML = "";
    canvas.classList.add("testing");
    $("#fb-test-legend").hidden = false;
    render();
  }
  function stopTest() {
    state.test = null;
    canvas.classList.remove("testing");
    $("#fb-test-legend").hidden = true;
    render();
  }
  $("#fb-test-reset").addEventListener("click", resetTest);
  $("#fb-test-source").addEventListener("change", resetTest);

  function bubble(type, text) {
    $("#fb-test-transcript").insertAdjacentHTML("beforeend", `<div class="fb-bubble ${type}">${escapeHtml(text)}</div>`);
    $("#fb-test-transcript").scrollTop = $("#fb-test-transcript").scrollHeight;
  }

  $("#fb-test-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.test) resetTest();
    const input = $("#fb-test-input");
    const message = input.value.trim();
    const finished = state.test.simState && ["HANDED_OFF", "COMPLETED", "FAILED"].includes(state.test.simState.status);
    if (finished) { toast("A simulação terminou. Clique em Reiniciar para testar de novo."); return; }
    if (!message && state.test.simState) return;
    input.value = "";
    if (message) bubble("customer", message);
    try {
      const source = $("#fb-test-source").value;
      const body = { message, state: state.test.simState, source, ...(source === "DRAFT" ? { graph: state.graph } : {}) };
      const result = await api(flowUrl("/simulate"), { method: "POST", body: JSON.stringify(body) });
      state.test.simState = result.state;
      for (const output of result.outputs) bubble(output.type === "ai" ? "ai" : output.type === "event" ? "event" : "bot", output.type === "ai" ? `IA: ${output.text}\n(${output.wouldSend ? "enviaria" : "não enviaria"} • ${output.sendMode})` : output.text);
      for (const entry of result.trace) {
        state.test.visited.add(entry.nodeKey);
        if (entry.result === "ERROR") state.test.errored.add(entry.nodeKey);
        if (entry.branch) state.test.takenEdges.add(`${entry.nodeKey}::${entry.branch}`);
      }
      state.test.current = ["WAITING_CUSTOMER", "WAITING_TIMER"].includes(result.status) ? result.currentNodeKey : null;
      state.test.turns.push({ message, trace: result.trace, status: result.status });
      renderTrace();
      if (!["WAITING_CUSTOMER", "WAITING_TIMER", "RUNNING"].includes(result.status)) bubble("event", `Fluxo ${EXEC_STATUS_LABELS[result.status] || result.status}`);
      render();
    } catch (error) {
      bubble("event", `Erro: ${error.message}`);
    }
  });

  function renderTrace() {
    $("#fb-test-trace").innerHTML = state.test.turns.map((turn, index) => `
      <div class="fb-trace-turn">${index === 0 ? "INÍCIO" : `CLIENTE: "${escapeHtml(turn.message)}"`}</div>
      ${turn.trace.map((entry) => {
        const next = entry.nextNodeKey ? nodeByKey(entry.nextNodeKey)?.name || entry.nextNodeKey : "";
        const branch = entry.branch ? (entry.branch.startsWith("opt:") ? outputsFor(nodeByKey(entry.nodeKey) || { type: "", config: {} }).find((output) => output.handle === entry.branch)?.label || entry.branch : OUTPUT_LABELS[entry.branch] || entry.branch) : "";
        return `<div class="fb-trace-item"><span class="res ${entry.result}">${RESULT_LABELS[entry.result] || entry.result}</span>
          <div><b>${escapeHtml(entry.nodeName || entry.nodeKey)}</b><br><small>${escapeHtml([branch && `saída: ${branch}`, next && `→ ${next}`, entry.error].filter(Boolean).join(" "))}</small></div>
          <small>${entry.durationMs}ms</small></div>`;
      }).join("")}`).join("");
  }

  // O painel de teste liga o modo debug; voltar às propriedades desliga.
  document.querySelector(".fb-panel-tabs").addEventListener("click", (event) => {
    const name = event.target.closest("button[data-panel]")?.dataset.panel;
    if (name === "test" && !state.test) resetTest();
    if (name && name !== "test" && state.test) stopTest();
  });

  // ---------- carregamento ------------------------------------------------------------
  function applyFlow(flow, { keepView = false, keepGraph = false } = {}) {
    const viewport = state.graph.viewport;
    state.flow = flow;
    if (!keepGraph) {
      state.graph = clone(flow.graph);
      state.graph.viewport ||= { x: 0, y: 0, zoom: 1 };
      if (keepView) state.graph.viewport = viewport;
    }
    if (flow.bot) state.bot = flow.bot;
    if (state.selectedNode && !nodeByKey(state.selectedNode)) state.selectedNode = null;
    renderHeader();
    render();
    renderPanel();
  }

  async function loadFlowList() {
    state.flows = await api(`/api/bots/${encodeURIComponent(botId)}/visual-flows`);
    renderHeader();
  }

  async function openFlow(flowId) {
    if (state.dirty && !window.confirm("Existem alterações não salvas. Descartar?")) { renderHeader(); return; }
    const flow = await api(`/api/bots/${encodeURIComponent(botId)}/visual-flows/${encodeURIComponent(flowId)}`);
    state.dirty = false; state.undo = []; state.redo = []; state.errors = []; state.selectedNode = null;
    $("#fb-validation").hidden = true;
    if (state.test) stopTest();
    showPanel("props");
    applyFlow(flow);
    updateHistoryButtons();
    history.replaceState(null, "", `/flow-builder?botId=${encodeURIComponent(botId)}&flowId=${encodeURIComponent(flowId)}`);
    if (!flow.graph.viewport || (flow.graph.viewport.x === 0 && flow.graph.viewport.y === 0 && flow.graph.viewport.zoom === 1)) requestAnimationFrame(fitView);
  }

  $("#fb-flow-select").addEventListener("change", (event) => openFlow(event.target.value).catch((error) => toast(error.message, true)));
  $("#fb-new-flow").addEventListener("click", async () => {
    const name = window.prompt("Nome do novo fluxo:", "Novo fluxo");
    if (!name?.trim()) return;
    try {
      const created = await api(`/api/bots/${encodeURIComponent(botId)}/visual-flows`, { method: "POST", body: JSON.stringify({ name }) });
      await loadFlowList();
      await openFlow(created.id);
    } catch (error) { toast(error.message, true); }
  });

  window.addEventListener("beforeunload", (event) => {
    if (state.dirty) { event.preventDefault(); event.returnValue = ""; }
  });
  window.addEventListener("resize", () => renderEdges());

  $("#theme-toggle").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("mibro-theme", next); } catch { /* preferência só local */ }
  });

  async function init() {
    if (!botId) { location.replace("/bots"); return; }
    try {
      state.options = await api(`/api/bots/${encodeURIComponent(botId)}/visual-flow-options`);
      renderLibrary();
      await loadFlowList();
      let flowId = params.get("flowId");
      if (!flowId || !state.flows.some((flow) => flow.id === flowId)) {
        flowId = state.flows[0]?.id;
        if (!flowId) {
          const created = await api(`/api/bots/${encodeURIComponent(botId)}/visual-flows`, { method: "POST", body: JSON.stringify({ name: "Fluxo principal" }) });
          await loadFlowList();
          flowId = created.id;
        }
      }
      await openFlow(flowId);
    } catch (error) {
      toast(error.message, true);
      $("#fb-bot-name").textContent = "Não foi possível abrir o editor";
    }
  }
  init();
})();
