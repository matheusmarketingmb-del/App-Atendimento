-- Equipes de supervisão (Supervisor -> Atendentes, definidas pelo Master) e
-- períodos de responsabilidade por conversa. Migration puramente aditiva:
-- nenhuma tabela/coluna existente é alterada ou apagada. O histórico antigo é
-- reconstruído por script separado (scripts/backfill-assignment-periods.js),
-- com modo simulação antes de gravar.

-- CreateTable
CREATE TABLE "SupervisorTeamMember" (
    "supervisorId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupervisorTeamMember_pkey" PRIMARY KEY ("supervisorId","memberId")
);

-- CreateTable
CREATE TABLE "ConversationAssignmentPeriod" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "startReason" TEXT NOT NULL,
    "endReason" TEXT,
    "transferredById" TEXT,
    "source" TEXT NOT NULL DEFAULT 'LIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationAssignmentPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupervisorTeamMember_memberId_idx" ON "SupervisorTeamMember"("memberId");

-- CreateIndex
CREATE INDEX "ConversationAssignmentPeriod_conversationId_startedAt_idx" ON "ConversationAssignmentPeriod"("conversationId", "startedAt");

-- CreateIndex
CREATE INDEX "ConversationAssignmentPeriod_userId_startedAt_idx" ON "ConversationAssignmentPeriod"("userId", "startedAt");

-- CreateIndex
CREATE INDEX "ConversationAssignmentPeriod_conversationId_endedAt_idx" ON "ConversationAssignmentPeriod"("conversationId", "endedAt");

-- AddForeignKey
ALTER TABLE "SupervisorTeamMember" ADD CONSTRAINT "SupervisorTeamMember_supervisorId_fkey" FOREIGN KEY ("supervisorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupervisorTeamMember" ADD CONSTRAINT "SupervisorTeamMember_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupervisorTeamMember" ADD CONSTRAINT "SupervisorTeamMember_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationAssignmentPeriod" ADD CONSTRAINT "ConversationAssignmentPeriod_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationAssignmentPeriod" ADD CONSTRAINT "ConversationAssignmentPeriod_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationAssignmentPeriod" ADD CONSTRAINT "ConversationAssignmentPeriod_transferredById_fkey" FOREIGN KEY ("transferredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

