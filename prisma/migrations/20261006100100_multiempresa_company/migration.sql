-- Multiempresa — passo 1/2: estrutura ADITIVA + vínculo dos dados atuais à
-- Mibro Brasil. Nenhum DELETE, nenhum ID existente alterado, nenhuma coluna
-- existente removida. Sincrofit é criada sem nenhum dado vinculado.
-- Rollback deste passo: DROP das colunas "companyId"/"companyFilterPreference"
-- e das tabelas "Company"/"UserCompanyAccess" (ver docs/MULTIEMPRESA_AUDITORIA.md).

-- 1. Empresas -----------------------------------------------------------------
CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "primaryColor" TEXT NOT NULL,
    "logoUrl" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Company_slug_key" ON "Company"("slug");

INSERT INTO "Company" ("id", "name", "slug", "displayName", "primaryColor", "active", "displayOrder", "updatedAt") VALUES
  ('cmp_mibro', 'Mibro Brasil', 'mibro', 'MIBRO', '#FF6633', true, 0, CURRENT_TIMESTAMP),
  ('cmp_sincrofit', 'Sincrofit', 'sincrofit', 'SINCROFIT', '#24A8B4', true, 1, CURRENT_TIMESTAMP);

-- 2. Acesso usuário x empresa (role por empresa) ------------------------------
CREATE TABLE "UserCompanyAccess" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "role" "UserRole",
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "UserCompanyAccess_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "UserCompanyAccess_userId_companyId_key" ON "UserCompanyAccess"("userId", "companyId");
CREATE INDEX "UserCompanyAccess_companyId_active_idx" ON "UserCompanyAccess"("companyId", "active");
ALTER TABLE "UserCompanyAccess" ADD CONSTRAINT "UserCompanyAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserCompanyAccess" ADD CONSTRAINT "UserCompanyAccess_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Todo usuário existente trabalha hoje na Mibro: mesmo role que já tem,
-- mesma situação ativo/inativo. Ninguém recebe acesso à Sincrofit aqui.
INSERT INTO "UserCompanyAccess" ("id", "userId", "companyId", "role", "active", "updatedAt")
SELECT 'uca_' || "id", "id", 'cmp_mibro', "role", true, CURRENT_TIMESTAMP FROM "User";

ALTER TABLE "User" ADD COLUMN "companyFilterPreference" TEXT;

-- 3. Colunas companyId (nullable neste passo) ---------------------------------
ALTER TABLE "ChannelAccount"       ADD COLUMN "companyId" TEXT;
ALTER TABLE "Contact"              ADD COLUMN "companyId" TEXT;
ALTER TABLE "Conversation"         ADD COLUMN "companyId" TEXT;
ALTER TABLE "Category"             ADD COLUMN "companyId" TEXT;
ALTER TABLE "Bot"                  ADD COLUMN "companyId" TEXT;
ALTER TABLE "Campaign"             ADD COLUMN "companyId" TEXT;
ALTER TABLE "QuickReply"           ADD COLUMN "companyId" TEXT;
ALTER TABLE "BotResponse"          ADD COLUMN "companyId" TEXT;
ALTER TABLE "OptOut"               ADD COLUMN "companyId" TEXT;
ALTER TABLE "AuditLog"             ADD COLUMN "companyId" TEXT;
ALTER TABLE "ConversationSettings" ADD COLUMN "companyId" TEXT;

-- 4. Vínculo dos dados atuais à Mibro Brasil ----------------------------------
UPDATE "ChannelAccount" SET "companyId" = 'cmp_mibro' WHERE "companyId" IS NULL;
UPDATE "Contact"        SET "companyId" = 'cmp_mibro' WHERE "companyId" IS NULL;
UPDATE "Conversation"   SET "companyId" = 'cmp_mibro' WHERE "companyId" IS NULL;
UPDATE "Category"       SET "companyId" = 'cmp_mibro' WHERE "companyId" IS NULL;
UPDATE "Bot"            SET "companyId" = 'cmp_mibro' WHERE "companyId" IS NULL;
UPDATE "Campaign"       SET "companyId" = 'cmp_mibro' WHERE "companyId" IS NULL;
UPDATE "BotResponse"    SET "companyId" = 'cmp_mibro' WHERE "companyId" IS NULL;
UPDATE "OptOut"         SET "companyId" = 'cmp_mibro' WHERE "companyId" IS NULL;
-- Respostas rápidas GLOBAL existentes têm texto da Mibro: viram COMPANY Mibro
-- (decisão de 2026-10-06). O Master pode promover a GLOBAL depois.
-- PERSONAL continuam sem empresa (valem em todas as empresas do dono).
UPDATE "QuickReply" SET "scope" = 'COMPANY', "companyId" = 'cmp_mibro'
WHERE "scope" = 'GLOBAL' AND "companyId" IS NULL;
-- AuditLog histórico e a linha "singleton" de ConversationSettings ficam com
-- companyId nulo de propósito (global).

