// READ_ONLY. Sem integração de rastreio (Frenet/Correios/transportadora)
// configurada — degrada para NOT_CONFIGURED.
const { NotConfiguredTool } = require("../bot-tool");

class TrackingTool extends NotConfiguredTool {
  constructor() {
    super({
      name: "TrackingTool",
      description: "Consulta o status de rastreio de uma entrega por número do pedido (ou código de rastreio, quando já conhecido).",
      riskLevel: "READ_ONLY",
      // orderNumber é suficiente para iniciar o rastreio (item 8: fluxo
      // "onde está meu pedido?" usa apenas o número do pedido).
      requiredEntities: ["orderNumber"],
    });
  }
}

module.exports = { TrackingTool };
