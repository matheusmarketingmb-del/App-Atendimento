// READ_ONLY. Sem base de números de série integrada — degrada para NOT_CONFIGURED.
const { NotConfiguredTool } = require("../bot-tool");

class SerialNumberTool extends NotConfiguredTool {
  constructor() {
    super({
      name: "SerialNumberTool",
      description: "Consulta dados de um produto a partir do número de série.",
      riskLevel: "READ_ONLY",
      requiredEntities: ["serialNumber"],
    });
  }
}

module.exports = { SerialNumberTool };
