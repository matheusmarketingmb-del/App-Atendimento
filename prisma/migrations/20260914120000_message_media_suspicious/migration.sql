-- Auditoria de segurança (envio excessivo de mensagens / arquivos
-- maliciosos): marca mídia recebida por canais sem allowlist estrito de
-- MIME (chat interno + canais além do WhatsApp/Meta) que passou pela
-- checagem de conteúdo (file-risk-service.js) mas ficou marcada como
-- suspeita (não bloqueada — só merece atenção antes de confiar no
-- conteúdo). Aditivo, default seguro (false), nunca preenchido para mídia
-- do WhatsApp/Meta (essa continua com allowlist estrito por assinatura
-- binária, nunca fica "suspeita").
ALTER TABLE "Message" ADD COLUMN "mediaSuspicious" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Message" ADD COLUMN "mediaSuspiciousReason" TEXT;
