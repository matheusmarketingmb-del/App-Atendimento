// Constantes centralizadas do motor de interpretação de Bots.
// Nada aqui deve ser duplicado com números soltos pelo restante do código.

const CONTEXT_MESSAGE_LIMIT = 10;
const MAX_FAILED_INTERPRETATIONS = 3;
const DEFAULT_HIGH_CONFIDENCE_THRESHOLD = 0.8;
const DEFAULT_LOW_CONFIDENCE_THRESHOLD = 0.55;
// Item 13: abaixo desta confiança (do provider LOCAL), com
// externalAiFallbackEnabled=true, o motor pode tentar um provider externo.
const DEFAULT_EXTERNAL_AI_THRESHOLD = 0.7;

// Motor de IA / Fallback externo: providers REALMENTE implementados (item 3
// — "mostrar somente providers implementados"). "LOCAL" não é uma chamada
// externa (é o LocalFallbackProvider, sempre disponível); os demais só
// funcionam se houver credencial — pelo painel (ai-credential-service.js,
// cofre cifrado no banco) ou por variável de ambiente de compatibilidade
// (ver src/services/ai/get-ai-provider.js).
const EXTERNAL_AI_PROVIDERS = Object.freeze(["ANTHROPIC", "GEMINI", "OPENAI"]);
const AI_PROVIDER_OPTIONS = Object.freeze(["LOCAL", ...EXTERNAL_AI_PROVIDERS]);
// Item 8 (configuração sugerida inicial): Gemini pré-selecionado, mas o
// fallback externo continua OFF por padrão — só passa a ser chamado depois
// que um Master ligar externalAiFallbackEnabled explicitamente.
const DEFAULT_EXTERNAL_AI_PROVIDER = "GEMINI";

const BOT_ACTIONS = Object.freeze([
  "RESPOND",
  "ASK_CLARIFICATION",
  "HANDOFF_HUMAN",
  "SWITCH_BOT",
  "QUERY_TOOL",
  "NO_ACTION",
]);

const HUMAN_HANDOFF_PATTERNS = [
  /\bfalar com (um |uma )?(atendente|pessoa|humano|alguem)\b/,
  /\bquero (um |uma )?(atendente|pessoa|humano)\b/,
  /\bme (passa|transfere|transfira) (para|pra) (um |uma )?(atendente|pessoa|humano)\b/,
  /\bchama (um |uma )?(atendente|pessoa|humano)\b/,
  /\bpreciso falar com (um |uma )?(atendente|pessoa|humano)\b/,
  /\bnao quero (falar com )?(o |um )?rob(o|ô)\b/,
  /\bsem ser (o |um )?rob(o|ô)\b/,
  /\bquero falar com alguem de verdade\b/,
  /\batendimento humano\b/,
];

// Camada conversacional (bot-social-behavior-service.js): comportamentos
// sociais reconhecidos ao lado da intenção de negócio, sem virar intenção
// cadastrada. GREETING/THANKS/GOODBYE usam presença de frase (a mensagem
// pode ter conteúdo de negócio junto); CONFIRMATION/NEGATION/SMALL_TALK só
// disparam quando a mensagem inteira é a frase social (mensagem curta).
const SOCIAL_BEHAVIORS = Object.freeze([
  "GREETING", "THANKS", "GOODBYE", "SMALL_TALK", "CONFIRMATION", "NEGATION", "HUMAN_REQUEST", "BUSINESS_INTENT",
]);

const GREETING_PHRASES = [
  ["bom dia", "Bom dia"], ["boa tarde", "Boa tarde"], ["boa noite", "Boa noite"],
  ["ola", "Olá"], ["oi", "Oi"], ["opa", "Opa"], ["e ai", "E aí"], ["eae", "E aí"],
  ["tudo bem", "Tudo bem"], ["como vai", "Como vai"], ["fala", "Fala"],
];

const THANKS_PATTERNS = [/\bobrigad[oa]\b/, /\bvaleu\b/, /\bvlw\b/, /\bagradec/];

