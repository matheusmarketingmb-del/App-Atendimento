// READ_ONLY. Sem catálogo de produtos integrado — degrada para NOT_CONFIGURED.
const { NotConfiguredTool } = require("../bot-tool");

class ProductTool extends NotConfiguredTool {
  constructor() {
    super({
      name: "ProductTool",
      description: "Consulta informações de um produto (disponibilidade, especificações) por nome ou SKU.",
      riskLevel: "READ_ONLY",
      requiredEntities: ["productName"],
    });
  }
}

module.exports = { ProductTool };