-- 5. WhatsApp Mibro como ChannelAccount ---------------------------------------
-- Até aqui o número vinha só do .env. A conta com config.legacyEnv = true
-- continua usando exatamente PHONE_NUMBER_ID/WHATSAPP_BUSINESS_ACCOUNT_ID/
-- WHATSAPP_TOKEN do .env — nenhuma mudança operacional no número atual.
INSERT INTO "ChannelAccount" ("id", "companyId", "channel", "name", "status", "enabled", "config", "updatedAt")
SELECT 'chacc_mibro_whatsapp', 'cmp_mibro', 'META', 'Mibro Brasil WhatsApp', 'CONNECTED', true,
       '{"legacyEnv": true}'::jsonb, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "ChannelAccount" WHERE "channel" = 'META' AND "name" = 'Mibro Brasil WhatsApp');

-- Conversas WhatsApp existentes passam a apontar para essa conta. Mensagens
-- antigas NÃO são atualizadas (tabela grande; empresa já é derivável pela
-- conversa) — só as novas gravam channelAccountId.
UPDATE "Conversation" SET "channelAccountId" = (
  SELECT "id" FROM "ChannelAccount" WHERE "channel" = 'META' AND "name" = 'Mibro Brasil WhatsApp' LIMIT 1
)
WHERE "channel" = 'META' AND "channelAccountId" IS NULL;

-- 6. Chaves estrangeiras e índices não-únicos ----------------------------------
ALTER TABLE "ChannelAccount"       ADD CONSTRAINT "ChannelAccount_companyId_fkey"       FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Contact"              ADD CONSTRAINT "Contact_companyId_fkey"              FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Conversation"         ADD CONSTRAINT "Conversation_companyId_fkey"         FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Category"             ADD CONSTRAINT "Category_companyId_fkey"             FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Bot"                  ADD CONSTRAINT "Bot_companyId_fkey"                  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Campaign"             ADD CONSTRAINT "Campaign_companyId_fkey"             FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "QuickReply"           ADD CONSTRAINT "QuickReply_companyId_fkey"           FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BotResponse"          ADD CONSTRAINT "BotResponse_companyId_fkey"          FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OptOut"               ADD CONSTRAINT "OptOut_companyId_fkey"               FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AuditLog"             ADD CONSTRAINT "AuditLog_companyId_fkey"             FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ConversationSettings" ADD CONSTRAINT "ConversationSettings_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "ChannelAccount_companyId_channel_idx"                ON "ChannelAccount"("companyId", "channel");
CREATE INDEX "Contact_companyId_phone_idx"                         ON "Contact"("companyId", "phone");
CREATE INDEX "Conversation_companyId_status_lastMessageAt_idx"     ON "Conversation"("companyId", "status", "lastMessageAt");
CREATE INDEX "Conversation_companyId_assignedUserId_idx"           ON "Conversation"("companyId", "assignedUserId");
CREATE INDEX "Conversation_companyId_categoryId_lastMessageAt_idx" ON "Conversation"("companyId", "categoryId", "lastMessageAt");
CREATE INDEX "Category_companyId_parentId_displayOrder_idx"        ON "Category"("companyId", "parentId", "displayOrder");
CREATE INDEX "Bot_companyId_status_idx"                            ON "Bot"("companyId", "status");
CREATE INDEX "Campaign_companyId_status_idx"                       ON "Campaign"("companyId", "status");
CREATE INDEX "QuickReply_companyId_scope_active_idx"               ON "QuickReply"("companyId", "scope", "active");
CREATE INDEX "AuditLog_companyId_createdAt_idx"                    ON "AuditLog"("companyId", "createdAt");
CREATE UNIQUE INDEX "ConversationSettings_companyId_key"           ON "ConversationSettings"("companyId");
