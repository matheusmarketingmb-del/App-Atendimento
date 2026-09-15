-- Módulo Social (Instagram/Facebook nativos): 3 flags de resposta automática,
-- todas OFF por padrão. Aditivo, sem impacto em dados existentes; não afeta
-- WhatsApp/Meta (newChannelsEnabled continua o kill-switch geral daquele
-- grupo, estas 3 são específicas de auto-reply social e ficam desligadas
-- mesmo com newChannelsEnabled=true, exigindo ativação explícita).
ALTER TABLE "IntegrationGlobalSettings" ADD COLUMN "socialAutoReplyEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "IntegrationGlobalSettings" ADD COLUMN "socialCommentAutoReplyEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "IntegrationGlobalSettings" ADD COLUMN "socialPrivateAutoReplyEnabled" BOOLEAN NOT NULL DEFAULT false;
