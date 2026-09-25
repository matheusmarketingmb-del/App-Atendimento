-- CreateEnum
CREATE TYPE "BotExecutionMode" AS ENUM ('LEGACY', 'FLOW_BUILDER');

-- CreateEnum
CREATE TYPE "BotFlowStatus" AS ENUM ('DRAFT', 'ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "BotFlowExecutionStatus" AS ENUM ('RUNNING', 'WAITING_CUSTOMER', 'WAITING_TIMER', 'HANDED_OFF', 'COMPLETED', 'FAILED');

-- AlterTable
ALTER TABLE "Bot" ADD COLUMN     "executionMode" "BotExecutionMode" NOT NULL DEFAULT 'LEGACY';

-- CreateTable
CREATE TABLE "BotFlow" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "BotFlowStatus" NOT NULL DEFAULT 'DRAFT',
    "draftGraph" JSONB NOT NULL,
    "draftUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activeVersionId" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdByName" TEXT,
    "updatedByUserId" TEXT,
    "updatedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BotFlow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotFlowVersion" (
    "id" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "graph" JSONB NOT NULL,
    "label" TEXT,
    "publishedByUserId" TEXT,
    "publishedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BotFlowVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotFlowExecution" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "currentNodeKey" TEXT,
    "context" JSONB NOT NULL DEFAULT '{}',
    "status" "BotFlowExecutionStatus" NOT NULL DEFAULT 'RUNNING',
    "resumeAt" TIMESTAMP(3),
    "lastMessageId" TEXT,
    "step" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "BotFlowExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotFlowExecutionLog" (
    "id" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "nodeKey" TEXT NOT NULL,
    "nodeType" TEXT NOT NULL,
    "input" JSONB,
    "output" JSONB,
    "branch" TEXT,
    "result" TEXT NOT NULL,
    "error" TEXT,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BotFlowExecutionLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BotFlow_activeVersionId_key" ON "BotFlow"("activeVersionId");

-- CreateIndex
CREATE INDEX "BotFlow_botId_archivedAt_idx" ON "BotFlow"("botId", "archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "BotFlowVersion_flowId_version_key" ON "BotFlowVersion"("flowId", "version");

-- CreateIndex
CREATE INDEX "BotFlowExecution_conversationId_status_idx" ON "BotFlowExecution"("conversationId", "status");

-- CreateIndex
CREATE INDEX "BotFlowExecution_status_resumeAt_idx" ON "BotFlowExecution"("status", "resumeAt");

-- CreateIndex
CREATE INDEX "BotFlowExecution_flowId_idx" ON "BotFlowExecution"("flowId");

-- CreateIndex
CREATE INDEX "BotFlowExecutionLog_executionId_createdAt_idx" ON "BotFlowExecutionLog"("executionId", "createdAt");

-- AddForeignKey
ALTER TABLE "BotFlow" ADD CONSTRAINT "BotFlow_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotFlow" ADD CONSTRAINT "BotFlow_activeVersionId_fkey" FOREIGN KEY ("activeVersionId") REFERENCES "BotFlowVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotFlowVersion" ADD CONSTRAINT "BotFlowVersion_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "BotFlow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotFlowExecution" ADD CONSTRAINT "BotFlowExecution_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotFlowExecution" ADD CONSTRAINT "BotFlowExecution_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "BotFlow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotFlowExecution" ADD CONSTRAINT "BotFlowExecution_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "BotFlowVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotFlowExecutionLog" ADD CONSTRAINT "BotFlowExecutionLog_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "BotFlowExecution"("id") ON DELETE CASCADE ON UPDATE CASCADE;
