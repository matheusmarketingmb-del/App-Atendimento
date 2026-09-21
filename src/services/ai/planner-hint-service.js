// Camada determinística de sinais/hints — roda ANTES (para os 4 casos de
// certeza máxima, que dispensam o LLM inteiramente) e é reaproveitada DEPOIS
// (planner-output-guard.js usa os mesmos sinais para decidir se um HANDOFF
// devolvido pelo Qwen tem evidência real). Nunca chama RAG/Ollama, nunca
// tem I/O — puro e testável isoladamente, igual ao guard.
//
// Princípio: DECISÕES ÓBVIAS NÃO DEVEM DEPENDER SÓ DO LLM. Só os casos de
// ALTA CERTEZA abaixo forçam action (forceAction) — tudo que é nuance,
// ambiguidade ou síntese continua com o Qwen. Regex tolerante o bastante
// pra cobrir variação de frase, mas nunca virando um classificador pesado.
const { normalizeText } = require("../bot-simulator-service");

// A) Pedido explícito de humano — mesma intenção do fast path já existente
// em rag/answer_with_ai.py (HUMAN_REQUEST_PATTERN), agora também aqui, ANTES
// de qualquer chamada à IA. Prioridade máxima — nunca sobrescrita pelo LLM.
const HUMAN_REQUEST_PATTERN = /\b(falar|atendimento|quero)\b.{0,20}\b(atendente|pessoa|humano|alguem)\b|\batendente humano\b|\bme transfer[ei]\b|\btransfere (pra|para) (um )?(atendente|humano)\b/;

// B) Risco de segurança — mesma intenção do fast path já existente em
// rag/answer_with_ai.py (SAFETY_HAZARD_PATTERN), ampliada com os exemplos
// explícitos deste pedido (fumaça, derretendo, faísca).
const SAFETY_HAZARD_PATTERN = /\b(pegando fogo|solt(ando|ou) fumaca|cheiro de queimado|derretendo|derreteu|faisca|explodiu|estourou)\b|\b(muito quente|esquentando muito|superaquec\w*)\b|\btela\b.{0,12}\b(levantou|estufou|inchou|estufada)\b|\bbateria\b.{0,12}\b(inchada|estufada|vazando)\b/;

// C) Confirmação inequívoca de solução — só dispara quando (1) a mensagem
// inteira é uma confirmação curta e (2) o turno anterior do ASSISTENTE
// parecia uma orientação de troubleshooting. "funcionou" solto, sem esse
// contexto, não é forçado (pode ser sobre outra coisa qualquer).
const RESOLUTION_CONFIRMATION_PATTERN = /^(funcionou|resolveu|resolvido|deu certo|agora (funcionou|foi|deu certo)|show,? funcionou|beleza,? funcionou)[.!]*$/;
const TROUBLESHOOTING_REPLY_HINT = /\b(confira|confere|verifique|tente|tenta|reinicie|reinicia|encaixe|encaixa|aperte|aperta|limpe|limpa)\b/;

// D) Pedido real de status de pedido — nenhuma ferramenta de pedido existe
// nesta etapa (ver "FERRAMENTAS / DADOS DINÂMICOS"); nunca fingir consulta
// real. Filtra pergunta GERAL de processo ("como funciona o rastreio?"),
// que deve continuar indo para a Knowledge normalmente.
const ORDER_STATUS_REAL_CASE_PATTERN = /\b(onde esta|cade|status (do|de|deste)) (o )?(meu )?pedido\b|\bmeu pedido (nao chegou|ainda nao chegou|ainda esta)\b/;

// Distingue pergunta GERAL de processo ("como funciona a garantia?") de um
// CASO REAL ("quero acionar garantia") — usado para não deixar os sinais de
// evidência abaixo (garantia/reembolso) dispararem numa pergunta informativa.
const GENERAL_PROCESS_QUESTION_PATTERN = /\bcomo (funciona|faco|funcionam)\b|\bqual (e |eh )?o processo\b|\bo que (e|cobre)\b/;

// E) Sintoma técnico simples ("não carrega", "não liga"...) — usado só para
// corrigir RESPOND→WAIT quando a resposta já É uma orientação de
// troubleshooting (ver guard): o Qwen às vezes rotula certo o conteúdo mas
// erra o rótulo da action nesse caso específico.
const SUPPORT_SYMPTOM_PATTERN = /\bnao (carrega|liga|conecta|pareia|sincroniza|aparece|funciona|vibra)\b|\bgps nao pega\b|\bnotificacao nao chega\b|\btela (nao acende|preta|congelada)\b/;

// Sinais de EVIDÊNCIA (não forçam action sozinhos — usados pelo guard para
// decidir se um HANDOFF que o LLM devolveu tem justificativa real).
const WARRANTY_REAL_CASE_PATTERN = /\b(acionar|abrir|solicitar) (a )?garantia\b|\bcom defeito\b.*\bgarantia\b|\bgarantia\b.*\bdefeito\b|\bquero (a )?garantia\b/;
const REFUND_REAL_CASE_PATTERN = /\bmeu dinheiro de volta\b|\bquero (o )?reembolso\b|\bja devolvi\b.*\bnao receb/;
const LOGISTICS_ISSUE_PATTERN = /\bchegou (quebrado|danificado|com defeito|errado)\b|\baparece entregue\b.*\bnao receb|\bnao chegou\b.*\bpedido\b|\bcaiu\b.*\brelogio\b|\bmolhou\b.*\b(relogio|nao liga)\b/;
const COMMERCIAL_NEGOTIATION_PATTERN = /\bnegociar\b.*\b(desconto|preco|condicao)\b|\bdesconto\b.*\b\d{2,}\s*(unidades?|pecas?)\b/;
const PAYMENT_ISSUE_PATTERN = /\bcobranca (indevida|errada|duplicada)\b|\bestorno\b|\bpagamento (nao (passou|foi aceito)|duplicado)\b/;

