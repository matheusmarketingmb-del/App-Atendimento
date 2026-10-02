-- CreateEnum
CREATE TYPE "BotAction" AS ENUM ('RESPOND', 'ASK_CLARIFICATION', 'HANDOFF_HUMAN', 'SWITCH_BOT', 'QUERY_TOOL', 'NO_ACTION');

-- AlterTable
ALTER TABLE "Bot" ADD COLUMN     "highConfidenceThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.8,
ADD COLUMN     "lowConfidenceThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.55;

-- AlterTable
ALTER TABLE "BotObservation" ADD COLUMN     "action" "BotAction",
ADD COLUMN     "confidence" DOUBLE PRECISION,
ADD COLUMN     "errorCode" TEXT,
ADD COLUMN     "extractedEntities" JSONB,
ADD COLUMN     "mode" TEXT NOT NULL DEFAULT 'OBSERVATION',
ADD COLUMN     "provider" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'OK';

-- CreateTable
CREATE TABLE "ConversationBotState" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "activeBotId" TEXT,
    "lastIntentId" TEXT,
    "lastConfidence" DOUBLE PRECISION,
    "failedInterpretations" INTEGER NOT NULL DEFAULT 0,
    "pendingClarification" BOOLEAN NOT NULL DEFAULT false,
    "extractedEntities" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationBotState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ConversationBotState_conversationId_key" ON "ConversationBotState"("conversationId");

-- CreateIndex
CREATE INDEX "ConversationBotState_activeBotId_idx" ON "ConversationBotState"("activeBotId");

-- CreateIndex
CREATE INDEX "ConversationBotState_lastIntentId_idx" ON "ConversationBotState"("lastIntentId");

-- CreateIndex
CREATE INDEX "BotObservation_createdAt_idx" ON "BotObservation"("createdAt");

-- AddForeignKey
ALTER TABLE "ConversationBotState" ADD CONSTRAINT "ConversationBotState_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationBotState" ADD CONSTRAINT "ConversationBotState_activeBotId_fkey" FOREIGN KEY ("activeBotId") REFERENCES "Bot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationBotState" ADD CONSTRAINT "ConversationBotState_lastIntentId_fkey" FOREIGN KEY ("lastIntentId") REFERENCES "BotIntent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
