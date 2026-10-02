// READ_ONLY. Sem integração de pedidos configurada nesta instalação (não há
// serviço Shopify/Olist em src/services) — degrada para NOT_CONFIGURED em
// vez de derrubar a aplicação ou inventar dados de pedido.
const { NotConfiguredTool } = require("../bot-tool");

class OrderTool extends NotConfiguredTool {
  constructor() {
    super({
      name: "OrderTool",
      description: "Consulta dados de um pedido (status, itens, valor) por número do pedido, CPF/CNPJ ou e-mail.",
      riskLevel: "READ_ONLY",
      requiredEntities: ["orderNumber"],
    });
  }
}

module.exports = { OrderTool };
