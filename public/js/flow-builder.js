// Editor Visual de Fluxos (Flow Builder) — único modo de criar/editar Bots.
// Canvas próprio em JS puro (sem dependência nova): nós em DOM, conexões em
// SVG. Toda regra de permissão, validação e execução fica no backend
// (bot-visual-flow-*.js); o editor só monta o grafo e chama a API. Sem IA.
(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const params = new URLSearchParams(location.search);
  const botId = params.get("botId");

  const GROUP_ORDER = ["FLUXO", "MENSAGENS", "CONTROLE", "DADOS", "ATENDIMENTO", "INTEGRAÇÕES"];
  const OUTPUT_LABELS = { next: "Próximo", invalid: "Resposta inválida", true: "Verdadeiro", false: "Falso", error: "Erro" };
  const RESULT_LABELS = { OK: "ok", DONE: "fim", WAITING: "aguardando", ERROR: "erro" };
  const STATUS_LABELS = { DRAFT: "RASCUNHO", ACTIVE: "ATIVO", INACTIVE: "INATIVO" };
  const EXEC_STATUS_LABELS = {
    RUNNING: "executando", WAITING_CUSTOMER: "aguardando o cliente", WAITING_TIMER: "aguardando intervalo",
    HANDED_OFF: "entregue para a equipe", COMPLETED: "concluído", FAILED: "falhou",
  };
  const ANSWER_TYPES = { TEXT: "Texto livre", NUMBER: "Número", PHONE: "Telefone", EMAIL: "E-mail", CPF_CNPJ: "CPF/CNPJ", YES_NO: "Confirmação Sim/Não" };
  const MEDIA_KINDS = { IMAGE: "Imagem", AUDIO: "Áudio", VIDEO: "Vídeo", DOCUMENT: "Documento" };
  const MEDIA_ACCEPT = { IMAGE: "image/jpeg,image/png", AUDIO: "audio/*", VIDEO: "video/mp4,video/3gpp", DOCUMENT: ".pdf,.txt,.doc,.docx,.xls,.xlsx,.ppt,.pptx" };
  const OPERATORS = ["==", "!=", "contains", "not_contains", ">", "<", ">=", "<=", "exists", "not_exists"];
  const START_CHANNELS = { META: "WhatsApp", INSTAGRAM_DIRECT: "Instagram Direct", FACEBOOK_MESSENGER: "Messenger", EMAIL: "E-mail" };
  const SAMPLE_CONTEXT = {
    contact: { name: "Maria Silva", firstName: "Maria", phone: "5511999990000", email: "maria@exemplo.com", greeting: "Olá, Maria", greetingComma: ", Maria" },
    conversation: { id: "123", channel: "META", withinBusinessHours: true },
    bot: { name: "Atendimento", businessHours: "segunda a sexta-feira, das 8h às 17h", withinBusinessHours: true },
    flow: { selectedOption: "Suporte", lastAnswer: "12345", lastMessage: "Olá" }, customer: { orderNumber: "12345" }, vars: {}, custom: {},
  };
  const NODE_WIDTH = 224;
  const CLIPBOARD_KEY = "mibro-flow-clipboard";

  const state = {
    options: null, bot: null, flows: [], flow: null,
    graph: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
    selection: new Set(), selectedEdge: null, dirty: false,
    undo: [], redo: [], editSnapshotTaken: false,
    errors: [], warnings: [], test: null, clipboard: null,
  };

  // ---------- utilidades --------------------------------------------------
  async function api(url, options = {}) {
    const isForm = options.body instanceof FormData;
    const headers = { ...(options.body && !isForm ? { "Content-Type": "application/json" } : {}) };
    const response = await fetch(url, { ...options, headers });
    if (response.status === 401) { location.replace("/login.html"); throw new Error("Sessão encerrada."); }
    const body = response.status === 204 ? null : await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(body?.error || "Não foi possível concluir a operação."), { status: response.status, body });
    return body;
  }
  const botUrl = (suffix = "") => `/api/bots/${encodeURIComponent(botId)}${suffix}`;
  const flowUrl = (suffix = "") => botUrl(`/visual-flows/${encodeURIComponent(state.flow.id)}${suffix}`);
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
  const typeMeta = (type) => state.options?.nodeTypes.find((item) => item.type === type)
    || (type === "removed" ? { label: "Nó removido", icon: "⚠", outputs: [], optionalOutputs: [], terminal: false } : { label: type, icon: "?", outputs: [], optionalOutputs: [] });
  const nodeByKey = (key) => state.graph.nodes.find((node) => node.key === key);
  const primaryKey = () => (state.selection.size === 1 ? [...state.selection][0] : null);
  const libraryText = (key) => state.options?.responses.find((item) => item.key === key)?.text;
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
    for (const key of [...state.selection]) if (!nodeByKey(key)) state.selection.delete(key);
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

  // ---------- saídas e resumo de cada nó ------------------------------------
  function outputsFor(node) {
    const meta = typeMeta(node.type);
    if (meta.terminal) return [];
    const optional = new Set(meta.optionalOutputs || []);
    const outputs = [];
    if (node.type === "menu") {
      (node.config.options || []).forEach((option, index) => outputs.push({ handle: `opt:${option.id}`, label: `${index + 1}. ${option.label || "Opção"}` }));
    }
    for (const handle of meta.outputs || []) outputs.push({ handle, label: OUTPUT_LABELS[handle] || handle, optional: optional.has(handle) });
    return outputs;
  }

  function summaryFor(node) {
    const c = node.config || {};
    const categoryName = (id) => state.options?.categories.find((item) => item.id === id)?.name;
    const userName = (id) => state.options?.users.find((item) => item.id === id)?.name;
    switch (node.type) {
      case "start": return [c.trigger === "ANY_MESSAGE" ? "Qualquer mensagem" : "Nova conversa", c.initialMessage].filter(Boolean).join("\n");
      case "message": return c.source === "LIBRARY" ? (c.responseKey ? `📚 ${c.responseKey}` : "Selecione a resposta") : (c.text || "Sem texto");
      case "question": return `${c.text || "Sem texto"}\n→ ${c.variable} (${ANSWER_TYPES[c.answerType] || c.answerType})`;
      case "menu": return `${c.text || "Sem texto"}${c.display === "LIST" ? "\n(lista do WhatsApp)" : ""}`;
      case "media": return `${MEDIA_KINDS[c.kind] || c.kind}: ${c.fileName || "envie o arquivo"}`;
      case "delay": return `Aguardar ${c.amount} ${{ SECONDS: "segundo(s)", MINUTES: "minuto(s)", HOURS: "hora(s)" }[c.unit] || ""}`;
      case "condition": return (c.rules || []).map((rule) => `${rule.left} ${rule.operator} ${rule.right}`).join(c.match === "ANY" ? "\nOU " : "\nE ") || "Sem regras";
      case "variable": return (c.assignments || []).map((item) => `${item.key} = ${item.value}`).join("\n") || "Nenhuma variável";
      case "transfer_category": return categoryName(c.categoryId) ? `Setor: ${categoryName(c.categoryId)}` : "Selecione o setor";
      case "transfer_user": return userName(c.userId) ? `Atendente: ${userName(c.userId)}` : "Selecione o atendente";
      case "human_handoff": return c.reason || (categoryName(c.categoryId) ? `Setor: ${categoryName(c.categoryId)}` : "Entregar para a equipe");
      case "end": return c.finalizeConversation === false ? "Encerra o Bot (conversa continua)" : "Finaliza a conversa";
      case "goto_flow": return state.options?.flows.find((flow) => flow.id === c.flowId)?.name ? `→ ${state.options.flows.find((flow) => flow.id === c.flowId).name}` : "Selecione o fluxo";
      case "webhook": return c.endpointKey ? `${c.endpointKey} → ${c.resultVariable}` : "Selecione o endpoint";
      case "removed": return `Nó "${c.originalType || "antigo"}" não existe mais (IA removida). Exclua para publicar.`;
      default: return "";
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
    renderMinimap();
  }

  function nodeClasses(node) {
    const classes = ["fb-node", node.type];
    if (state.selection.has(node.key)) classes.push("selected");
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
      const nodeErrors = state.errors.filter((error) => error.nodeKey === node.key);
      const outputs = outputsFor(node).map((output) => `
        <div class="fb-output ${output.optional ? "optional" : ""} ${output.handle}">${escapeHtml(output.label)}
          <span class="fb-handle out ${connected.has(`${node.key}::${output.handle}`) ? "connected" : ""}" data-handle="${escapeHtml(output.handle)}" title="Arraste para conectar"></span>
        </div>`).join("");
      return `
        <div class="${nodeClasses(node)}" data-key="${escapeHtml(node.key)}" style="left:${node.x}px;top:${node.y}px">
          ${node.type === "start" ? "" : '<span class="fb-handle in" title="Entrada"></span>'}
          ${nodeErrors.length ? `<span class="fb-error-badge" title="${escapeHtml(nodeErrors.map((error) => error.message).join("\n"))}">${nodeErrors.length}</span>` : ""}
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
    updateSelectionInfo();
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

  function nodeSize(node) {
    const element = nodesEl.querySelector(`.fb-node[data-key="${CSS.escape(node.key)}"]`);
    return { width: element?.offsetWidth || NODE_WIDTH, height: element?.offsetHeight || 110 };
  }

  // Minimapa: visão geral do grafo + retângulo da área visível; clicar
  // centraliza o canvas naquele ponto.
  function renderMinimap() {
    const svg = $("#fb-minimap");
    if (!svg || !state.graph.nodes.length) { if (svg) svg.innerHTML = ""; return; }
    const boxes = state.graph.nodes.map((node) => ({ node, ...nodeSize(node) }));
    const { x, y, zoom } = state.graph.viewport;
    const view = { x: -x / zoom, y: -y / zoom, w: canvas.clientWidth / zoom, h: canvas.clientHeight / zoom };
    const minX = Math.min(view.x, ...boxes.map((box) => box.node.x)) - 40;
    const minY = Math.min(view.y, ...boxes.map((box) => box.node.y)) - 40;
    const maxX = Math.max(view.x + view.w, ...boxes.map((box) => box.node.x + box.width)) + 40;
    const maxY = Math.max(view.y + view.h, ...boxes.map((box) => box.node.y + box.height)) + 40;
    svg.setAttribute("viewBox", `${minX} ${minY} ${maxX - minX} ${maxY - minY}`);
    svg.dataset.bounds = JSON.stringify({ minX, minY, width: maxX - minX, height: maxY - minY });
    svg.innerHTML = boxes.map((box) => `<rect class="mm-node ${box.node.type} ${state.selection.has(box.node.key) ? "selected" : ""}" x="${box.node.x}" y="${box.node.y}" width="${box.width}" height="${box.height}" rx="12"></rect>`).join("")
      + `<rect class="mm-view" x="${view.x}" y="${view.y}" width="${view.w}" height="${view.h}"></rect>`;
  }
  $("#fb-minimap").addEventListener("mousedown", (event) => {
    event.stopPropagation();
    const svg = event.currentTarget;
    const bounds = JSON.parse(svg.dataset.bounds || "null");
    if (!bounds) return;
    const rect = svg.getBoundingClientRect();
    const gx = bounds.minX + ((event.clientX - rect.left) / rect.width) * bounds.width;
    const gy = bounds.minY + ((event.clientY - rect.top) / rect.height) * bounds.height;
    const { zoom } = state.graph.viewport;
    state.graph.viewport.x = canvas.clientWidth / 2 - gx * zoom;
    state.graph.viewport.y = canvas.clientHeight / 2 - gy * zoom;
    applyViewport();
    markViewportDirty();
  });

  function render() {
    renderNodes();
    renderEdges();
    applyViewport();
  }

  // ---------- seleção -----------------------------------------------------------
  function setSelection(keys) {
    state.selection = new Set(keys);
    state.selectedEdge = null;
    renderNodes();
    renderEdges();
    renderMinimap();
    if (state.selection.size) showPanel("props");
    renderPanel();
  }
  function updateSelectionInfo() {
    const count = state.selection.size;
    $("#fb-selection-info").textContent = count > 1 ? `${count} nós selecionados` : "";
    $("#fb-align-left").disabled = count < 2;
    $("#fb-align-top").disabled = count < 2;
    $("#fb-distribute").disabled = count < 3;
    $("#fb-copy").disabled = !count;
  }

  // ---------- canvas: interação --------------------------------------------
  function toGraphPoint(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const { x, y, zoom } = state.graph.viewport;
    return { x: (clientX - rect.left - x) / zoom, y: (clientY - rect.top - y) / zoom };
  }

  let drag = null; // { kind: "pan"|"nodes"|"connect"|"box", ... }

  canvas.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    const handle = event.target.closest(".fb-handle.out");
    const nodeEl = event.target.closest(".fb-node");
    const edgeEl = event.target.closest("[data-edge]");
    if (event.target.closest(".fb-zoom, .fb-validation, .fb-test-legend, .fb-toolbar, .fb-minimap")) return;
    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    if (handle && nodeEl) {
      event.preventDefault();
      drag = { kind: "connect", source: nodeEl.dataset.key, sourceHandle: handle.dataset.handle };
      return;
    }
    if (event.target.closest(".fb-node-tools")) return;
    if (nodeEl) {
      const key = nodeEl.dataset.key;
      if (additive) {
        const next = new Set(state.selection);
        if (next.has(key)) next.delete(key); else next.add(key);
        setSelection(next);
        return;
      }
      if (!state.selection.has(key)) setSelection([key]);
      if (event.target.closest(".fb-node-head, .fb-node-body")) {
        const point = toGraphPoint(event.clientX, event.clientY);
        const offsets = [...state.selection].map((selectedKey) => {
          const node = nodeByKey(selectedKey);
          return { key: selectedKey, dx: point.x - node.x, dy: point.y - node.y };
        });
        drag = { kind: "nodes", offsets, before: JSON.stringify(state.graph), moved: false };
      }
      return;
    }
    if (edgeEl) {
      state.selectedEdge = edgeEl.dataset.edge;
      state.selection = new Set();
      renderEdges();
      renderNodes();
      renderPanel();
      return;
    }
    state.selectedEdge = null;
    if (additive) {
      // Shift + arrastar no vazio = seleção por área.
      const start = toGraphPoint(event.clientX, event.clientY);
      drag = { kind: "box", start, base: new Set(state.selection) };
      canvas.insertAdjacentHTML("beforeend", '<div id="fb-box" class="fb-box"></div>');
      return;
    }
    if (state.selection.size) setSelection([]);
    renderEdges();
    drag = { kind: "pan", startX: event.clientX, startY: event.clientY, originX: state.graph.viewport.x, originY: state.graph.viewport.y };
    canvas.classList.add("panning");
  });

  function boxRect(from, to) {
    return { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), w: Math.abs(to.x - from.x), h: Math.abs(to.y - from.y) };
  }

  window.addEventListener("mousemove", (event) => {
    if (!drag) return;
    if (drag.kind === "pan") {
      state.graph.viewport.x = drag.originX + event.clientX - drag.startX;
      state.graph.viewport.y = drag.originY + event.clientY - drag.startY;
      applyViewport();
    } else if (drag.kind === "nodes") {
      const point = toGraphPoint(event.clientX, event.clientY);
      for (const offset of drag.offsets) {
        const node = nodeByKey(offset.key);
        node.x = Math.round(point.x - offset.dx);
        node.y = Math.round(point.y - offset.dy);
        const element = nodesEl.querySelector(`.fb-node[data-key="${CSS.escape(offset.key)}"]`);
        element.style.left = `${node.x}px`;
        element.style.top = `${node.y}px`;
      }
      drag.moved = true;
      renderEdges();
    } else if (drag.kind === "connect") {
      const from = handlePoint(drag.source, drag.sourceHandle);
      const to = toGraphPoint(event.clientX, event.clientY);
      renderEdges();
      edgesEl.insertAdjacentHTML("beforeend", `<path class="fb-edge temp" d="${curve(from, to)}"></path>`);
      nodesEl.querySelectorAll(".drop-target").forEach((element) => element.classList.remove("drop-target"));
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(".fb-node");
      if (target && target.dataset.key !== drag.source && !target.classList.contains("start")) target.classList.add("drop-target");
    } else if (drag.kind === "box") {
      const rect = boxRect(drag.start, toGraphPoint(event.clientX, event.clientY));
      const { x, y, zoom } = state.graph.viewport;
      Object.assign($("#fb-box").style, { left: `${rect.x * zoom + x}px`, top: `${rect.y * zoom + y}px`, width: `${rect.w * zoom}px`, height: `${rect.h * zoom}px` });
    }
  });

  window.addEventListener("mouseup", (event) => {
    if (!drag) return;
    const current = drag;
    drag = null;
    canvas.classList.remove("panning");
    if (current.kind === "nodes" && current.moved) {
      state.undo.push(current.before);
      state.redo = [];
      markDirty();
      updateHistoryButtons();
      renderMinimap();
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
    } else if (current.kind === "box") {
      $("#fb-box")?.remove();
      const rect = boxRect(current.start, toGraphPoint(event.clientX, event.clientY));
      const inside = state.graph.nodes.filter((node) => {
        const size = nodeSize(node);
        return node.x < rect.x + rect.w && node.x + size.width > rect.x && node.y < rect.y + rect.h && node.y + size.height > rect.y;
      }).map((node) => node.key);
      setSelection([...current.base, ...inside]);
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
    const minX = Math.min(...state.graph.nodes.map((node) => node.x));
    const minY = Math.min(...state.graph.nodes.map((node) => node.y));
    const maxX = Math.max(...state.graph.nodes.map((node) => node.x + nodeSize(node).width));
    const maxY = Math.max(...state.graph.nodes.map((node) => node.y + nodeSize(node).height));
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
    if (button.dataset.action === "delete") deleteNodes([key]);
    if (button.dataset.action === "duplicate") duplicateNodes([key]);
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
    if (type === "start" && state.graph.nodes.some((node) => node.type === "start")) { toast("O fluxo já tem um nó Início."); return; }
    pushHistory();
    const node = { key: uid("n"), type, name: meta.label, x: Math.round(point.x), y: Math.round(point.y), config: defaultConfig(type) };
    state.graph.nodes.push(node);
    state.selection = new Set([node.key]);
    render();
    showPanel("props");
    renderPanel();
  }

  function defaultConfig(type) {
    switch (type) {
      case "message": return { source: "TEXT", text: "", responseKey: "" };
      case "question": return { text: "", variable: "flow.lastAnswer", answerType: "TEXT", invalidMessage: "", maxAttempts: 3 };
      case "menu": return { text: "Como podemos ajudar?", options: [{ id: uid("o"), label: "Opção 1", keywords: [] }, { id: uid("o"), label: "Opção 2", keywords: [] }], variable: "flow.selectedOption", invalidMessage: "", maxAttempts: 3, display: "TEXT", buttonLabel: "Ver opções" };
      case "media": return { kind: "IMAGE", storageKey: "", mimeType: "", fileName: "", caption: "" };
      case "condition": return { match: "ALL", rules: [{ left: "flow.selectedOption", operator: "==", right: "" }] };
      case "delay": return { amount: 5, unit: "SECONDS" };
      case "variable": return { assignments: [{ key: "vars.nome", value: "" }] };
      case "transfer_category": return { categoryId: "", message: "", reason: "" };
      case "transfer_user": return { userId: "", categoryId: "", message: "", reason: "" };
      case "human_handoff": return { reason: "", categoryId: "", message: "" };
      case "end": return { message: "", finalizeConversation: true };
      case "goto_flow": return { flowId: "" };
      case "webhook": return { endpointKey: "", fields: [], resultVariable: "vars.webhook" };
      case "start": return { initialMessage: "", channels: [], categoryId: null, trigger: "NEW_CONVERSATION" };
      default: return {};
    }
  }

  function deleteNodes(keys) {
    const starts = state.graph.nodes.filter((node) => node.type === "start");
    const removable = keys.filter((key) => {
      const node = nodeByKey(key);
      return node && !(node.type === "start" && starts.length <= 1);
    });
    if (!removable.length) { toast("O nó Início não pode ser apagado — todo fluxo precisa de exatamente um.", true); return; }
    pushHistory();
    const removed = new Set(removable);
    state.graph.nodes = state.graph.nodes.filter((item) => !removed.has(item.key));
    state.graph.edges = state.graph.edges.filter((edge) => !removed.has(edge.source) && !removed.has(edge.target));
    for (const key of removed) state.selection.delete(key);
    render();
    renderPanel();
  }

  // Copia nós + conexões internas com chaves novas (menu ganha ids de opção
  // novos e as conexões das opções são remapeadas).
  function cloneNodes(nodes, edges, offset) {
    const keyMap = new Map();
    const optionMap = new Map();
    const copies = nodes.filter((node) => node.type !== "start").map((node) => {
      const copy = { ...clone(node), key: uid("n"), x: node.x + offset.x, y: node.y + offset.y };
      keyMap.set(node.key, copy.key);
      if (copy.type === "menu") {
        copy.config.options = copy.config.options.map((option) => {
          const id = uid("o");
          optionMap.set(`${node.key}::opt:${option.id}`, `opt:${id}`);
          return { ...option, id };
        });
      }
      return copy;
    });
    const copiedEdges = edges.filter((edge) => keyMap.has(edge.source) && keyMap.has(edge.target)).map((edge) => {
      const sourceHandle = optionMap.get(`${edge.source}::${edge.sourceHandle}`) || edge.sourceHandle;
      const source = keyMap.get(edge.source);
      const target = keyMap.get(edge.target);
      return { id: `${source}:${sourceHandle}->${target}`, source, sourceHandle, target };
    });
    return { nodes: copies, edges: copiedEdges };
  }

  function duplicateNodes(keys) {
    const nodes = keys.map(nodeByKey).filter(Boolean);
    if (!nodes.some((node) => node.type !== "start")) { toast("O nó Início não pode ser duplicado."); return; }
    pushHistory();
    const copied = cloneNodes(nodes, state.graph.edges, { x: 40, y: 40 });
    if (copied.nodes.length === 1) copied.nodes[0].name = `${copied.nodes[0].name} (cópia)`;
    state.graph.nodes.push(...copied.nodes);
    state.graph.edges.push(...copied.edges);
    state.selection = new Set(copied.nodes.map((node) => node.key));
    render();
    renderPanel();
  }

  function copySelection() {
    const nodes = [...state.selection].map(nodeByKey).filter((node) => node && node.type !== "start");
    if (!nodes.length) { toast("Selecione nós para copiar (o Início não é copiado)."); return; }
    const keys = new Set(nodes.map((node) => node.key));
    state.clipboard = { nodes: clone(nodes), edges: clone(state.graph.edges.filter((edge) => keys.has(edge.source) && keys.has(edge.target))) };
    try { localStorage.setItem(CLIPBOARD_KEY, JSON.stringify(state.clipboard)); } catch { /* só em memória */ }
    toast(`${nodes.length} nó(s) copiado(s).`);
  }

  function pasteClipboard() {
    let clipboard = state.clipboard;
    try { clipboard = JSON.parse(localStorage.getItem(CLIPBOARD_KEY) || "null") || clipboard; } catch { /* usa o da memória */ }
    if (!clipboard?.nodes?.length) { toast("Nada para colar."); return; }
    const center = toGraphPoint(canvas.getBoundingClientRect().left + canvas.clientWidth / 2, canvas.getBoundingClientRect().top + canvas.clientHeight / 2);
    const minX = Math.min(...clipboard.nodes.map((node) => node.x));
    const minY = Math.min(...clipboard.nodes.map((node) => node.y));
    pushHistory();
    const copied = cloneNodes(clipboard.nodes, clipboard.edges, { x: Math.round(center.x - minX - NODE_WIDTH / 2), y: Math.round(center.y - minY - 60) });
    state.graph.nodes.push(...copied.nodes);
    state.graph.edges.push(...copied.edges);
    state.selection = new Set(copied.nodes.map((node) => node.key));
    render();
    renderPanel();
    toast(`${copied.nodes.length} nó(s) colado(s).`);
  }

  function alignSelection(axis) {
    const nodes = [...state.selection].map(nodeByKey).filter(Boolean);
    if (nodes.length < 2) return;
    pushHistory();
    const value = Math.min(...nodes.map((node) => node[axis]));
    for (const node of nodes) node[axis] = value;
    render();
  }

  function distributeSelection() {
    const nodes = [...state.selection].map(nodeByKey).filter(Boolean).sort((a, b) => a.y - b.y);
    if (nodes.length < 3) return;
    pushHistory();
    const first = nodes[0].y;
    const last = nodes.at(-1).y;
    const step = (last - first) / (nodes.length - 1);
    nodes.forEach((node, index) => { node.y = Math.round(first + step * index); });
    render();
  }

  // Auto organizar: camadas pela distância (BFS) a partir do Início, na
  // ordem das saídas de cada nó; nós soltos vão para uma coluna à direita.
  function autoLayout() {
    const start = state.graph.nodes.find((node) => node.type === "start");
    if (!start) return;
    pushHistory();
    const depth = new Map([[start.key, 0]]);
    const queue = [start.key];
    const order = [];
    while (queue.length) {
      const key = queue.shift();
      order.push(key);
      const node = nodeByKey(key);
      const handles = outputsFor(node).map((output) => output.handle);
      const outgoing = state.graph.edges.filter((edge) => edge.source === key)
        .sort((a, b) => handles.indexOf(a.sourceHandle) - handles.indexOf(b.sourceHandle));
      for (const edge of outgoing) {
        if (!depth.has(edge.target)) { depth.set(edge.target, depth.get(key) + 1); queue.push(edge.target); }
      }
    }
    const maxDepth = Math.max(0, ...depth.values());
    for (const node of state.graph.nodes) if (!depth.has(node.key)) { depth.set(node.key, maxDepth + 1); order.push(node.key); }
    const rows = new Map();
    for (const key of order) {
      const column = depth.get(key);
      const row = rows.get(column) || 0;
      rows.set(column, row + 1);
      const node = nodeByKey(key);
      node.x = 80 + column * 300;
      node.y = 80 + row * 200;
    }
    render();
    requestAnimationFrame(fitView);
  }

  $("#fb-copy").addEventListener("click", copySelection);
  $("#fb-paste").addEventListener("click", pasteClipboard);
  $("#fb-align-left").addEventListener("click", () => alignSelection("x"));
  $("#fb-align-top").addEventListener("click", () => alignSelection("y"));
  $("#fb-distribute").addEventListener("click", distributeSelection);
  $("#fb-auto-layout").addEventListener("click", () => {
    if (window.confirm("Reorganizar automaticamente todos os nós a partir do Início? (Dá para desfazer com Ctrl+Z.)")) autoLayout();
  });

  function deleteEdge(id) {
    pushHistory();
    state.graph.edges = state.graph.edges.filter((edge) => edge.id !== id);
    state.selectedEdge = null;
    render();
    renderPanel();
  }

  function selectNode(key) {
    setSelection([key]);
  }

  document.addEventListener("keydown", (event) => {
    const typing = event.target.closest("input, textarea, select");
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (mod && key === "s") { event.preventDefault(); saveDraft(); return; }
    if (typing) return;
    if (mod && key === "z" && !event.shiftKey) { event.preventDefault(); restoreFrom(state.undo, state.redo); }
    else if (mod && (key === "y" || (key === "z" && event.shiftKey))) { event.preventDefault(); restoreFrom(state.redo, state.undo); }
    else if (mod && key === "d" && state.selection.size) { event.preventDefault(); duplicateNodes([...state.selection]); }
    else if (mod && key === "c" && state.selection.size) { event.preventDefault(); copySelection(); }
    else if (mod && key === "v") { event.preventDefault(); pasteClipboard(); }
    else if (mod && key === "a") { event.preventDefault(); setSelection(state.graph.nodes.map((node) => node.key)); }
    else if (event.key === "Escape") setSelection([]);
    else if (event.key === "Delete" || event.key === "Backspace") {
      if (state.selectedEdge) deleteEdge(state.selectedEdge);
      else if (state.selection.size) deleteNodes([...state.selection]);
    }
  });
  $("#fb-undo").addEventListener("click", () => restoreFrom(state.undo, state.redo));
  $("#fb-redo").addEventListener("click", () => restoreFrom(state.redo, state.undo));

  // ---------- biblioteca de blocos ---------------------------------------------------
  function renderLibrary() {
    const term = $("#fb-library-search").value.trim().toLowerCase();
    const groups = new Map(GROUP_ORDER.map((group) => [group, []]));
    for (const item of state.options.nodeTypes) {
      if (item.type === "start") continue;
      if (term && !item.label.toLowerCase().includes(term)) continue;
      if (!groups.has(item.group)) groups.set(item.group, []);
      groups.get(item.group).push(item);
    }
    $("#fb-library-list").innerHTML = [...groups].filter(([, items]) => items.length).map(([group, items]) => `
      <div class="fb-lib-group"><h4>${escapeHtml(group)}</h4>
        ${items.map((item) => `<div class="fb-lib-item" draggable="true" data-type="${item.type}" role="button" tabindex="0"><i>${item.icon}</i>${escapeHtml(item.label)}</div>`).join("")}
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
    const center = toGraphPoint(canvas.getBoundingClientRect().left + canvas.clientWidth / 2 - NODE_WIDTH / 2, canvas.getBoundingClientRect().top + canvas.clientHeight / 2 - 50);
    addNode(item.dataset.type, center);
  });
  canvas.addEventListener("dragover", (event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; });
  canvas.addEventListener("drop", (event) => {
    event.preventDefault();
    const type = event.dataTransfer.getData("text/fb-node-type");
    if (!type) return;
    const point = toGraphPoint(event.clientX, event.clientY);
    addNode(type, { x: point.x - NODE_WIDTH / 2, y: point.y - 20 });
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

  const categoryOptions = (selected, emptyLabel = "— nenhum —") => `<option value="">${emptyLabel}</option>${
    state.options.categories.map((category) => {
      const parent = state.options.categories.find((item) => item.id === category.parentId);
      return `<option value="${category.id}" ${category.id === selected ? "selected" : ""}>${escapeHtml(parent ? `${parent.name}: ${category.name}` : category.name)}</option>`;
    }).join("")}`;
  const select = (field, options, value) => `<select data-field="${field}">${Object.entries(options).map(([key, label]) => `<option value="${key}" ${key === value ? "selected" : ""}>${escapeHtml(label)}</option>`).join("")}</select>`;
  const variableChips = () => `<div class="fb-chips">${state.options.variables.filter((variable) => !variable.startsWith("custom.")).slice(0, 14).map((variable) => `<button type="button" data-insert="{{${variable}}}">${variable}</button>`).join("")}</div>`;
  const variablesDatalist = () => `<datalist id="fb-vars">${state.options.variables.map((variable) => `<option value="${variable}"></option>`).join("")}</datalist>`;
  const kvRows = (list, prefix, placeholders) => (list || []).map((item, index) => `
    <div class="fb-rule" data-index="${index}" style="grid-template-columns:1fr 1fr 24px">
      <input data-${prefix}-field="key" ${prefix === "assign" ? 'list="fb-vars"' : ""} value="${escapeHtml(item.key)}" placeholder="${placeholders[0]}">
      <input data-${prefix}-field="value" value="${escapeHtml(item.value)}" placeholder="${placeholders[1]}">
      <button type="button" class="fb-mini danger" data-${prefix}-remove>✕</button>
    </div>`).join("");

  function responseSelect(selected) {
    const groups = new Map();
    for (const item of state.options.responses) { if (!groups.has(item.category)) groups.set(item.category, []); groups.get(item.category).push(item); }
    return `<select data-field="responseKey"><option value="">Selecione a resposta</option>${[...groups].map(([group, items]) => `<optgroup label="${escapeHtml(group)}">${items.map((item) => `<option value="${escapeHtml(item.key)}" ${item.key === selected ? "selected" : ""}>${escapeHtml(item.key)} — ${escapeHtml(item.title)}</option>`).join("")}</optgroup>`).join("")}</select>`;
  }

  function mediaPreview(c) {
    if (!c.storageKey) return '<p class="fb-note">Nenhum arquivo enviado.</p>';
    const url = botUrl(`/flow-media/${encodeURIComponent(c.storageKey)}`);
    if (c.kind === "IMAGE") return `<img class="fb-media-preview" src="${url}" alt="${escapeHtml(c.fileName)}">`;
    if (c.kind === "AUDIO") return `<audio class="fb-media-preview" controls src="${url}"></audio>`;
    if (c.kind === "VIDEO") return `<video class="fb-media-preview" controls src="${url}"></video>`;
    return `<a class="fb-ghost" href="${url}" target="_blank" rel="noopener">📄 ${escapeHtml(c.fileName || "documento")}</a>`;
  }

  function nodeForm(node) {
    const c = node.config;
    switch (node.type) {
      case "start": return `
        <label>Quando iniciar ${select("trigger", { NEW_CONVERSATION: "Nova conversa (uma vez por sessão)", ANY_MESSAGE: "Nova conversa (sempre que voltar à fila sem setor)", AFTER_TRIAGE: "Após a Triagem encaminhar ao setor" }, c.trigger)}</label>
        <label>Mensagem inicial (opcional)<textarea data-field="initialMessage" placeholder="{{contact.greeting}}! Bem-vindo(a)!">${escapeHtml(c.initialMessage)}</textarea></label>
        ${variableChips()}
        <label>Setor inicial (usado como setor padrão de handoff)<select data-field="categoryId">${categoryOptions(c.categoryId)}</select></label>
        <div><label>Canais (vazio = todos os canais do Bot)</label><div class="fb-list">${Object.entries(START_CHANNELS).map(([key, label]) => `<label class="fb-check"><input type="checkbox" data-channel="${key}" ${(c.channels || []).includes(key) ? "checked" : ""}> ${label}</label>`).join("")}</div></div>`;
      case "message": return `
        <label>Conteúdo ${select("source", { TEXT: "Texto manual", LIBRARY: "Resposta da biblioteca" }, c.source)}</label>
        ${c.source === "LIBRARY" ? `
          <label>Resposta do Bot${responseSelect(c.responseKey)}</label>
          <p class="fb-note">Editar a resposta em <a href="/bots" target="_blank">Bots → Respostas do Bot</a> atualiza todos os fluxos que a usam.</p>
          <div><span class="fb-kicker">PRÉ-VISUALIZAÇÃO</span><div class="fb-preview" id="fb-preview">${escapeHtml(renderTemplate(libraryText(c.responseKey) || "…"))}</div></div>`
    : `
          <label>Texto<textarea data-field="text" placeholder="Olá {{contact.firstName}}, como podemos ajudar? 😊">${escapeHtml(c.text)}</textarea></label>
          ${variableChips()}
          <div><span class="fb-kicker">PRÉ-VISUALIZAÇÃO</span><div class="fb-preview" id="fb-preview">${escapeHtml(renderTemplate(c.text) || "…")}</div></div>`}`;
      case "media": return `
        <label>Tipo ${select("kind", MEDIA_KINDS, c.kind)}</label>
        <label class="fb-upload">Arquivo<input type="file" id="fb-media-file" accept="${MEDIA_ACCEPT[c.kind] || ""}"></label>
        <div id="fb-media-preview">${mediaPreview(c)}</div>
        <label>Legenda (opcional)<textarea data-field="caption">${escapeHtml(c.caption)}</textarea></label>
        <p class="fb-note">Imagem JPG/PNG até 5 MB; áudio/vídeo até 16 MB; documentos até 100 MB.</p>`;
      case "question": return `
        <label>Pergunta<textarea data-field="text" placeholder="Qual o número do seu pedido?">${escapeHtml(c.text)}</textarea></label>
        ${variableChips()}
        <div class="fb-row">
          <label>Salvar em<input data-field="variable" list="fb-vars" value="${escapeHtml(c.variable)}" placeholder="customer.orderNumber"></label>
          <label>Tipo de resposta ${select("answerType", ANSWER_TYPES, c.answerType)}</label>
        </div>
        <div class="fb-row"><label>Tentativas<input data-field="maxAttempts" type="number" min="1" max="10" value="${c.maxAttempts}"></label></div>
        <label>Mensagem quando a resposta for inválida<input data-field="invalidMessage" value="${escapeHtml(c.invalidMessage)}" placeholder="Não consegui entender sua resposta..."></label>
        <p class="fb-note">${c.answerType === "YES_NO" ? "Sim/Não salva <code>true</code>/<code>false</code> — use uma Condição (ex.: <code>flow.lastAnswer == true</code>). " : ""}Sem a saída "Resposta inválida" conectada, após as tentativas a conversa vai para atendimento humano.</p>`;
      case "menu": return `
        <label>Texto do menu<textarea data-field="text">${escapeHtml(c.text)}</textarea></label>
        <div class="fb-row"><label>Exibir como ${select("display", { TEXT: "Texto numerado", LIST: "Lista do WhatsApp (até 10)" }, c.display)}</label>
          ${c.display === "LIST" ? `<label>Botão da lista<input data-field="buttonLabel" maxlength="20" value="${escapeHtml(c.buttonLabel)}"></label>` : ""}</div>
        <div><span class="fb-kicker">OPÇÕES (${(c.options || []).length})</span><div class="fb-list" id="fb-menu-options">${(c.options || []).map((option, index) => `
          <div class="fb-list-item" data-index="${index}">
            <div class="fb-list-top"><b>${index + 1}</b><input data-option-field="label" value="${escapeHtml(option.label)}" placeholder="Nome da opção">
              <button type="button" class="fb-mini" data-option-move="-1" title="Subir">↑</button><button type="button" class="fb-mini" data-option-move="1" title="Descer">↓</button><button type="button" class="fb-mini danger" data-option-remove title="Remover">✕</button></div>
            <input data-option-field="keywords" value="${escapeHtml((option.keywords || []).join(", "))}" placeholder="Sinônimos: problema, ajuda, defeito, não funciona">
          </div>`).join("")}</div>
          <button type="button" class="fb-add" data-option-add>+ opção</button></div>
        <p class="fb-note">O cliente pode responder com o número, o nome, uma frase com ele ("quero suporte") ou um sinônimo cadastrado. Só escolhe quando exatamente uma opção bate — sem IA, sem chute. Cada opção tem sua própria saída.${c.display === "LIST" && (c.options || []).length > 10 ? " <b>Mais de 10 opções: o WhatsApp recebe o texto numerado.</b>" : ""}</p>
        <div class="fb-row"><label>Salvar escolha em<input data-field="variable" list="fb-vars" value="${escapeHtml(c.variable)}"></label>
          <label>Tentativas<input data-field="maxAttempts" type="number" min="1" max="10" value="${c.maxAttempts}"></label></div>
        <label>Mensagem para opção não reconhecida<input data-field="invalidMessage" value="${escapeHtml(c.invalidMessage)}"></label>`;
      case "condition": return `
        <label>Combinar regras ${select("match", { ALL: "Todas verdadeiras (E)", ANY: "Qualquer uma (OU)" }, c.match)}</label>
        <div class="fb-list" id="fb-rules">${(c.rules || []).map((rule, index) => `
          <div class="fb-rule" data-index="${index}">
            <input data-rule-field="left" list="fb-vars" value="${escapeHtml(rule.left)}" placeholder="flow.selectedOption">
            <select data-rule-field="operator">${OPERATORS.map((op) => `<option ${op === rule.operator ? "selected" : ""}>${op}</option>`).join("")}</select>
            <input data-rule-field="right" value="${escapeHtml(rule.right)}" placeholder="valor" ${["exists", "not_exists"].includes(rule.operator) ? "disabled" : ""}>
            <button type="button" class="fb-mini danger" data-rule-remove>✕</button>
          </div>`).join("")}</div>
        <button type="button" class="fb-add" data-rule-add>+ regra</button>
        <p class="fb-note">Exemplos: <code>customer.hasOrder == true</code>, <code>bot.withinBusinessHours == true</code>, <code>flow.selectedOption == Suporte</code>, <code>customer.cnpj exists</code>. Saídas: Verdadeiro e Falso.</p>`;
      case "delay": return `
        <div class="fb-row"><label>Quanto<input data-field="amount" type="number" min="1" value="${c.amount}"></label>
          <label>Unidade ${select("unit", { SECONDS: "segundos", MINUTES: "minutos", HOURS: "horas" }, c.unit)}</label></div>
        <p class="fb-note">O servidor não fica esperando: a execução é agendada e retomada automaticamente. Máximo de 24 horas.</p>`;
      case "variable": return `
        <div class="fb-list" id="fb-assignments">${kvRows(c.assignments, "assign", ["custom.origem", "valor ou {{variavel}}"])}</div>
        <button type="button" class="fb-add" data-assign-add>+ variável</button>
        <p class="fb-note">Só é possível escrever em <code>customer.*</code>, <code>flow.*</code>, <code>vars.*</code> e <code>custom.*</code>.</p>`;
      case "transfer_category": return `
        <label>Setor de destino<select data-field="categoryId">${categoryOptions(c.categoryId, "Selecione o setor")}</select></label>
        <label>Mensagem ao cliente (opcional)<textarea data-field="message">${escapeHtml(c.message)}</textarea></label>
        <label>Motivo (histórico/auditoria)<input data-field="reason" value="${escapeHtml(c.reason)}"></label>
        <p class="fb-note">A conversa sai do Bot, entra na fila do setor sem responsável e a transferência fica no histórico — mesmo sistema de categorias/visibilidade da Central.</p>`;
      case "transfer_user": return `
        <label>Atendente<select data-field="userId"><option value="">Selecione o atendente</option>${state.options.users.map((user) => `<option value="${user.id}" ${user.id === c.userId ? "selected" : ""}>${escapeHtml(user.name)} (${escapeHtml(user.role)})</option>`).join("")}</select></label>
        <label>Setor (opcional — padrão: setor atual/inicial)<select data-field="categoryId">${categoryOptions(c.categoryId)}</select></label>
        <label>Mensagem ao cliente (opcional)<textarea data-field="message">${escapeHtml(c.message)}</textarea></label>
        <label>Motivo (histórico/auditoria)<input data-field="reason" value="${escapeHtml(c.reason)}"></label>
        <p class="fb-note">O atendente precisa ter acesso ao setor. A conversa fica com ele em "Em atendimento".</p>`;
      case "human_handoff": return `
        <label>Motivo<input data-field="reason" value="${escapeHtml(c.reason)}" placeholder="Cliente pediu atendente"></label>
        <label>Setor (opcional)<select data-field="categoryId">${categoryOptions(c.categoryId)}</select></label>
        <label>Mensagem ao cliente (opcional)<textarea data-field="message">${escapeHtml(c.message)}</textarea></label>`;
      case "end": return `
        <label>Mensagem final (opcional)<textarea data-field="message">${escapeHtml(c.message)}</textarea></label>
        <label class="fb-check"><input type="checkbox" data-field="finalizeConversation" ${c.finalizeConversation !== false ? "checked" : ""}> Finalizar a conversa</label>
        <p class="fb-note">Desmarcado: o Bot encerra e a conversa fica visível para a equipe.</p>`;
      case "goto_flow": return `
        <label>Fluxo de destino<select data-field="flowId"><option value="">Selecione o fluxo</option>${state.options.flows.filter((flow) => flow.id !== state.flow?.id).map((flow) => `<option value="${flow.id}" ${flow.id === c.flowId ? "selected" : ""}>${escapeHtml(flow.name)}${flow.published ? "" : " (nunca publicado)"}</option>`).join("")}</select></label>
        <p class="fb-note">Continua no Início do outro fluxo (Triagem → Suporte, Comercial...), com as mesmas variáveis. Em produção o fluxo de destino precisa estar <b>publicado e ativo</b>.</p>`;
      case "webhook": return `
        <label>Endpoint${state.options.webhooks.length ? `<select data-field="endpointKey"><option value="">Selecione</option>${state.options.webhooks.map((item) => `<option value="${escapeHtml(item.key)}" ${item.key === c.endpointKey ? "selected" : ""}>${escapeHtml(item.key)} — ${escapeHtml(item.name)} (${item.method})</option>`).join("")}</select>` : '<p class="fb-note warn">Nenhum endpoint cadastrado. Cadastre em <a href="/bots" target="_blank">Bots → Webhooks/API</a>.</p>'}</label>
        <div><span class="fb-kicker">CAMPOS ENVIADOS</span><div class="fb-list" id="fb-fields">${kvRows(c.fields, "field", ["pedido", "{{customer.orderNumber}}"])}</div>
          <button type="button" class="fb-add" data-field-add>+ campo</button></div>
        <label>Salvar resposta em<input data-field="resultVariable" list="fb-vars" value="${escapeHtml(c.resultVariable)}"></label>
        <p class="fb-note">Resultado: <code>${escapeHtml(c.resultVariable)}.ok</code>, <code>.status</code> e <code>.data</code> (ex.: <code>${escapeHtml(c.resultVariable)}.data.status</code> numa Condição). Falha sem saída "Erro" conectada vai para atendimento humano.</p>`;
      case "removed": return `<p class="fb-note warn">Este nó (${escapeHtml(c.originalType || "antigo")}) usava IA/conhecimento e não existe mais. O Bot agora é 100% determinístico: exclua o nó e use Mensagem, Menu, Condição ou Respostas do Bot.</p>`;
      default: return "";
    }
  }

  function renderPanel() {
    const panel = $("#fb-panel-props");
    if (state.selectedEdge) {
      panel.innerHTML = `<span class="fb-kicker">CONEXÃO</span><h3>Conexão selecionada</h3><div class="fb-panel-actions"><button type="button" class="fb-ghost" id="fb-delete-edge">Excluir conexão</button></div>`;
      $("#fb-delete-edge").addEventListener("click", () => deleteEdge(state.selectedEdge));
      return;
    }
    if (state.selection.size > 1) {
      panel.innerHTML = `<span class="fb-kicker">SELEÇÃO</span><h3>${state.selection.size} nós selecionados</h3>
        <p class="fb-note">Arraste qualquer um para mover todos. Use a barra do canvas para alinhar/distribuir.</p>
        <div class="fb-panel-actions"><button type="button" class="fb-ghost" data-panel-action="copy">Copiar</button><button type="button" class="fb-ghost" data-panel-action="duplicate">Duplicar</button><button type="button" class="fb-ghost" data-panel-action="delete">Excluir</button></div>`;
      return;
    }
    const node = nodeByKey(primaryKey());
    if (!node) {
      panel.innerHTML = `<div class="fb-empty">Selecione um nó para configurar.<br><br>Arraste da biblioteca para o canvas, conecte a saída (○) de um nó na entrada de outro e clique em uma conexão para excluí-la.<br><br><b>Atalhos:</b> Ctrl+S salvar • Ctrl+Z/Y desfazer/refazer • Ctrl+C/V copiar/colar • Ctrl+D duplicar • Ctrl+A selecionar tudo • Shift+clique ou Shift+arrastar multi-seleção • Delete excluir</div>`;
      return;
    }
    const meta = typeMeta(node.type);
    const errors = state.errors.filter((error) => error.nodeKey === node.key);
    const warnings = state.warnings.filter((warning) => warning.nodeKey === node.key);
    panel.innerHTML = `
      <span class="fb-kicker">${escapeHtml(meta.label.toUpperCase())}</span><h3>${escapeHtml(node.name)}</h3>
      ${errors.length ? `<div class="fb-node-errors"><b>Corrija antes de publicar:</b><ul>${errors.map((error) => `<li>${escapeHtml(error.message)}</li>`).join("")}</ul></div>` : ""}
      ${warnings.length ? `<div class="fb-node-errors warn"><b>Atenção:</b><ul>${warnings.map((warning) => `<li>${escapeHtml(warning.message)}</li>`).join("")}</ul></div>` : ""}
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

  // Campos que mudam o próprio formulário (mostram/escondem outros campos).
  const RERENDER_FIELDS = new Set(["source", "display", "kind", "answerType", "responseKey"]);

  panelProps.addEventListener("input", (event) => {
    const node = nodeByKey(primaryKey());
    if (!node) return;
    const target = event.target;
    const c = node.config;
    if (target.type === "file") return;
    if (target.matches("[data-name]")) { beginEdit(); node.name = target.value; refreshNodeCard(); return; }
    if (target.matches("[data-field]")) {
      beginEdit();
      const field = target.dataset.field;
      if (target.type === "checkbox") c[field] = target.checked;
      else if (target.type === "number") c[field] = Number(target.value);
      else if (field === "categoryId") c[field] = target.value || (node.type === "start" ? null : "");
      else c[field] = target.value;
      if (field === "text" && $("#fb-preview")) $("#fb-preview").textContent = renderTemplate(c.text) || "…";
      if (field === "kind") Object.assign(c, { storageKey: "", mimeType: "", fileName: "" });
      refreshNodeCard();
      if (RERENDER_FIELDS.has(field)) { state.editSnapshotTaken = false; renderPanel(); }
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
      return;
    }
    const fieldRow = target.closest("#fb-fields .fb-rule");
    if (fieldRow && target.dataset.fieldField) {
      beginEdit();
      c.fields[Number(fieldRow.dataset.index)][target.dataset.fieldField] = target.value;
      refreshNodeCard();
    }
  });
  panelProps.addEventListener("change", async (event) => {
    if (event.target.matches("select[data-field], select[data-rule-field]")) state.editSnapshotTaken = false;
    if (event.target.id !== "fb-media-file") return;
    const node = nodeByKey(primaryKey());
    const file = event.target.files?.[0];
    if (!node || !file) return;
    const form = new FormData();
    form.append("kind", node.config.kind);
    form.append("file", file);
    try {
      $("#fb-media-preview").innerHTML = '<p class="fb-note">Enviando...</p>';
      const uploaded = await api(botUrl("/flow-media"), { method: "POST", body: form });
      pushHistory();
      Object.assign(node.config, { storageKey: uploaded.storageKey, mimeType: uploaded.mimeType, fileName: uploaded.fileName });
      refreshNodeCard();
      renderPanel();
      toast("Arquivo enviado. Salve o rascunho para manter.");
    } catch (error) {
      $("#fb-media-preview").innerHTML = mediaPreview(node.config);
      toast(error.message, true);
    }
  });

  panelProps.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.dataset.panelAction === "copy") return copySelection();
    if (button.dataset.panelAction === "delete") return deleteNodes([...state.selection]);
    if (button.dataset.panelAction === "duplicate") return duplicateNodes([...state.selection]);
    const node = nodeByKey(primaryKey());
    if (!node) return;
    const c = node.config;
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
    if (button.hasAttribute("data-field-add")) return structural(() => { c.fields ||= []; c.fields.push({ key: "", value: "" }); });
    if (button.hasAttribute("data-field-remove")) return structural(() => c.fields.splice(Number(button.closest(".fb-rule").dataset.index), 1));
  });

  // ---------- salvar / validar / publicar --------------------------------------
  function renderHeader() {
    const flow = state.flow;
    $("#fb-bot-name").textContent = state.bot ? `Bot • ${state.bot.name}` : "";
    // Empresa do Bot sempre clara no editor (só setores/respostas dela são válidos).
    const company = state.options?.bot?.company;
    if (company && state.bot) {
      const badge = document.createElement("span");
      badge.className = "company-badge fb-company-badge";
      badge.textContent = company.displayName;
      badge.title = `Bot da empresa ${company.name} — só roda em conversas dela`;
      if (/^#[0-9a-f]{6}$/i.test(company.primaryColor || "")) badge.style.setProperty("--company-color", company.primaryColor);
      $("#fb-bot-name").append(" ", badge);
    }
    $("#back-to-bot").href = `/bots?botId=${encodeURIComponent(botId)}`;
    $("#fb-bot-settings").href = `/bots?botId=${encodeURIComponent(botId)}`;
    $("#fb-flow-select").innerHTML = state.flows.map((item) => `<option value="${item.id}" ${item.id === flow?.id ? "selected" : ""}>${escapeHtml(item.name)}${item.isDefault ? " (padrão)" : ""}</option>`).join("");
    $("#fb-flow-name").value = flow?.name || "";
    $("#fb-status").textContent = STATUS_LABELS[flow?.status] || "—";
    $("#fb-status").className = `status-badge ${flow?.status === "ACTIVE" ? "ACTIVE" : flow?.status === "INACTIVE" ? "PAUSED" : ""}`;
    $("#fb-version").textContent = flow?.activeVersion ? `versão publicada: v${flow.activeVersion}` : "sem versão publicada";
    $("#fb-toggle-status").textContent = flow?.status === "ACTIVE" ? "Desativar" : "Ativar";
    $("#fb-toggle-status").disabled = !flow?.activeVersion;
    $("#fb-dirty").hidden = !state.dirty;
    const bot = state.bot;
    const responding = bot?.status === "ACTIVE" && bot?.autoReplyEnabled;
    $("#fb-mode-text").innerHTML = [
      flow?.isDefault ? "Este é o <b>fluxo padrão</b>: começa as conversas novas." : "Fluxo auxiliar: chamado por <b>Ir para fluxo</b>.",
      responding ? "Bot respondendo clientes." : "Resposta automática <b>desligada</b> — nada é enviado a clientes.",
    ].join(" ");
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

  function showValidation(errors, warnings = [], { ok = false } = {}) {
    state.errors = errors;
    state.warnings = warnings;
    const box = $("#fb-validation");
    const item = (entry) => `<li><button type="button" data-goto="${escapeHtml(entry.nodeKey || "")}">${escapeHtml(entry.nodeKey ? `${nodeByKey(entry.nodeKey)?.name || entry.nodeKey}: ` : "")}${escapeHtml(entry.message)}</button></li>`;
    if (ok && !warnings.length) {
      box.hidden = false;
      box.className = "fb-validation ok";
      box.innerHTML = "<b>✓ Fluxo válido</b>Nenhum problema encontrado.";
      setTimeout(() => { box.hidden = true; }, 3500);
    } else if (errors.length || warnings.length) {
      box.hidden = false;
      box.className = `fb-validation${errors.length ? "" : " ok"}`;
      box.innerHTML = `${errors.length ? `<b>${errors.length} problema(s) para publicar</b><ul>${errors.map(item).join("")}</ul>` : "<b>✓ Fluxo válido</b>"}${warnings.length ? `<b class="warn">${warnings.length} aviso(s)</b><ul>${warnings.map(item).join("")}</ul>` : ""}`;
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
    state.graph.viewport.x = canvas.clientWidth / 2 - (node.x + NODE_WIDTH / 2) * state.graph.viewport.zoom;
    state.graph.viewport.y = canvas.clientHeight / 2 - (node.y + 50) * state.graph.viewport.zoom;
    applyViewport();
  });

  async function validate() {
    try {
      const result = await api(flowUrl("/validate"), { method: "POST", body: JSON.stringify({ graph: state.graph }) });
      showValidation(result.errors, result.warnings || [], { ok: result.valid });
      return result.valid;
    } catch (error) { toast(error.message, true); return false; }
  }

  async function publish() {
    if (!(await saveDraft({ quiet: true }))) return;
    try {
      const published = await api(flowUrl("/publish"), { method: "POST", body: "{}" });
      applyFlow(published, { keepView: true });
      showValidation([], [], { ok: true });
      await loadFlowList();
      toast(`Versão v${published.activeVersion} publicada. A versão anterior continua disponível para rollback.`);
    } catch (error) {
      if (error.body?.details?.errors) showValidation(error.body.details.errors, error.body.details.warnings || []);
      else if (error.body?.errors) showValidation(error.body.errors);
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

  $("#fb-save").addEventListener("click", () => saveDraft());
  $("#fb-validate").addEventListener("click", validate);
  $("#fb-publish").addEventListener("click", publish);
  $("#fb-toggle-status").addEventListener("click", toggleStatus);
  $("#fb-flow-name").addEventListener("input", markDirty);
  $("#fb-test").addEventListener("click", () => { showPanel("test"); resetTest(); $("#fb-test-input").focus(); });

  // ---------- versões -------------------------------------------------------------
  function renderVersions() {
    const panel = $("#fb-panel-versions");
    const versions = state.flow?.versions || [];
    panel.innerHTML = `<span class="fb-kicker">VERSÕES PUBLICADAS</span><h3>Histórico</h3>
      <p class="fb-note">Salvar altera só o rascunho (a versão em uso nunca muda sozinha). Publicar cria uma nova versão; as anteriores ficam guardadas para rollback. Conversas em andamento terminam na versão em que começaram.</p>
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

  function bubble(type, text, options = []) {
    const buttons = options.length ? `<div class="fb-bubble-options">${options.map((option) => `<button type="button" data-reply-id="${escapeHtml(option.replyId)}" data-reply-label="${escapeHtml(option.label)}">${escapeHtml(option.label)}</button>`).join("")}</div>` : "";
    $("#fb-test-transcript").insertAdjacentHTML("beforeend", `<div class="fb-bubble ${type}">${escapeHtml(text)}${buttons}</div>`);
    $("#fb-test-transcript").scrollTop = $("#fb-test-transcript").scrollHeight;
  }
  $("#fb-test-transcript").addEventListener("click", (event) => {
    const button = event.target.closest("[data-reply-id]");
    if (button) sendTest(button.dataset.replyLabel, button.dataset.replyId);
  });

  async function sendTest(message, replyId = null) {
    if (!state.test) resetTest();
    const finished = state.test.simState && ["HANDED_OFF", "COMPLETED", "FAILED"].includes(state.test.simState.status);
    if (finished) { toast("A simulação terminou. Clique em Reiniciar para testar de novo."); return; }
    if (!message && state.test.simState) return;
    if (message) bubble("customer", message);
    try {
      const source = $("#fb-test-source").value;
      const body = {
        message, replyId, state: state.test.simState, source, callWebhooks: $("#fb-test-webhooks").checked,
        ...(source === "DRAFT" && (!state.test.simState?.flow?.flowId || state.test.simState.flow.flowId === state.flow.id) ? { graph: state.graph } : {}),
      };
      const result = await api(flowUrl("/simulate"), { method: "POST", body: JSON.stringify(body) });
      state.test.simState = result.state;
      for (const output of result.outputs) bubble(output.type === "event" ? "event" : "bot", output.text, output.options || []);
      for (const entry of result.trace) {
        if (entry.flowId && entry.flowId !== state.flow.id) continue; // nó de outro fluxo (Ir para fluxo)
        state.test.visited.add(entry.nodeKey);
        if (entry.result === "ERROR") state.test.errored.add(entry.nodeKey);
        if (entry.branch) state.test.takenEdges.add(`${entry.nodeKey}::${entry.branch}`);
      }
      const sameFlow = !result.currentFlowId || result.currentFlowId === state.flow.id;
      state.test.current = sameFlow && ["WAITING_CUSTOMER", "WAITING_TIMER"].includes(result.status) ? result.currentNodeKey : null;
      state.test.turns.push({ message, trace: result.trace, status: result.status });
      renderTrace();
      if (!["WAITING_CUSTOMER", "WAITING_TIMER", "RUNNING"].includes(result.status)) bubble("event", `Fluxo ${EXEC_STATUS_LABELS[result.status] || result.status}`);
      render();
    } catch (error) {
      bubble("event", `Erro: ${error.message}`);
    }
  }

  $("#fb-test-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = $("#fb-test-input");
    const message = input.value.trim();
    input.value = "";
    sendTest(message);
  });

  // Rastro: mensagem do cliente -> nó executado -> resultado -> saída -> próximo nó.
  function renderTrace() {
    $("#fb-test-trace").innerHTML = state.test.turns.map((turn, index) => `
      <div class="fb-trace-turn">${index === 0 ? "INÍCIO" : `CLIENTE: "${escapeHtml(turn.message)}"`}</div>
      ${turn.trace.map((entry) => {
        const otherFlow = entry.flowId && entry.flowId !== state.flow.id;
        const node = otherFlow ? null : nodeByKey(entry.nodeKey);
        const next = entry.nextNodeKey ? (otherFlow ? entry.nextNodeKey : nodeByKey(entry.nextNodeKey)?.name || entry.nextNodeKey) : "";
        const branch = entry.branch ? (entry.branch.startsWith("opt:") && node ? outputsFor(node).find((output) => output.handle === entry.branch)?.label || entry.branch : OUTPUT_LABELS[entry.branch] || entry.branch) : "";
        return `<div class="fb-trace-item"><span class="res ${entry.result}">${RESULT_LABELS[entry.result] || entry.result}</span>
          <div><b>${escapeHtml(entry.nodeName || entry.nodeKey)}</b>${otherFlow ? ` <small>(fluxo ${escapeHtml(entry.flowName || "")})</small>` : ""}<br><small>${escapeHtml([branch && `saída: ${branch}`, next && `→ ${next}`, entry.error].filter(Boolean).join(" "))}</small></div>
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
    for (const key of [...state.selection]) if (!nodeByKey(key)) state.selection.delete(key);
    renderHeader();
    render();
    renderPanel();
  }

  async function loadFlowList() {
    state.flows = await api(botUrl("/visual-flows"));
    renderHeader();
  }

  async function openFlow(flowId) {
    if (state.dirty && !window.confirm("Existem alterações não salvas. Descartar?")) { renderHeader(); return; }
    const flow = await api(botUrl(`/visual-flows/${encodeURIComponent(flowId)}`));
    state.dirty = false; state.undo = []; state.redo = []; state.errors = []; state.warnings = []; state.selection = new Set();
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
    const name = window.prompt("Nome do novo fluxo (ex.: Suporte, Comercial, Garantia):", "Novo fluxo");
    if (!name?.trim()) return;
    try {
      const created = await api(botUrl("/visual-flows"), { method: "POST", body: JSON.stringify({ name }) });
      state.options = await api(botUrl("/visual-flow-options"));
      await loadFlowList();
      await openFlow(created.id);
    } catch (error) { toast(error.message, true); }
  });

  window.addEventListener("beforeunload", (event) => {
    if (state.dirty) { event.preventDefault(); event.returnValue = ""; }
  });
  window.addEventListener("resize", () => { renderEdges(); renderMinimap(); });

  $("#theme-toggle").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("mibro-theme", next); } catch { /* preferência só local */ }
  });

  async function init() {
    if (!botId) { location.replace("/bots"); return; }
    try {
      state.options = await api(botUrl("/visual-flow-options"));
      renderLibrary();
      await loadFlowList();
      let flowId = params.get("flowId");
      if (!flowId || !state.flows.some((flow) => flow.id === flowId)) flowId = state.flows.find((flow) => flow.isDefault)?.id || state.flows[0]?.id;
      if (!flowId) {
        const created = await api(botUrl("/visual-flows"), { method: "POST", body: JSON.stringify({ name: "Fluxo principal" }) });
        await loadFlowList();
        flowId = created.id;
      }
      await openFlow(flowId);
      updateSelectionInfo();
    } catch (error) {
      toast(error.message, true);
      $("#fb-bot-name").textContent = "Não foi possível abrir o editor";
    }
  }
  init();
})();