function lastAssistantTurn(history) {
  return [...(history || [])].reverse().find((turn) => String(turn?.role || "").toLowerCase() === "assistant");
}

function detectSignals(normalizedMessage, history) {
  const troubleshootingContext = TROUBLESHOOTING_REPLY_HINT.test(
    normalizeText(lastAssistantTurn(history)?.content || "")
  );
  const isGeneralQuestion = GENERAL_PROCESS_QUESTION_PATTERN.test(normalizedMessage);

  return {
    humanRequest: HUMAN_REQUEST_PATTERN.test(normalizedMessage),
    safetyHazard: SAFETY_HAZARD_PATTERN.test(normalizedMessage),
    resolutionConfirmed: RESOLUTION_CONFIRMATION_PATTERN.test(normalizedMessage) && troubleshootingContext,
    orderStatusRealCase: ORDER_STATUS_REAL_CASE_PATTERN.test(normalizedMessage) && !isGeneralQuestion,
    warrantyRealCase: WARRANTY_REAL_CASE_PATTERN.test(normalizedMessage) && !isGeneralQuestion,
    refundRealCase: REFUND_REAL_CASE_PATTERN.test(normalizedMessage) && !isGeneralQuestion,
    logisticsIssue: LOGISTICS_ISSUE_PATTERN.test(normalizedMessage),
    commercialNegotiation: COMMERCIAL_NEGOTIATION_PATTERN.test(normalizedMessage),
    paymentIssue: PAYMENT_ISSUE_PATTERN.test(normalizedMessage),
    supportSymptom: SUPPORT_SYMPTOM_PATTERN.test(normalizedMessage),
  };
}

// Exportado para o guard reaproveitar (RESPOND cujo TEXTO já é uma
// orientação de troubleshooting deveria ter sido rotulado WAIT).
function looksLikeTroubleshootingAnswer(answer) {
  return TROUBLESHOOTING_REPLY_HINT.test(normalizeText(answer || ""));
}

// Núcleo público: recebe a mensagem crua do cliente + histórico já
// recortado (mesmo formato usado por askRag — [{role, content}]).
function computePlannerHint({ message, history = [] } = {}) {
  const normalizedMessage = normalizeText(message);
  const signals = detectSignals(normalizedMessage, history);

  // Ordem importa: humano > segurança > confirmação de solução > pedido
  // real sem ferramenta — cada um é 100% determinístico, nunca "empatam".
  if (signals.humanRequest) {
    return {
      detectedSignals: signals, forceAction: "HANDOFF", forceReason: "customer_requested_human", forceNeedsHuman: true,
      forceAnswer: "Claro! Vou te encaminhar para um de nossos atendentes, só um instante.",
    };
  }
  if (signals.safetyHazard) {
    return {
      detectedSignals: signals, forceAction: "HANDOFF", forceReason: "safety_issue", forceNeedsHuman: true,
      forceAnswer: "Pare de usar o relógio e não o coloque para carregar. Não pressione nem tente abrir o dispositivo. Vou encaminhar esse caso para avaliação imediatamente.",
    };
  }
  if (signals.resolutionConfirmed) {
    return {
      detectedSignals: signals, forceAction: "RESOLVE", forceReason: "customer_confirmed_solution", forceNeedsHuman: false,
      forceAnswer: "Que bom que funcionou! Se precisar de mais alguma coisa, é só chamar.",
    };
  }
  if (signals.orderStatusRealCase) {
    return {
      detectedSignals: signals, forceAction: "HANDOFF", forceReason: "tool_failure", forceNeedsHuman: true,
      forceAnswer: "Ainda não tenho acesso ao status de pedidos em tempo real por aqui — vou encaminhar para a equipe confirmar isso para você.",
    };
  }

  return { detectedSignals: signals, forceAction: null, forceReason: null, forceNeedsHuman: null, forceAnswer: null };
}

// Usado pelo guard: um HANDOFF só sobrevive quando há pelo menos um sinal
// de evidência real, OU quando o próprio reason já vem de um sinal confiável
// do RAG Server (low_confidence/tool_failure — retrieval fraco/vazio/erro de
// parsing, que o Node não tem como reavaliar de fora, então confia nele).
function handoffHasEvidence(signals, reason) {
  if (reason === "low_confidence" || reason === "tool_failure") return true;
  return Boolean(
    signals?.humanRequest || signals?.safetyHazard || signals?.warrantyRealCase || signals?.refundRealCase
    || signals?.logisticsIssue || signals?.commercialNegotiation || signals?.paymentIssue || signals?.orderStatusRealCase
  );
}

// Quando um reason precisa ser trocado (fora da allowlist da action, ou sem
// evidência), prefere o reason mais ESPECÍFICO que os sinais sustentam, em
// vez de cair direto no genérico — só usa o genérico se nada mais bater.
function reasonFromSignals(signals, allowedReasons) {
  const candidates = [
    signals?.humanRequest && "customer_requested_human",
    signals?.safetyHazard && "safety_issue",
    signals?.warrantyRealCase && "warranty_review",
    signals?.refundRealCase && "payment_issue",
    signals?.logisticsIssue && "logistics_issue",
    signals?.commercialNegotiation && "commercial_negotiation",
    signals?.paymentIssue && "payment_issue",
    signals?.orderStatusRealCase && "tool_failure",
  ].filter(Boolean);
  return candidates.find((reason) => allowedReasons.includes(reason)) || null;
}

module.exports = { computePlannerHint, handoffHasEvidence, reasonFromSignals, looksLikeTroubleshootingAnswer };
