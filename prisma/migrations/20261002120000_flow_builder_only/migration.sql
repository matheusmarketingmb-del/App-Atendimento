-- Flow Builder como único modelo de Bot (2026-10): aditiva, nada é removido.
-- ARCHIVED_LEGACY marca Bots antigos sem fluxo visual (ver migration seguinte);
-- BotResponse = biblioteca "Respostas do Bot"; BotWebhookEndpoint = endpoints
-- pré-cadastrados do nó Webhook/API. executionMode passa a ser deprecated.

-- AlterEnum
ALTER TYPE "BotStatus" ADD VALUE 'ARCHIVED_LEGACY';

-- AlterTable
ALTER TABLE "Bot" ALTER COLUMN "executionMode" SET DEFAULT 'FLOW_BUILDER';

-- CreateTable
CREATE TABLE "BotResponse" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'GERAL',
    "text" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdByUserId" TEXT,
    "createdByName" TEXT,
    "updatedByUserId" TEXT,
    "updatedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BotResponse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotWebhookEndpoint" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'POST',
    "timeoutMs" INTEGER NOT NULL DEFAULT 5000,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "encryptedHeaders" BYTEA,
    "encryptionIv" BYTEA,
    "encryptionAuthTag" BYTEA,
    "headerKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedByUserId" TEXT,
    "updatedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BotWebhookEndpoint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BotResponse_key_key" ON "BotResponse"("key");

-- CreateIndex
CREATE INDEX "BotResponse_category_active_idx" ON "BotResponse"("category", "active");

-- CreateIndex
CREATE UNIQUE INDEX "BotWebhookEndpoint_key_key" ON "BotWebhookEndpoint"("key");

