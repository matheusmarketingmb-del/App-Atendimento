// READ_ONLY (apenas consulta de status de pagamento). Nunca processa ou
// altera pagamento — isso seria SENSITIVE_ACTION, fora de escopo nesta fase.
// Sem gateway de pagamento integrado — degrada para NOT_CONFIGURED.
const { NotConfiguredTool } = require("../bot-tool");

class PaymentTool extends NotConfiguredTool {
  constructor() {
    super({
      name: "PaymentTool",
      description: "Consulta o status de pagamento de um pedido (não processa nem altera pagamentos).",
      riskLevel: "READ_ONLY",
      requiredEntities: ["orderNumber"],
    });
  }
}

module.exports = { PaymentTool };
