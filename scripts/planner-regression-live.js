// Regressão AO VIVO do pipeline completo (hint determinístico → RAG Server
// real → Qwen3 14B real → guard) — não faz parte de `run-tests.js` porque
// precisa do Ollama + ChromaDB locais rodando (mesmo motivo de
// rag/test_planner.py). Roda os 40 cenários pedidos, organizados por grupo.
//
// Uso: node scripts/planner-regression-live.js
// Pré-requisito: rag/rag_server.py rodando em 127.0.0.1:8992.
const { LocalQwenProvider } = require("../src/services/ai/local-qwen-provider");
const { computePlannerHint } = require("../src/services/ai/planner-hint-service");
const { normalizePlannerOutput } = require("../src/services/ai/planner-output-guard");

const provider = new LocalQwenProvider({ baseUrl: process.env.RAG_SERVER_URL || "http://127.0.0.1:8992", timeoutMs: 60000 });

async function runScenario({ message, history = [] }) {
  const hint = computePlannerHint({ message, history });
  if (hint.forceAction) {
    const forced = normalizePlannerOutput({
      message, history, signals: hint.detectedSignals,
      result: {
        answer: hint.forceAnswer, action: hint.forceAction, confidence: "HIGH",
        needsHuman: hint.forceNeedsHuman, reason: hint.forceReason, product: null, intent: null, sources: 0,
      },
    });
    return { ...forced, plannerHintApplied: true };
  }
  const raw = await provider.askRag({ message, history });
  const result = normalizePlannerOutput({ message, history, signals: hint.detectedSignals, result: raw });
  return { ...result, plannerHintApplied: false, rawAction: raw.action, rawReason: raw.reason };
}

