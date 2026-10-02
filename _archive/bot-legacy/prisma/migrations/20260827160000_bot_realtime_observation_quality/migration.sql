-- AlterTable
ALTER TABLE "BotObservation" ADD COLUMN     "localConfidence" DOUBLE PRECISION,
ADD COLUMN     "finalConfidence" DOUBLE PRECISION,
ADD COLUMN     "aiModel" TEXT,
ADD COLUMN     "durationMs" INTEGER,
ADD COLUMN     "handoffReason" TEXT,
ADD COLUMN     "actualAgentReplyText" TEXT,
ADD COLUMN     "actualAgentUserId" TEXT,
ADD COLUMN     "actualAgentRepliedAt" TIMESTAMP(3),
ADD COLUMN     "customerReactionSignal" TEXT,
ADD COLUMN     "customerReactionAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "BotAiUsage" ADD COLUMN     "model" TEXT;

-- AlterTable
ALTER TABLE "BotGlobalSettings" ADD COLUMN     "observeActiveConversations" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "BotIntent" ADD COLUMN     "autoReplyEnabled" BOOLEAN,
ADD COLUMN     "autoReplyMinConfidence" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "ConversationBotState" ADD COLUMN     "observationPausedAt" TIMESTAMP(3);

-- AddForeignKey
ALTER TABLE "BotObservation" ADD CONSTRAINT "BotObservation_actualAgentUserId_fkey" FOREIGN KEY ("actualAgentUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
