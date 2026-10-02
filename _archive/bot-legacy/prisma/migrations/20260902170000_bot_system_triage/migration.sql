-- Integra o Bot de Triagem Inicial (antes hardcoded em
-- src/services/triage-bot-service.js) ao sistema de Bots.
-- Migration 100% aditiva: novas colunas com DEFAULT (nunca quebra Bots já
-- existentes), nova tabela, e um INSERT idempotente (ON CONFLICT DO NOTHING)
-- que recria o comportamento atual como o Bot de sistema "Triagem Inicial".
-- Nenhum dado existente é apagado ou alterado.

-- 1) BotType + colunas novas em "Bot" -----------------------------------
CREATE TYPE "BotType" AS ENUM ('STANDARD', 'SYSTEM_TRIAGE');

ALTER TABLE "Bot"
  ADD COLUMN "type" "BotType" NOT NULL DEFAULT 'STANDARD',
  ADD COLUMN "isSystem" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "handoffMessage" TEXT,
  ADD COLUMN "runOnNewConversation" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "runAfterReopen" BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX "Bot_type_idx" ON "Bot"("type");

-- 2) BotTriageOption (setores/opções da lista de triagem) ---------------
CREATE TABLE "BotTriageOption" (
  "id" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "categoryId" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "description" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "order" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BotTriageOption_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BotTriageOption_botId_categoryId_key" ON "BotTriageOption"("botId", "categoryId");
CREATE INDEX "BotTriageOption_botId_order_idx" ON "BotTriageOption"("botId", "order");

ALTER TABLE "BotTriageOption" ADD CONSTRAINT "BotTriageOption_botId_fkey"
  FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BotTriageOption" ADD CONSTRAINT "BotTriageOption_categoryId_fkey"
  FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 3) Seed do Bot de sistema "Triagem Inicial" ----------------------------
-- Mensagens migradas literalmente de triage-bot-service.js (welcomeText/
-- afterHoursText/routingText), com placeholders {{saudacao}},
-- {{saudacao_virgula}}, {{horario}} e {{categoria}} resolvidos em runtime
-- por triage-bot-service.js — o texto renderizado para um contato sem nome,
-- dentro do horário configurado, é idêntico ao hardcode anterior.
INSERT INTO "Bot" (
  "id", "name", "description", "status", "type", "isSystem", "channel", "channels",
  "initialMessage", "outsideHoursMessage", "fallbackMessage", "handoffMessage",
  "timezone", "runOnNewConversation", "runAfterReopen", "autoReplyEnabled",
  "createdAt", "updatedAt"
) VALUES (
  'system-triage-bot',
  'Triagem Inicial',
  'Bot do sistema: recebe a primeira mensagem do cliente, mostra o menu de setores e encaminha a conversa. Migrado do fluxo hardcoded para configuração.',
  'ACTIVE',
  'SYSTEM_TRIAGE',
  true,
  'META',
  ARRAY[]::"Channel"[],
  E'👋 {{saudacao}}! Seja bem-vindo(a) à Mibro Brasil!\n\nÉ um prazer receber você por aqui. Nosso atendimento funciona de {{horario}}.\n\nPara encaminharmos você à equipe certa, escolha abaixo o setor com o qual deseja falar.',
  E'🌙 {{saudacao}}! Agradecemos por entrar em contato com a Mibro Brasil.\n\nNo momento, nossa equipe não está online. Nosso atendimento funciona de {{horario}}.\n\nPor favor, envie uma nova mensagem dentro desse horário e teremos prazer em atender você. Até breve!',
  'Desculpe, tivemos um problema para continuar automaticamente. Já avisamos nossa equipe e alguém vai falar com você em instantes.',
  E'✅ Perfeito{{saudacao_virgula}}! Encaminhamos seu atendimento para o setor {{categoria}}. Em breve, nossa equipe continuará a conversa por aqui.',
  'America/Sao_Paulo',
  true,
  true,
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("id") DO NOTHING;

-- 4) Horário comercial (Seg-Sex 08:00-17:00), igual ao business-hours-service
-- atual — grava as 7 linhas para que o Bot de Triagem tenha o mesmo
-- resultado que isBusinessHours() sempre teve.
INSERT INTO "BotSchedule" ("id", "botId", "dayOfWeek", "enabled", "startTime", "endTime", "createdAt", "updatedAt")
VALUES
  ('system-triage-schedule-0', 'system-triage-bot', 0, false, '08:00', '17:00', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('system-triage-schedule-1', 'system-triage-bot', 1, true,  '08:00', '17:00', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('system-triage-schedule-2', 'system-triage-bot', 2, true,  '08:00', '17:00', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('system-triage-schedule-3', 'system-triage-bot', 3, true,  '08:00', '17:00', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('system-triage-schedule-4', 'system-triage-bot', 4, true,  '08:00', '17:00', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('system-triage-schedule-5', 'system-triage-bot', 5, true,  '08:00', '17:00', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('system-triage-schedule-6', 'system-triage-bot', 6, false, '08:00', '17:00', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

-- 5) Opções/setores da triagem (mesma ordem/categorias de
-- triageCategoryCodes em triage-bot-service.js, mesmos códigos usados pela
-- migration 20260812170000_bot_triage_categories).
INSERT INTO "BotTriageOption" ("id", "botId", "categoryId", "label", "enabled", "order", "createdAt", "updatedAt")
SELECT 'system-triage-option-atendimento', 'system-triage-bot', "id", 'Atendimento', true, 10, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Category" WHERE "code" = 'ATENDIMENTO'
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "BotTriageOption" ("id", "botId", "categoryId", "label", "enabled", "order", "createdAt", "updatedAt")
SELECT 'system-triage-option-suporte', 'system-triage-bot', "id", 'Suporte', true, 20, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Category" WHERE "code" = 'SUPORTE'
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "BotTriageOption" ("id", "botId", "categoryId", "label", "enabled", "order", "createdAt", "updatedAt")
SELECT 'system-triage-option-comercial', 'system-triage-bot', "id", 'Comercial', true, 30, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Category" WHERE "code" = 'COMERCIAL'
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "BotTriageOption" ("id", "botId", "categoryId", "label", "enabled", "order", "createdAt", "updatedAt")
SELECT 'system-triage-option-parcerias', 'system-triage-bot', "id", 'Parcerias', true, 40, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Category" WHERE "code" = 'PARCERIAS'
ON CONFLICT ("id") DO NOTHING;
