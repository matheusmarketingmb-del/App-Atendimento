const ASSISTANT_INTAKE_BOTS = [
  "mibro-assistant-observer", "sincrofit-assistant",
  "mibro-after-hours-assistant", "sincrofit-after-hours-assistant",
];

const FIELD_LABELS = new Map(Object.entries({
  "flow.atendimentoNeed": "Solicitação inicial",
  "flow.customerProblem": "Problema relatado",
  "flow.problem": "Problema relatado",
  "flow.product": "Produto e modelo",
  "flow.model": "Modelo do produto",
  "flow.technicalAttempts": "Início do problema e tentativas",
  "flow.attempts": "O que já foi tentado",
  "flow.purchase": "Dados da compra",
  "flow.partnershipProfiles": "Redes sociais",
  "flow.partnershipFormat": "Formato da parceria",
  "flow.partnershipReach": "Média de visualizações",
  "flow.partnershipRate": "Valores e mídia kit",
}));

async function visibleAssistantIntake(execution, visibleMessages, findVisibleMessages) {
  const answers = execution?.context?._engine?.intakeAnswers;
  if (execution?.status !== "HANDED_OFF" || !Array.isArray(answers) || !answers.length) return null;
  const refs = answers.filter(answer => typeof answer?.messageId === "string").slice(-20);
  const ids = new Set(refs.map(answer => answer.messageId));
  const messages = new Map(visibleMessages.filter(message => ids.has(message.id)).map(message => [message.id, message]));
  const missing = [...ids].filter(id => !messages.has(id));
  if (missing.length) {
    for (const message of await findVisibleMessages(missing)) messages.set(message.id, message);
  }
  const fields = refs.flatMap(answer => {
    const message = messages.get(answer.messageId);
    if (message?.direction !== "RECEBIDA" || typeof message.text !== "string" || !message.text.trim()) return [];
    const label = FIELD_LABELS.get(answer.variable) || String(answer.question || "").trim() || "Resposta";
    const text = message.text.trim();
    return [{ label, text: text.length > 2000 ? `${text.slice(0, 2000)}…` : text }];
  });
  return fields.length ? { fields, finishedAt: execution.finishedAt } : null;
}

module.exports = { ASSISTANT_INTAKE_BOTS, visibleAssistantIntake };