const GOODBYE_PATTERNS = [/\btchau\b/, /\bate mais\b/, /\bate logo\b/, /\bfalou\b/, /\bbom trabalho\b/];

const SMALL_TALK_PATTERNS = [
  /^quem e voce[?.! ]*$/, /^voce e (um )?rob(o|ô)[?.! ]*$/, /^o que voce faz[?.! ]*$/,
  /^como voce esta[?.! ]*$/,
];

const CONFIRMATION_PATTERN = /^(sim|ss|s|ok|okay|claro|pode ser|isso|isso mesmo|exatamente|confirmo|correto)[.!]*$/;
const NEGATION_PATTERN = /^(nao|n|nao e isso|errado)[.!]*$/;

// Aprendizado supervisionado (bot-learning-service.js).
const LEARNING_MESSAGE_LIMIT = 30;
const LEARNING_TEXT_MAX_LENGTH = 500;
const LEARNING_SIMILARITY_TOPIC_THRESHOLD = 0.6;
const LEARNING_SIMILARITY_CONTENT_THRESHOLD = 0.6;

const RESOLUTION_POSITIVE_PATTERNS = [
  /\bfuncionou\b/, /\bdeu certo\b/, /\bresolveu\b/, /\bagora foi\b/, /\bagora funcionou\b/, /\bconsegui\b/,
  /\bperfeito\b/, /\bvoltou ao normal\b/,
];
// "nao funcionou" precisa vir nos padrões NEGATIVOS — sem isso, a checagem
// positiva (\bfuncionou\b) casa com a palavra dentro da negação e o Flow
// Engine (bot-flow-service.js) entenderia "não funcionou" como sucesso.
const RESOLUTION_NEGATIVE_PATTERNS = [
  /\bnao funcionou\b/, /\bnao resolveu\b/, /\bcontinua igual\b/, /\bnao deu certo\b/, /\bainda nao\b/, /\bpiorou\b/,
  /\bsegue com problema\b/,
];

// Ordem de prioridade da decisão (bot-decision-service.js) — centralizada
// aqui só como referência/documentação; a ordem real de execução vive nos
// `if` sequenciais de decide(), mas deve sempre corresponder a esta lista.
const DECISION_PRIORITY_ORDER = Object.freeze([
  "BOT_INACTIVE",
  "GLOBAL_AUTOMATION_OFF",
  "OUTSIDE_HOURS",
  "HUMAN_REQUEST",
  "LOOP_PROTECTION",
  "SWITCH_PING_PONG_PROTECTION",
  "PENDING_CONTEXT",
  "BUSINESS_INTENT",
  "SMALL_TALK",
  "FALLBACK",
]);

