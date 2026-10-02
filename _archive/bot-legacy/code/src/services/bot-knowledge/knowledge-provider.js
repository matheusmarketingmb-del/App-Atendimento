// Item 3/4: separa "entender a intenção" (GlobalIntent/BotIntent) de "saber
// a resposta" (KnowledgeSource). Sem RAG/banco vetorial nesta fase — busca
// estruturada por texto/tags/tipo/intenção/produto/categoria, montada para
// permitir semântica futura (embeddings/vetor) sem quebrar a assinatura
// pública de search(). Regras de segurança: nunca retorna conteúdo
// desativado ou expirado; nunca inventa nada além do que está no banco.
const prisma = require("../../database/prisma");
const { normalizeText } = require("../bot-simulator-service");
const { isActiveNow } = require("../bot-knowledge-source-service");

const knowledgeDomains = Object.freeze([
  "FAQ", "MANUAL", "PRODUCT", "POLICY", "WARRANTY", "PROCEDURE", "GENERAL", "OTHER",
]);

class KnowledgeProvider {
  // Deve retornar uma lista de trechos relevantes: [{ domain, title, content, score, source }].
  // eslint-disable-next-line no-unused-vars
  async search(_query, _domains = knowledgeDomains) {
    throw new Error("Nenhum KnowledgeProvider implementado nesta fase.");
  }
}

function scoreText(queryTokens, text) {
  if (!text) return 0;
  const tokens = new Set(normalizeText(text).split(/\s+/).filter(Boolean));
  if (!tokens.size || !queryTokens.length) return 0;
  const hits = queryTokens.filter((token) => tokens.has(token)).length;
  return hits / queryTokens.length;
}

// Implementação real (sem semântica) apoiada no modelo KnowledgeSource.
// Nunca retorna itens inativos/expirados (item 3: "conteúdo desativado ou
// expirado nunca é retornado/usado"). `filters` permite restringir por
// domínio estruturado (Bot, GlobalIntent/BotIntent, categoria, produto,
// tags) além do texto livre da consulta.
class KnowledgeSourceProvider extends KnowledgeProvider {
  constructor(client = prisma) {
    super();
    this.client = client;
  }

  // Item 6 (ranking): 1) produto/modelo exato > 2) intenção > 3) categoria >
  // 4) tags > 5) conteúdo geral (texto). Os filtros `product`/`intentId`/
  // `category`/`tags` continuam OPCIONAIS no WHERE (item 5, comentário
  // acima) — aqui eles também viram BOOST de score quando o registro bate
  // exatamente, para que "Pareamento GS Pro 2" vença um artigo genérico
  // mesmo quando ambos passam no filtro de texto.
  async search(query, {
    domains = knowledgeDomains, botId = null, intentId = null, globalIntentId = null,
    category = null, product = null, tags = [], limit = 5, minScore = 0.15,
  } = {}) {
    // Cada filtro estruturado é opcional: quando informado, aceita tanto o
    // registro específico daquele escopo (ex.: desta intenção) quanto um
    // registro genérico (sem esse campo preenchido) — conhecimento geral
    // continua aparecendo mesmo filtrando por Bot/intenção/categoria/produto.
    const andClauses = [{ active: true }];
    if (domains && domains.length && domains.length < knowledgeDomains.length) andClauses.push({ type: { in: domains } });
    if (botId) {
      andClauses.push({
        OR: [
          { botAccesses: { some: { botId } } },
          { botId },
          { AND: [{ botId: null }, { botAccesses: { none: {} } }] },
        ],
      });
    }
    if (intentId) andClauses.push({ OR: [{ intentId }, { intentId: null }] });
    if (globalIntentId) andClauses.push({ OR: [{ globalIntentId }, { globalIntentId: null }] });
    if (category) andClauses.push({ OR: [{ category }, { category: null }] });
    if (product) andClauses.push({ OR: [{ product }, { product: null }] });
    if (tags && tags.length) andClauses.push({ tags: { hasSome: tags } });
    const where = { AND: andClauses };

    const now = new Date();
    const rows = await this.client.knowledgeSource.findMany({ where, take: 200 });
    const active = rows.filter((row) => isActiveNow(row, now));

    const queryTokens = normalizeText(query || "").split(/\s+/).filter(Boolean);
    const normalizedProduct = product ? normalizeText(product) : null;
    const normalizedCategory = category ? normalizeText(category) : null;
    const normalizedTags = new Set((tags || []).map((tag) => normalizeText(tag)));

    const scored = active.map((row) => {
      const textScore = queryTokens.length
        ? Math.min(1, (scoreText(queryTokens, row.title) * 1.5 + scoreText(queryTokens, row.content || "")) / 2)
        : 0.3;
      // Boosts de especificidade (item 6), somados sobre o score textual —
      // nunca substituem a checagem de "ativo/vigente" nem o filtro do WHERE,
      // só decidem a ORDEM entre resultados que já passaram por ambos.
      const productBoost = normalizedProduct && row.product && normalizeText(row.product) === normalizedProduct ? 3 : 0;
      const intentBoost = intentId && row.intentId === intentId ? 1.5 : 0;
      const categoryBoost = normalizedCategory && row.category && normalizeText(row.category) === normalizedCategory ? 0.75 : 0;
      const tagBoost = (row.tags || []).some((tag) => normalizedTags.has(normalizeText(tag)) || queryTokens.includes(normalizeText(tag))) ? 0.4 : 0;
      const score = textScore + productBoost + intentBoost + categoryBoost + tagBoost;
      return {
        id: row.id,
        domain: row.type,
        title: row.title,
        content: row.content,
        score,
        source: row.source,
        category: row.category,
        product: row.product,
        version: row.version,
        globalIntentId: row.globalIntentId,
        intentId: row.intentId,
        // Especificidade "mais alta" atingida por este item — usada só para
        // detectar conflito (dois itens no MESMO nível de especificidade),
        // nunca para decidir a ordem (o `score` já faz isso).
        specificity: productBoost ? "PRODUCT" : intentBoost ? "INTENT" : categoryBoost ? "CATEGORY" : tagBoost ? "TAGS" : "GENERAL",
      };
    });

    const results = scored
      .filter((item) => item.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    // Item 6 (conflito): dois resultados válidos, na MESMA especificidade
    // mais alta, com conteúdo diferente e score muito próximo — nunca
    // escolher um dos dois "no escuro". Quem chama (bot-knowledge-response-
    // service.js / bot-flow-service.js) decide o que fazer (handoff/resposta
    // segura), nunca esta camada.
    const conflict = results.length >= 2
      && results[0].specificity === results[1].specificity
      && results[0].content !== results[1].content
      && (results[0].score - results[1].score) < 0.1;
    // Propriedade extra num array normal (nunca quebra .length/[i] para quem
    // já consome o retorno como array simples).
    Object.defineProperty(results, "conflict", { value: conflict, enumerable: false });

    return results;
  }
}

module.exports = { KnowledgeProvider, KnowledgeSourceProvider, knowledgeDomains };
