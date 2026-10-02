// Contrato base de uma Tool (itens 5-7). Regra obrigatória: a IA só SUGERE
// {action:"QUERY_TOOL", tool, entities} — quem valida (tool existe, está
// habilitada, o Bot tem permissão, entidades obrigatórias presentes,
// operação permitida) e executa é sempre o backend
// (bot-tool-orchestrator-service.js). Nenhuma Tool é chamada diretamente
// pelo interpretador/decisor/modelo de IA.
const RISK_LEVELS = Object.freeze(["READ_ONLY", "SAFE_ACTION", "SENSITIVE_ACTION"]);

class BotTool {
  /**
   * @param {object} opts
   * @param {string} opts.name
   * @param {string} opts.description
   * @param {boolean} [opts.enabled]
   * @param {"READ_ONLY"|"SAFE_ACTION"|"SENSITIVE_ACTION"} opts.riskLevel
   * @param {string[]} [opts.requiredEntities]
   * @param {string[]} [opts.supportedChannels] vazio/undefined = todos os canais.
   */
  constructor({ name, description, enabled = true, riskLevel, requiredEntities = [], supportedChannels = [] }) {
    if (!name) throw new Error("BotTool requer name.");
    if (!RISK_LEVELS.includes(riskLevel)) throw new Error(`BotTool "${name}": riskLevel inválido.`);
    this.name = name;
    this.description = description || "";
    this.enabled = enabled !== false;
    this.riskLevel = riskLevel;
    this.requiredEntities = requiredEntities;
    this.supportedChannels = supportedChannels;
  }

  // Verifica se, dado o contexto (canal, entidades já extraídas), esta Tool
  // pode ser considerada — NÃO checa permissão do Bot (isso é do
  // orquestrador, que conhece Bot.toolPermissions/toolsEnabled).
  canExecute({ channel, entities = {} } = {}) {
    if (!this.enabled) return { ok: false, reason: "TOOL_DISABLED" };
    if (this.riskLevel === "SENSITIVE_ACTION") return { ok: false, reason: "SENSITIVE_ACTION_BLOCKED" };
    if (this.supportedChannels.length && channel && !this.supportedChannels.includes(channel)) {
      return { ok: false, reason: "CHANNEL_NOT_SUPPORTED" };
    }
    const missing = this.requiredEntities.filter((key) => !entities || !entities[key]);
    if (missing.length) return { ok: false, reason: "MISSING_ENTITIES", missing };
    return { ok: true };
  }

  // Valida o formato do input antes de executar (defesa extra, independente
  // de canExecute). Implementação padrão: exige as requiredEntities.
  validateInput(input = {}) {
    const missing = this.requiredEntities.filter((key) => !input || !input[key]);
    if (missing.length) return { valid: false, missing };
    return { valid: true };
  }

  // Implementações reais sobrescrevem _run(input). execute() nunca deve ser
  // sobrescrito — centraliza o envelope de resultado padrão (nunca deixa a
  // exceção escapar para quem chamou; sempre {success, data, message}).
  async execute(input = {}) {
    const validation = this.validateInput(input);
    if (!validation.valid) {
      return { success: false, reason: "INVALID_INPUT", missing: validation.missing, data: null, message: null };
    }
    try {
      return await this._run(input);
    } catch (error) {
      return { success: false, reason: "TOOL_ERROR", error: error.message, data: null, message: null };
    }
  }

  // eslint-disable-next-line no-unused-vars
  async _run(_input) {
    throw new Error(`${this.name}._run não implementado.`);
  }
}

// Tool cujo backend de dados ainda não está configurado nesta instalação
// (sem Shopify/Olist/etc. disponível) — nunca derruba a aplicação; sempre
// degrada para uma resposta segura de "não disponível".
class NotConfiguredTool extends BotTool {
  async _run() {
    return { success: false, reason: "NOT_CONFIGURED", data: null, message: null };
  }
}

module.exports = { BotTool, NotConfiguredTool, RISK_LEVELS };
