-- CreateEnum
CREATE TYPE "ToolRiskLevel" AS ENUM ('READ_ONLY', 'SAFE_ACTION', 'SENSITIVE_ACTION');

-- AlterEnum
ALTER TYPE "KnowledgeSourceType" ADD VALUE 'GENERAL';

-- AlterTable
ALTER TABLE "BotGlobalSettings" ADD COLUMN     "intentLibraryEnabled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "BotIntent" ADD COLUMN     "globalIntentId" TEXT,
ADD COLUMN     "toolName" TEXT;

-- AlterTable
ALTER TABLE "BotObservation" ADD COLUMN     "toolName" TEXT,
ADD COLUMN     "toolResult" JSONB;

-- AlterTable
ALTER TABLE "KnowledgeSource" ADD COLUMN     "category" TEXT,
ADD COLUMN     "globalIntentId" TEXT,
ADD COLUMN     "intentId" TEXT,
ADD COLUMN     "product" TEXT,
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "GlobalIntent" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GlobalIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GlobalIntentExample" (
    "id" TEXT NOT NULL,
    "globalIntentId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GlobalIntentExample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotHandoffContext" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "botId" TEXT,
    "botName" TEXT,
    "intentId" TEXT,
    "intentName" TEXT,
    "confidence" DOUBLE PRECISION,
    "category" TEXT,
    "extractedEntities" JSONB,
    "lastRelevantInfo" TEXT,
    "questionsAsked" JSONB,
    "solutionsTried" JSONB,
    "summary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resumedAt" TIMESTAMP(3),
    "resumedByUserId" TEXT,

    CONSTRAINT "BotHandoffContext_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GlobalIntent_active_idx" ON "GlobalIntent"("active");

-- CreateIndex
CREATE INDEX "GlobalIntentExample_globalIntentId_idx" ON "GlobalIntentExample"("globalIntentId");

-- CreateIndex
CREATE INDEX "BotHandoffContext_conversationId_createdAt_idx" ON "BotHandoffContext"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "BotHandoffContext_botId_createdAt_idx" ON "BotHandoffContext"("botId", "createdAt");

-- CreateIndex
CREATE INDEX "BotIntent_globalIntentId_idx" ON "BotIntent"("globalIntentId");

-- CreateIndex
CREATE INDEX "KnowledgeSource_globalIntentId_idx" ON "KnowledgeSource"("globalIntentId");

-- CreateIndex
CREATE INDEX "KnowledgeSource_intentId_idx" ON "KnowledgeSource"("intentId");

-- CreateIndex
CREATE INDEX "KnowledgeSource_category_idx" ON "KnowledgeSource"("category");

-- CreateIndex
CREATE INDEX "KnowledgeSource_product_idx" ON "KnowledgeSource"("product");

-- AddForeignKey
ALTER TABLE "BotIntent" ADD CONSTRAINT "BotIntent_globalIntentId_fkey" FOREIGN KEY ("globalIntentId") REFERENCES "GlobalIntent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GlobalIntentExample" ADD CONSTRAINT "GlobalIntentExample_globalIntentId_fkey" FOREIGN KEY ("globalIntentId") REFERENCES "GlobalIntent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeSource" ADD CONSTRAINT "KnowledgeSource_globalIntentId_fkey" FOREIGN KEY ("globalIntentId") REFERENCES "GlobalIntent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeSource" ADD CONSTRAINT "KnowledgeSource_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "BotIntent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotHandoffContext" ADD CONSTRAINT "BotHandoffContext_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotHandoffContext" ADD CONSTRAINT "BotHandoffContext_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotHandoffContext" ADD CONSTRAINT "BotHandoffContext_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "BotIntent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotHandoffContext" ADD CONSTRAINT "BotHandoffContext_resumedByUserId_fkey" FOREIGN KEY ("resumedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- DataMigration: Biblioteca Global de Intenções (item 1) — preserva dados
-- existentes. Toda BotIntent que ainda não tem globalIntentId vira sua
-- própria GlobalIntent (1:1), copiando os exemplos, e é associada ao Bot
-- de origem. Nenhum Bot perde intenções existentes; nada no pipeline de
-- interpretação/decisão/resposta muda de comportamento (continua lendo
-- BotIntent/BotIntentExample normalmente).
DO $$
DECLARE
  r RECORD;
  new_id TEXT;
BEGIN
  FOR r IN SELECT * FROM "BotIntent" WHERE "globalIntentId" IS NULL LOOP
    new_id := md5(random()::text || clock_timestamp()::text || r.id);

    INSERT INTO "GlobalIntent" ("id", "name", "description", "active", "createdAt", "updatedAt")
    VALUES (new_id, r.name, r.description, r.active, now(), now());

    INSERT INTO "GlobalIntentExample" ("id", "globalIntentId", "text", "createdAt")
    SELECT md5(random()::text || clock_timestamp()::text || e.id), new_id, e.text, e."createdAt"
    FROM "BotIntentExample" e
    WHERE e."intentId" = r.id;

    UPDATE "BotIntent" SET "globalIntentId" = new_id WHERE "id" = r.id;
  END LOOP;
END $$;
