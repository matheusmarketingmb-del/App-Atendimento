-- CreateEnum
CREATE TYPE "BotSocialBehavior" AS ENUM ('GREETING', 'THANKS', 'GOODBYE', 'SMALL_TALK', 'CONFIRMATION', 'NEGATION', 'HUMAN_REQUEST', 'BUSINESS_INTENT');

-- CreateEnum
CREATE TYPE "BotObservationFeedback" AS ENUM ('UNREVIEWED', 'CORRECT', 'INCORRECT');

-- CreateEnum
CREATE TYPE "BotLearningSuggestionType" AS ENUM ('INTENT_EXAMPLE', 'NEW_INTENT', 'RESPONSE', 'CLARIFICATION', 'KNOWLEDGE', 'ENTITY_PATTERN');

-- CreateEnum
CREATE TYPE "BotLearningSuggestionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EDITED');

-- AlterTable
ALTER TABLE "BotObservation" ADD COLUMN     "feedback" "BotObservationFeedback" NOT NULL DEFAULT 'UNREVIEWED',
ADD COLUMN     "feedbackAt" TIMESTAMP(3),
ADD COLUMN     "feedbackByUserId" TEXT,
ADD COLUMN     "feedbackIntentId" TEXT,
ADD COLUMN     "socialBehavior" "BotSocialBehavior";

-- CreateTable
CREATE TABLE "ConversationLearningState" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "lastAnalyzedAt" TIMESTAMP(3),
    "messageCountAtAnalysis" INTEGER NOT NULL DEFAULT 0,
    "suggestionCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversationLearningState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotLearningSuggestion" (
    "id" TEXT NOT NULL,
    "botId" TEXT,
    "conversationId" TEXT,
    "intentId" TEXT,
    "type" "BotLearningSuggestionType" NOT NULL,
    "status" "BotLearningSuggestionStatus" NOT NULL DEFAULT 'PENDING',
    "title" TEXT NOT NULL,
    "suggestedContent" TEXT NOT NULL,
    "sourceCount" INTEGER NOT NULL DEFAULT 1,
    "confidence" DOUBLE PRECISION,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "reviewedAt" TIMESTAMP(3),
    "reviewedByUserId" TEXT,

    CONSTRAINT "BotLearningSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ConversationLearningState_conversationId_key" ON "ConversationLearningState"("conversationId");

-- CreateIndex
CREATE INDEX "BotLearningSuggestion_status_createdAt_idx" ON "BotLearningSuggestion"("status", "createdAt");

-- CreateIndex
CREATE INDEX "BotLearningSuggestion_botId_status_idx" ON "BotLearningSuggestion"("botId", "status");

-- CreateIndex
CREATE INDEX "BotLearningSuggestion_type_status_idx" ON "BotLearningSuggestion"("type", "status");

-- CreateIndex
CREATE INDEX "BotObservation_feedback_idx" ON "BotObservation"("feedback");

-- AddForeignKey
ALTER TABLE "BotObservation" ADD CONSTRAINT "BotObservation_feedbackIntentId_fkey" FOREIGN KEY ("feedbackIntentId") REFERENCES "BotIntent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotObservation" ADD CONSTRAINT "BotObservation_feedbackByUserId_fkey" FOREIGN KEY ("feedbackByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationLearningState" ADD CONSTRAINT "ConversationLearningState_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotLearningSuggestion" ADD CONSTRAINT "BotLearningSuggestion_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotLearningSuggestion" ADD CONSTRAINT "BotLearningSuggestion_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotLearningSuggestion" ADD CONSTRAINT "BotLearningSuggestion_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "BotIntent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotLearningSuggestion" ADD CONSTRAINT "BotLearningSuggestion_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
