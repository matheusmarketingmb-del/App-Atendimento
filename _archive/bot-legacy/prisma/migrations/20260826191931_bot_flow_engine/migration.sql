-- CreateEnum
CREATE TYPE "BotFlowStepAction" AS ENUM ('ASK_QUESTION', 'USE_KNOWLEDGE', 'QUERY_TOOL', 'RESPOND', 'RESOLVED', 'HANDOFF_HUMAN', 'GOTO_STEP');

-- CreateEnum
CREATE TYPE "FlowResolutionStatus" AS ENUM ('IN_PROGRESS', 'RESOLVED', 'HANDED_OFF', 'ABANDONED');

-- AlterTable
ALTER TABLE "ConversationBotState" ADD COLUMN     "activeFlowIntentId" TEXT,
ADD COLUMN     "currentFlowStepId" TEXT,
ADD COLUMN     "flowAskedQuestions" JSONB,
ADD COLUMN     "flowAttemptedSolutions" JSONB,
ADD COLUMN     "flowCollectedEntities" JSONB,
ADD COLUMN     "flowFailedSteps" JSONB,
ADD COLUMN     "flowResolutionStatus" "FlowResolutionStatus",
ADD COLUMN     "flowStepAttempts" JSONB;

-- CreateTable
CREATE TABLE "BotFlowStep" (
    "id" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "action" "BotFlowStepAction" NOT NULL,
    "question" TEXT,
    "entityKey" TEXT,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "knowledgeSourceId" TEXT,
    "toolName" TEXT,
    "responseMessage" TEXT,
    "nextStepId" TEXT,
    "onSuccessStepId" TEXT,
    "onFailureStepId" TEXT,
    "gotoStepId" TEXT,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BotFlowStep_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BotFlowStep_intentId_active_idx" ON "BotFlowStep"("intentId", "active");

-- CreateIndex
CREATE INDEX "BotFlowStep_knowledgeSourceId_idx" ON "BotFlowStep"("knowledgeSourceId");

-- CreateIndex
CREATE UNIQUE INDEX "BotFlowStep_intentId_order_key" ON "BotFlowStep"("intentId", "order");

-- CreateIndex
CREATE INDEX "ConversationBotState_activeFlowIntentId_idx" ON "ConversationBotState"("activeFlowIntentId");

-- AddForeignKey
ALTER TABLE "BotFlowStep" ADD CONSTRAINT "BotFlowStep_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "BotIntent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotFlowStep" ADD CONSTRAINT "BotFlowStep_knowledgeSourceId_fkey" FOREIGN KEY ("knowledgeSourceId") REFERENCES "KnowledgeSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationBotState" ADD CONSTRAINT "ConversationBotState_activeFlowIntentId_fkey" FOREIGN KEY ("activeFlowIntentId") REFERENCES "BotIntent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