// Feature flags por Bot (Bot.featureFlags, JSON validado/normalizado — ver
// bot-governance-service.js). Nunca usar strings soltas fora desta lista.
// Os três marcados como CRÍTICOS ficam em colunas dedicadas no Bot
// (autoReplyEnabled/toolsEnabled/ratingEnabled), não aqui.
const FEATURE_FLAG_DEFAULTS = Object.freeze({
  interpretationEnabled: true,
  conversationalBehaviorEnabled: true,
  contextEnabled: true,
  autoSwitchEnabled: true,
  observationEnabled: true,
  learningEnabled: true,
  // Sugestões de resposta exibidas na Central para o atendente. Desligar
  // não interrompe Observação/Aprendizado e nunca altera mensagens reais.
  agentSuggestionsEnabled: true,
  knowledgeSuggestionsEnabled: true,
  knowledgeBaseEnabled: false,
  handoffAutoPauseEnabled: true,
  // Item 9: liga/desliga o HANDOFF_HUMAN automático (decidido pelo motor).
  // Desligar não impede um atendente de assumir manualmente — só impede o
  // Bot de escalar sozinho (ex.: para operações que preferem manter o Bot
  // tentando até o limite de falhas). Default true = comportamento atual.
  handoffEnabled: true,
  // Item 9: liga/desliga a chamada de Tools por este Bot especificamente,
  // além do toggle crítico dedicado Bot.toolsEnabled — ambos precisam estar
  // ligados para uma Tool ser executada de verdade (ver
  // bot-tool-orchestrator-service.js).
  toolsFeatureEnabled: true,
  // Liga/desliga o Flow Engine (etapas configuráveis por intenção) por Bot.
  // Desligado, uma intenção com etapas cadastradas volta a responder uma
  // única vez (responseMessage/toolName/Base de Conhecimento), como antes.
  flowEngineEnabled: true,
  // Item 4 (resolução não finaliza tudo automaticamente): RESOLVED do Flow
  // Engine sempre responde (ex.: "Precisa de ajuda com mais alguma coisa?"),
  // mas só FINALIZA a Conversation de verdade quando este flag está ON.
  // Default OFF = comportamento atual (nunca finaliza sozinho).
  autoFinalizeOnResolution: false,
  // Item 12/13 (IA externa como fallback): desligado por padrão — o motor
  // nunca chama um provider externo em nenhuma mensagem até um Master ligar
  // isto explicitamente por Bot. Ligado, só é chamado quando a confiança
  // local ficar abaixo de externalAiThreshold (ou não reconhecer nada).
  externalAiFallbackEnabled: false,
  externalAiThreshold: DEFAULT_EXTERNAL_AI_THRESHOLD,
  // Item 3: qual provider externo este Bot usaria SE externalAiFallbackEnabled
  // estiver ligado — nunca chamado sozinho, sempre condicionado ao flag acima.
  externalAiProvider: DEFAULT_EXTERNAL_AI_PROVIDER,
  // Modelo dentro do provider escolhido acima — vazio usa o modelo padrão
  // configurado junto da credencial no painel (ou o default do próprio
  // provider). A CREDENCIAL é sempre global; só a escolha de modelo é por Bot.
  externalAiModel: "",
  contextMaxMessages: CONTEXT_MESSAGE_LIMIT,
  contextExpirationMinutes: 120,
  maxSwitchesPerWindow: 3,
  switchWindowMinutes: 10,
  // Plano de Inteligência de Bots (item 3 — Agent Planner): desligado por
  // padrão. Ligado, bot-orchestrator-service.js troca decide() pelo
  // Agent Planner (bot-agent-planner-service.js) para o caminho comum
  // (fora de Flow Engine) — Tools/Knowledge/Flow continuam exatamente pelos
  // mesmos serviços de sempre, nunca duplicados. Um Bot que nunca ligar isto
  // continua se comportando byte a byte como antes.
  agentPlannerEnabled: false,
});
const BOOLEAN_FEATURE_FLAG_KEYS = Object.freeze([
  "interpretationEnabled", "conversationalBehaviorEnabled", "contextEnabled", "autoSwitchEnabled",
  "observationEnabled", "learningEnabled", "agentSuggestionsEnabled", "knowledgeSuggestionsEnabled", "knowledgeBaseEnabled",
  "handoffAutoPauseEnabled", "handoffEnabled", "toolsFeatureEnabled", "flowEngineEnabled",
  "autoFinalizeOnResolution", "externalAiFallbackEnabled", "agentPlannerEnabled",
]);
const NUMERIC_FEATURE_FLAG_RANGES = Object.freeze({
  contextMaxMessages: { min: 1, max: 30 },
  contextExpirationMinutes: { min: 5, max: 1440 },
  maxSwitchesPerWindow: { min: 1, max: 20 },
  switchWindowMinutes: { min: 1, max: 180 },
});
// Item 13: faixas de ponto flutuante (0-1) — separadas de
// NUMERIC_FEATURE_FLAG_RANGES porque aquele valida com Number.isInteger.
const FLOAT_FEATURE_FLAG_RANGES = Object.freeze({
  externalAiThreshold: { min: 0, max: 1 },
});
// Feature flags de texto restrito a um vocabulário fixo — nunca uma string
// solta (mesmo espírito de RATING_REQUEST_MODES).
const ENUM_FEATURE_FLAG_KEYS = Object.freeze({
  externalAiProvider: AI_PROVIDER_OPTIONS,
});
// Feature flags de texto LIVRE (com limite de tamanho, nunca sem
// sanitização) — hoje só o nome do modelo do provider externo escolhido.
const FREE_TEXT_FEATURE_FLAG_KEYS = Object.freeze({
  externalAiModel: { maxLength: 120 },
});

