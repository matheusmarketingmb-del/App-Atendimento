-- AlterEnum
ALTER TYPE "BotLearningSuggestionType" ADD VALUE 'QUICK_REPLY';

-- AlterTable
ALTER TABLE "BotHandoffContext" ADD COLUMN     "currentStepName" TEXT,
ADD COLUMN     "flowResolutionStatus" TEXT,
ADD COLUMN     "handoffReason" TEXT,
ADD COLUMN     "product" TEXT;

-- AlterTable
ALTER TABLE "BotObservation" ADD COLUMN     "suggestedResponseText" TEXT,
ADD COLUMN     "topicSwitchDetected" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ConversationBotState" ADD COLUMN     "awaitingRatingScore" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "contextEntities" JSONB,
ADD COLUMN     "flowStack" JSONB,
ADD COLUMN     "ratingRequestedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "BotSuggestionFeedback" (
    "id" TEXT NOT NULL,
    "observationId" TEXT NOT NULL,
    "botId" TEXT,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "helpful" BOOLEAN NOT NULL,
    "finalResponseText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BotSuggestionFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BotSuggestionFeedback_botId_createdAt_idx" ON "BotSuggestionFeedback"("botId", "createdAt");

-- CreateIndex
CREATE INDEX "BotSuggestionFeedback_conversationId_idx" ON "BotSuggestionFeedback"("conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "BotSuggestionFeedback_observationId_userId_key" ON "BotSuggestionFeedback"("observationId", "userId");

-- AddForeignKey
ALTER TABLE "BotSuggestionFeedback" ADD CONSTRAINT "BotSuggestionFeedback_observationId_fkey" FOREIGN KEY ("observationId") REFERENCES "BotObservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotSuggestionFeedback" ADD CONSTRAINT "BotSuggestionFeedback_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotSuggestionFeedback" ADD CONSTRAINT "BotSuggestionFeedback_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotSuggestionFeedback" ADD CONSTRAINT "BotSuggestionFeedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
