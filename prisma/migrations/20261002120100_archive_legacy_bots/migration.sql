-- Migração de dados para o Flow Builder como único modelo de Bot (2026-10).
-- Separada da migration anterior porque o Postgres não permite usar um valor
-- de enum recém-adicionado (ARCHIVED_LEGACY) na mesma transação.
--
-- Nada é apagado. O status/auto-resposta anteriores ficam registrados em
-- featureFlags (legacyStatusBeforeArchive / legacyAutoReplyBeforeMigration)
-- para permitir reverter manualmente.

-- 1) Bots comuns (STANDARD) sem nenhum fluxo visual = sistema antigo
--    (intenções/IA): viram ARCHIVED_LEGACY e nunca mais executam.
UPDATE "Bot"
SET "featureFlags" = COALESCE("featureFlags", '{}'::jsonb) || jsonb_build_object(
      'legacyStatusBeforeArchive', "status"::text,
      'legacyAutoReplyBeforeMigration', "autoReplyEnabled",
      'legacyArchivedAt', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
    "status" = 'ARCHIVED_LEGACY',
    "autoReplyEnabled" = false,
    "updatedAt" = NOW()
WHERE "type" = 'STANDARD'
  AND "archivedAt" IS NULL
  AND "status" <> 'ARCHIVED_LEGACY'
  AND "executionMode" = 'LEGACY'
  AND "id" NOT IN ('system-triage-bot', 'mibro-assistant-observer')
  AND "name" NOT IN ('Triagem Inicial', 'Assistente Mibro Brasil');

-- 2) Segurança: antes desta migração só Bots em executionMode FLOW_BUILDER
--    executavam fluxos. Agora todo Bot ativo executa o fluxo padrão — então
--    um Bot que estava em LEGACY (inclusive o Bot de Triagem, convertido em
--    fluxo por flow-builder-migration-service.js) nunca pode começar a
--    responder clientes sozinho: a auto-resposta é desligada e o Master liga
--    de novo depois de validar o fluxo no simulador.
UPDATE "Bot"
SET "featureFlags" = COALESCE("featureFlags", '{}'::jsonb) || jsonb_build_object(
      'legacyAutoReplyBeforeMigration', "autoReplyEnabled"),
    "autoReplyEnabled" = false,
    "updatedAt" = NOW()
WHERE "executionMode" = 'LEGACY'
  AND "status" <> 'ARCHIVED_LEGACY'
  AND "id" NOT IN ('system-triage-bot', 'mibro-assistant-observer')
  AND "name" NOT IN ('Triagem Inicial', 'Assistente Mibro Brasil')
  AND "autoReplyEnabled" = true;