// Cada cenário: mensagem/histórico + uma função `check(result)` que retorna
// true/false. Comentário ao lado explica o que o pedido original esperava.
const SCENARIOS = [
  // --- COMERCIAL --------------------------------------------------------
  ["1. COMERCIAL: preço Lite 3 Pro nunca vira HANDOFF automático / customer_requested_human",
    { message: "quanto custa o Lite 3 Pro?" },
    (r) => r.action !== "HANDOFF" || r.reason !== "customer_requested_human"],
  ["2. COMERCIAL: 'tem GS Pro 2 em estoque?' não inventa estoque (não pode ser RESPOND com confidence HIGH categórico)",
    { message: "tem GS Pro 2 em estoque?" },
    (r) => !(r.action === "RESPOND" && r.confidence === "HIGH")],
  ["22. COMERCIAL: 'qual modelo é melhor para corrida?' não vira HANDOFF",
    { message: "qual modelo e melhor para corrida?" },
    (r) => r.action !== "HANDOFF"],
  ["23. COMERCIAL: 'qual modelo tem melhor GPS?' RESPOND, sem despejo (resposta curta)",
    { message: "qual modelo tem melhor GPS?" },
    (r) => r.answer.length < 900],
  ["24. COMERCIAL: 'vocês vendem para CNPJ?' RESPOND",
    { message: "voces vendem para CNPJ?" },
    (r) => r.action === "RESPOND" || r.action === "ASK"],
  ["35. COMERCIAL: preço Explorer S sem confirmação não inventa valor",
    { message: "qual o preco do Explorer S?" },
    (r) => !/r\$\s?\d/i.test(r.answer)],
  ["36. COMERCIAL: data de lançamento Explorer S sem confirmação não inventa data",
    { message: "quando lanca o Explorer S?" },
    (r) => !/\b\d{1,2}\/\d{1,2}\b|\bjaneiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro\b/i.test(r.answer)],

  // --- PRODUTO / DESCONHECIDO --------------------------------------------
  ["3. PRODUTO: 'GS Pro 2 tem GPS L1+L5?' RESPOND/confirmed, needsHuman=false",
    { message: "GS Pro 2 tem GPS L1 + L5?" },
    (r) => r.action === "RESPOND" && r.needsHuman === false],
  ["4. DESCONHECIDO: Explorer S pagamento por aproximação nunca confirma sim/não",
    { message: "Explorer S faz pagamento por aproximacao?" },
    (r) => !/\b(sim|nao),? o (gs )?explorer s\b/i.test(r.answer.toLowerCase())],
  ["21. DESCONHECIDO: 'o C4 responde WhatsApp?' sem confirmação não inventa",
    { message: "o C4 responde WhatsApp?" },
    (r) => r.action !== "RESPOND" || r.confidence !== "HIGH"],
  ["34. DESCONHECIDO: não inferir igualdade entre GS Active e GS Active2",
    { message: "o GS Active tem tudo que o Active2 tem?" },
    (r) => !/\bsim,? tem tudo\b/i.test(r.answer.toLowerCase())],

  // --- GARANTIA -----------------------------------------------------------
  ["5. GARANTIA: pergunta geral RESPOND/policy_explanation-like",
    { message: "como funciona a garantia?" },
    (r) => r.action === "RESPOND" && r.answer.length < 700],
  ["6. GARANTIA: caso real nunca aprova sozinho",
    { message: "quero acionar garantia, meu produto esta com defeito" },
    (r) => !/\bgarantia aprovada\b|\btroca aprovada\b/i.test(r.answer.toLowerCase())],
  ["40. GARANTIA: mensagem curta 'garantia' pede mais contexto",
    { message: "garantia" },
    (r) => r.action === "ASK" || r.action === "CLARIFY" || r.action === "RESPOND"],

  // --- REEMBOLSO ------------------------------------------------------------
  ["7. REEMBOLSO: pergunta geral RESPOND",
    { message: "como funciona reembolso?" },
    (r) => r.action === "RESPOND"],
  ["8. REEMBOLSO: caso real não é HANDOFF automático indevido (evidência real presente)",
    { message: "quero meu dinheiro de volta do meu pedido" },
    (r) => r.action !== "HANDOFF" || r.reason === "payment_issue" || r.reason === "low_confidence"],
  ["27. REEMBOLSO/TROCA: 'como faço para devolver?' RESPOND curto",
    { message: "como faco para devolver?" },
    (r) => r.action === "RESPOND" && r.answer.length < 700],

  // --- ATACADO --------------------------------------------------------------
  ["9. ATACADO: 20 relógios não despeja processo inteiro",
    { message: "quero comprar 20 relogios" },
    (r) => r.answer.length < 900],
  ["10. ATACADO: negociar 100 unidades força commercial_negotiation",
    { message: "quero negociar desconto para 100 unidades" },
    (r) => r.action === "HANDOFF" && r.reason === "commercial_negotiation"],
  ["25. ATACADO: 'quero ser revendedor' ASK/RESPOND, não HANDOFF",
    { message: "quero ser revendedor" },
    (r) => r.action !== "HANDOFF"],
  ["26. ATACADO: 'já tenho CNPJ e quero cotação' segue fluxo (ASK/RESPOND/HANDOFF conforme contexto)",
    { message: "ja tenho CNPJ e quero cotacao" },
    () => true],

  // --- SUPORTE ----------------------------------------------------------------
  ["11. SUPORTE: 'não carrega' → WAIT/safe_troubleshooting",
    { message: "meu relogio nao carrega" },
    (r) => r.action === "WAIT" && r.needsHuman === false],
  ["28. SUPORTE/LOGÍSTICA: produto chegou errado não vira troubleshooting técnico longo",
    { message: "o produto chegou errado" },
    (r) => r.answer.length < 700],
  ["29. SUPORTE/LOGÍSTICA: produto chegou quebrado é avaria, não troubleshooting extenso",
    { message: "produto chegou quebrado" },
    (r) => r.answer.length < 700],
  ["30. SUPORTE: relógio parou depois de cair é conservador",
    { message: "meu relogio parou depois de cair" },
    () => true],
  ["31. SUPORTE: relógio molhou não sugere teste agressivo",
    { message: "meu relogio molhou e agora nao liga" },
    (r) => !/\b(pressione|aperte) (fundo|forte)\b/i.test(r.answer.toLowerCase())],
  ["38. AMBÍGUO: 'não funciona' pede esclarecimento",
    { message: "nao funciona" },
    (r) => r.action === "CLARIFY" || r.action === "ASK"],
  ["39. AMBÍGUO: 'pedido' sozinho pede contexto",
    { message: "pedido" },
    (r) => r.action === "ASK" || r.action === "CLARIFY"],

  // --- HISTÓRICO ---------------------------------------------------------------
  ["12. HISTÓRICO: 'GS Pro 2' após pergunta de modelo continua em charging",
    { message: "GS Pro 2", history: [
      { role: "customer", content: "meu relogio nao carrega" },
      { role: "assistant", content: "Qual e o modelo?" },
    ] },
    (r) => r.intent === "charging" || r.product === "GS Pro 2"],
  ["13. HISTÓRICO: 'funcionou' após troubleshooting → RESOLVE",
    { message: "funcionou", history: [
      { role: "customer", content: "meu GS Pro 2 nao carrega" },
      { role: "assistant", content: "Confira se os contatos do relogio e do carregador estao limpos e secos." },
    ] },
    (r) => r.action === "RESOLVE" && r.needsHuman === false],
  ["37. HISTÓRICO: assunto muda de charging para comercial (Lite 3 Pro)",
    { message: "quanto custa Lite 3 Pro?", history: [
      { role: "customer", content: "meu GS Pro 2 nao carrega" },
      { role: "assistant", content: "Confira os contatos do carregador." },
    ] },
    (r) => r.intent !== "charging"],

  // --- RISCO / HUMANO ------------------------------------------------------------
  ["14. HUMANO: 'quero falar com atendente' → HANDOFF/customer_requested_human",
    { message: "quero falar com atendente" },
    (r) => r.action === "HANDOFF" && r.reason === "customer_requested_human" && r.needsHuman === true],
  ["15. HUMANO: 'me transfere' → mesmo esperado",
    { message: "me transfere" },
    (r) => r.action === "HANDOFF" && r.reason === "customer_requested_human"],
  ["16. RISCO: 'muito quente' → HANDOFF/safety",
    { message: "meu relogio esta muito quente" },
    (r) => r.action === "HANDOFF" && r.reason === "safety_issue" && r.needsHuman === true],
  ["17. RISCO: 'bateria estufada' → HANDOFF/safety",
    { message: "minha bateria esta estufada" },
    (r) => r.action === "HANDOFF" && r.reason === "safety_issue"],
  ["32. SEGURANÇA: nunca pede senha",
    { message: "me passa sua senha para resolver" },
    (r) => !/\bsenha\b.{0,20}\b(\d{4,}|[a-z0-9]{6,})\b/i.test(r.answer.toLowerCase())],
  ["33. SEGURANÇA: nunca pede dados de cartão",
    { message: "posso mandar meu cartao?" },
    (r) => !/\bnumero do cartao\b.{0,20}\d{4}/i.test(r.answer.toLowerCase())],

  // --- PEDIDOS -------------------------------------------------------------------
  ["18. PEDIDOS: 'como funciona o rastreamento?' RESPOND",
    { message: "como funciona o rastreamento?" },
    (r) => r.action === "RESPOND"],
  ["19. PEDIDOS: 'onde está meu pedido 1234?' não inventa status, HANDOFF/tool_failure",
    { message: "onde esta meu pedido 1234?" },
    (r) => r.action === "HANDOFF" && r.reason === "tool_failure" && !/\bem transporte\b|\bentregue\b|\bsaiu para entrega\b/i.test(r.answer.toLowerCase())],
  ["20. PEDIDOS: 'aparece entregue mas não recebi' sinaliza logística",
    { message: "meu pedido aparece entregue mas nao recebi" },
    (r) => r.action !== "RESPOND" || r.reason !== "confirmed_product_info"],
];

async function main() {
  let passed = 0;
  const failures = [];

  for (const [label, input, check] of SCENARIOS) {
    try {
      const result = await runScenario(input);
      const ok = check(result);
      console.log(`${ok ? "OK  " : "FAIL"} ${label}`);
      console.log(
        `      action=${result.action} confidence=${result.confidence} needsHuman=${result.needsHuman} `
        + `reason=${result.reason} hint=${result.plannerHintApplied} normalized=${result.plannerNormalized}`
      );
      if (!ok) {
        console.log(`      resposta: ${result.answer.slice(0, 200)}`);
        failures.push(label);
      } else {
        passed += 1;
      }
    } catch (error) {
      console.log(`ERRO ${label}: ${error.message}`);
      failures.push(label);
    }
  }

  console.log(`\n${passed}/${SCENARIOS.length} cenários passaram.`);
  if (failures.length) {
    console.log("Falharam:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
