const PATTERNS = Object.freeze([
  { id: "wholesale", label: "Quero comprar no atacado" },
  { id: "information", label: "Olá! Posso ter mais informações sobre isso?" },
]);
function normalize(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}
const normalized = new Map(PATTERNS.map(p => [normalize(p.label), p.id]));
function entryPattern(text) { return normalized.get(normalize(text)) || null; }

function withoutSincrofitSiteGreeting(graph, bot) {
  if (bot?.companyId !== "cmp_sincrofit" || !["sincrofit-assistant", "sincrofit-after-hours-assistant"].includes(bot.id)) return graph;
  const oldGreeting = "Olá! Você pode conferir nossos produtos de forma mais clara e conhecer as opções disponíveis em nosso site: https://sincrofit.com.br/";
  const site = graph.nodes.find(node => node.key === "site" && node.type === "message" && node.config?.text === oldGreeting);
  const next = site && graph.edges.find(edge => edge.source === site.key && edge.sourceHandle === "next");
  if (!next) return graph;
  return { ...graph, nodes: graph.nodes.filter(node => node !== site),
    edges: graph.edges.filter(edge => edge.source !== site.key)
      .map(edge => edge.target === site.key ? { ...edge, target: next.target } : edge) };
}
module.exports = { PATTERNS, entryPattern, withoutSincrofitSiteGreeting };