const RATING_REQUEST_MODES = Object.freeze(["BOT_COMPLETED", "BEFORE_HANDOFF", "MANUAL", "NEVER"]);
const RATING_SCORE_MIN = 1;
const RATING_SCORE_MAX = 5;
const RATING_POSITIVE_MIN_SCORE = 4;
const RATING_NEGATIVE_MAX_SCORE = 2;

const LOOP_REPEAT_LIMIT = 2; // mesma resposta N vezes seguidas já é loop.
const MINIMUM_RATINGS_FOR_METRICS_PERCENTAGE = 5;

const PRESENTATION_ALLOWED_VARS = Object.freeze(["botName"]);
const DEFAULT_PRESENTATION_MESSAGE = "Olá! Eu sou a {{botName}}, assistente virtual da Mibro.";

function confidenceBand(bot, confidence) {
  const high = typeof bot?.highConfidenceThreshold === "number" ? bot.highConfidenceThreshold : DEFAULT_HIGH_CONFIDENCE_THRESHOLD;
  const low = typeof bot?.lowConfidenceThreshold === "number" ? bot.lowConfidenceThreshold : DEFAULT_LOW_CONFIDENCE_THRESHOLD;
  if (confidence >= high) return "HIGH";
  if (confidence >= low) return "MEDIUM";
  return "LOW";
}

function validateConfidenceThresholds(low, high) {
  if (typeof low !== "number" || typeof high !== "number") return false;
  return low >= 0 && high <= 1 && low <= high;
}

module.exports = {
  AI_PROVIDER_OPTIONS,
  BOOLEAN_FEATURE_FLAG_KEYS,
  BOT_ACTIONS,
  CONFIRMATION_PATTERN,
  CONTEXT_MESSAGE_LIMIT,
  DECISION_PRIORITY_ORDER,
  DEFAULT_EXTERNAL_AI_PROVIDER,
  DEFAULT_EXTERNAL_AI_THRESHOLD,
  DEFAULT_HIGH_CONFIDENCE_THRESHOLD,
  DEFAULT_LOW_CONFIDENCE_THRESHOLD,
  DEFAULT_PRESENTATION_MESSAGE,
  ENUM_FEATURE_FLAG_KEYS,
  EXTERNAL_AI_PROVIDERS,
  FEATURE_FLAG_DEFAULTS,
  FLOAT_FEATURE_FLAG_RANGES,
  FREE_TEXT_FEATURE_FLAG_KEYS,
  GOODBYE_PATTERNS,
  GREETING_PHRASES,
  HUMAN_HANDOFF_PATTERNS,
  LEARNING_MESSAGE_LIMIT,
  LEARNING_SIMILARITY_CONTENT_THRESHOLD,
  LEARNING_SIMILARITY_TOPIC_THRESHOLD,
  LEARNING_TEXT_MAX_LENGTH,
  LOOP_REPEAT_LIMIT,
  MAX_FAILED_INTERPRETATIONS,
  MINIMUM_RATINGS_FOR_METRICS_PERCENTAGE,
  NEGATION_PATTERN,
  NUMERIC_FEATURE_FLAG_RANGES,
  PRESENTATION_ALLOWED_VARS,
  RATING_NEGATIVE_MAX_SCORE,
  RATING_POSITIVE_MIN_SCORE,
  RATING_REQUEST_MODES,
  RATING_SCORE_MAX,
  RATING_SCORE_MIN,
  RESOLUTION_NEGATIVE_PATTERNS,
  RESOLUTION_POSITIVE_PATTERNS,
  SMALL_TALK_PATTERNS,
  SOCIAL_BEHAVIORS,
  THANKS_PATTERNS,
  confidenceBand,
  validateConfidenceThresholds,
};
