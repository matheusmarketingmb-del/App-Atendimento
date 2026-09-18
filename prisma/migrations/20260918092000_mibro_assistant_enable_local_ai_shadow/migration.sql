-- Liga a IA local (LOCAL_QWEN) no Assistente Mibro Brasil em MODO SHADOW:
-- useAi=true (a IA participa: interpreta, consulta Knowledge, gera decisão
-- e o texto que enviaria) mas autoReplyEnabled continua false (a IA nunca
-- pode enviar nada ao cliente ainda) — useAi e autoReplyEnabled são
-- controles independentes de propósito (ver bot-ai-gate-service.js).
-- requiresAi=true + aiOfflineBehavior=NO_AUTO_REPLY: se o Qwen local ficar
-- OFFLINE/DEGRADED, o Bot nunca cai para Gemini/OpenAI/Anthropic — só deixa
-- de gerar a sugestão em modo shadow, sem qualquer efeito no cliente (que já
-- não recebia resposta automática deste Bot).
UPDATE "Bot"
SET "featureFlags" = COALESCE("featureFlags", '{}'::jsonb) || '{
  "useAi": true,
  "aiProvider": "LOCAL_QWEN",
  "aiModel": "qwen3:14b",
  "aiMode": "PRIMARY",
  "requiresAi": true,
  "aiOfflineBehavior": "NO_AUTO_REPLY"
}'::jsonb,
"updatedAt" = NOW()
WHERE "id" = 'mibro-assistant-observer';
