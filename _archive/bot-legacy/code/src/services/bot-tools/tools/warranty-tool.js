// READ_ONLY. Sem sistema de garantia integrado — degrada para NOT_CONFIGURED.
const { NotConfiguredTool } = require("../bot-tool");

class WarrantyTool extends NotConfiguredTool {
  constructor() {
    super({
      name: "WarrantyTool",
      description: "Consulta a situação de garantia de um produto por número de série ou número do pedido.",
      riskLevel: "READ_ONLY",
      requiredEntities: ["serialNumber"],
    });
  }
}

module.exports = { WarrantyTool };
