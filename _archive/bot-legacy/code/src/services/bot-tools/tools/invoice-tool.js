// READ_ONLY. Sem sistema fiscal/nota fiscal integrado — degrada para NOT_CONFIGURED.
const { NotConfiguredTool } = require("../bot-tool");

class InvoiceTool extends NotConfiguredTool {
  constructor() {
    super({
      name: "InvoiceTool",
      description: "Consulta a nota fiscal de um pedido por número do pedido.",
      riskLevel: "READ_ONLY",
      requiredEntities: ["orderNumber"],
    });
  }
}

module.exports = { InvoiceTool };
