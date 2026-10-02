// Registro central de Tools (itens 5-7). Regra obrigatória: a IA interpreta,
// o BACKEND decide e executa — nenhuma Tool aqui é chamada diretamente pelo
// interpretador/decisor/modelo de IA. Quem valida permissão e chama
// tool.execute() é sempre bot-tool-orchestrator-service.js.
//
// Fase atual: só Tools READ_ONLY têm implementação real (mesmo que
// NOT_CONFIGURED por falta de integração externa disponível nesta
// instalação — não há serviço Shopify/Olist/Frenet em src/services). Nenhuma
// Tool SENSITIVE_ACTION (cancelamento, reembolso, troca de endereço/
// cobrança, alteração de pedido) existe nesta fase — ver BotTool.canExecute.
const { OrderTool } = require("./tools/order-tool");
const { TrackingTool } = require("./tools/tracking-tool");
const { ProductTool } = require("./tools/product-tool");
const { SerialNumberTool } = require("./tools/serial-number-tool");
const { WarrantyTool } = require("./tools/warranty-tool");
const { InvoiceTool } = require("./tools/invoice-tool");
const { PaymentTool } = require("./tools/payment-tool");

const instances = [
  new OrderTool(),
  new TrackingTool(),
  new ProductTool(),
  new SerialNumberTool(),
  new WarrantyTool(),
  new InvoiceTool(),
  new PaymentTool(),
];

const tools = {};
for (const tool of instances) tools[tool.name] = tool;

function getTool(name) {
  return tools[name] || null;
}

// Compatível com o formato anterior (name/description) consumido por
// bot-governance-service.js (resolveToolPermissions), com os campos novos do
// contrato (riskLevel/enabled/requiredEntities/supportedChannels) somados.
function listTools() {
  return instances.map((tool) => ({
    name: tool.name,
    description: tool.description,
    riskLevel: tool.riskLevel,
    enabled: tool.enabled,
    requiredEntities: tool.requiredEntities,
    supportedChannels: tool.supportedChannels,
  }));
}

module.exports = { getTool, listTools, tools };
