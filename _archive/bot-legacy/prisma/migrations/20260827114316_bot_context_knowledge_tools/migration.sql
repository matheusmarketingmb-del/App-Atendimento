-- AlterEnum
ALTER TYPE "BotLearningSuggestionType" ADD VALUE 'FLOW_REVIEW';

-- AlterTable
ALTER TABLE "BotObservation" ADD COLUMN     "calledExternalAi" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "flowResolutionStatus" TEXT,
ADD COLUMN     "flowStepId" TEXT,
ADD COLUMN     "knowledgeSourceId" TEXT,
ADD COLUMN     "knowledgeSourceTitle" TEXT;

-- AlterTable
ALTER TABLE "ConversationBotState" ADD COLUMN     "lastBotAction" TEXT,
ADD COLUMN     "pendingQuestion" TEXT;

-- CreateTable
CREATE TABLE "BotAiUsage" (
    "id" TEXT NOT NULL,
    "botId" TEXT,
    "provider" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BotAiUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BotAiUsage_botId_createdAt_idx" ON "BotAiUsage"("botId", "createdAt");

-- CreateIndex
CREATE INDEX "BotAiUsage_provider_createdAt_idx" ON "BotAiUsage"("provider", "createdAt");
