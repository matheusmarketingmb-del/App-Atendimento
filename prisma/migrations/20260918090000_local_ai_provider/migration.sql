-- IA local (Qwen via Ollama) — configuração global do provider + log de
-- modo shadow/observação. Puramente aditivo: nenhuma tabela/coluna existente
-- é alterada, nenhum Bot é tocado por esta migration.
CREATE TABLE "LocalAiProviderSettings" (
  "id" TEXT NOT NULL DEFAULT 'singleton',
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "baseUrl" TEXT,
  "defaultModel" TEXT NOT NULL DEFAULT 'qwen3:14b',
  "timeoutMs" INTEGER NOT NULL DEFAULT 45000,
  "maxConcurrency" INTEGER NOT NULL DEFAULT 1,
  "updatedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LocalAiProviderSettings_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "LocalAiProviderSettings"
  ADD CONSTRAINT "LocalAiProviderSettings_updatedByUserId_fkey"
  FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "BotAiShadowLog" (
  "id" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "messageId" TEXT,
  "botId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "model" TEXT,
  "aiMode" TEXT NOT NULL,
  "action" TEXT,
  "intent" TEXT,
  "issue" TEXT,
  "confidence" DOUBLE PRECISION,
  "entities" JSONB,
  "knowledgeUsed" JSONB,
  "missingInformation" JSONB,
  "responseText" TEXT,
  "handoffCategory" TEXT,
  "handoffReason" TEXT,
  "summary" TEXT,
  "autoReplyEligible" BOOLEAN NOT NULL DEFAULT false,
  "autoReplyBlockedReason" TEXT,
  "latencyMs" INTEGER,
  "status" TEXT NOT NULL,
  "errorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BotAiShadowLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BotAiShadowLog_botId_createdAt_idx" ON "BotAiShadowLog"("botId", "createdAt");
CREATE INDEX "BotAiShadowLog_conversationId_createdAt_idx" ON "BotAiShadowLog"("conversationId", "createdAt");
