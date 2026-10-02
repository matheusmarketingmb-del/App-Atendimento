-- CreateEnum
CREATE TYPE "KnowledgeSourceType" AS ENUM ('FAQ', 'MANUAL', 'PRODUCT', 'POLICY', 'WARRANTY', 'PROCEDURE', 'OTHER');

-- AlterTable
ALTER TABLE "Bot" ADD COLUMN     "autoReplyEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "featureFlags" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "introduceWithName" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "presentationMessage" TEXT,
ADD COLUMN     "ratingEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "ratingFollowupMessage" TEXT,
ADD COLUMN     "ratingMessage" TEXT,
ADD COLUMN     "reintroduceOnNewSession" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "requestRatingComment" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "requestRatingOn" TEXT NOT NULL DEFAULT 'BOT_COMPLETED',
ADD COLUMN     "toolPermissions" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "toolsEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ConversationBotState" ADD COLUMN     "humanPausedAt" TIMESTAMP(3),
ADD COLUMN     "introducedAt" TIMESTAMP(3),
ADD COLUMN     "lastResponseHash" TEXT,
ADD COLUMN     "lastResponseRepeatCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "switchCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "switchWindowStartedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "BotVersion" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "label" TEXT,
    "description" TEXT,
    "snapshot" JSONB NOT NULL,
    "restoredFromVersion" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByUserId" TEXT,
    "createdByName" TEXT,

    CONSTRAINT "BotVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotRating" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "conversationId" TEXT,
    "channel" "Channel" NOT NULL DEFAULT 'META',
    "score" INTEGER NOT NULL,
    "comment" TEXT,
    "resolvedByBot" BOOLEAN NOT NULL DEFAULT false,
    "intentId" TEXT,
    "handoffOccurred" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BotRating_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotAgentFeedback" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "botId" TEXT,
    "userId" TEXT NOT NULL,
    "helpful" BOOLEAN NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BotAgentFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeSource" (
    "id" TEXT NOT NULL,
    "botId" TEXT,
    "title" TEXT NOT NULL,
    "type" "KnowledgeSourceType" NOT NULL,
    "source" TEXT,
    "content" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "validFrom" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotGlobalSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "automationEnabled" BOOLEAN NOT NULL DEFAULT true,
    "observationEnabled" BOOLEAN NOT NULL DEFAULT true,
    "learningEnabled" BOOLEAN NOT NULL DEFAULT true,
    "ratingsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "rankingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "minimumRatingsForRanking" INTEGER NOT NULL DEFAULT 20,
    "killSwitchActivatedAt" TIMESTAMP(3),
    "killSwitchActivatedByUserId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BotGlobalSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BotVersion_botId_createdAt_idx" ON "BotVersion"("botId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BotVersion_botId_version_key" ON "BotVersion"("botId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "BotRating_conversationId_key" ON "BotRating"("conversationId");

-- CreateIndex
CREATE INDEX "BotRating_botId_createdAt_idx" ON "BotRating"("botId", "createdAt");

-- CreateIndex
CREATE INDEX "BotRating_botId_score_idx" ON "BotRating"("botId", "score");

-- CreateIndex
CREATE INDEX "BotRating_intentId_idx" ON "BotRating"("intentId");

-- CreateIndex
CREATE INDEX "BotAgentFeedback_botId_idx" ON "BotAgentFeedback"("botId");

-- CreateIndex
CREATE UNIQUE INDEX "BotAgentFeedback_conversationId_userId_key" ON "BotAgentFeedback"("conversationId", "userId");

-- CreateIndex
CREATE INDEX "KnowledgeSource_botId_active_idx" ON "KnowledgeSource"("botId", "active");

-- CreateIndex
CREATE INDEX "KnowledgeSource_type_idx" ON "KnowledgeSource"("type");

-- AddForeignKey
ALTER TABLE "BotVersion" ADD CONSTRAINT "BotVersion_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotVersion" ADD CONSTRAINT "BotVersion_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotRating" ADD CONSTRAINT "BotRating_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotRating" ADD CONSTRAINT "BotRating_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotRating" ADD CONSTRAINT "BotRating_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "BotIntent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotAgentFeedback" ADD CONSTRAINT "BotAgentFeedback_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotAgentFeedback" ADD CONSTRAINT "BotAgentFeedback_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotAgentFeedback" ADD CONSTRAINT "BotAgentFeedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeSource" ADD CONSTRAINT "KnowledgeSource_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE SET NULL ON UPDATE CASCADE;
