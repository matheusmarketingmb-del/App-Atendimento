-- Financeiro protegido (setor privado) + atendente fixo por cliente.
-- Migration 100% aditiva: só ADD COLUMN com default/nulo, índices e FKs.
-- Nenhuma coluna removida, nenhum dado existente reescrito. Até um Master
-- marcar um setor como SECTOR_PRIVATE, o comportamento é idêntico ao atual.
-- Mensagens antigas do Financeiro NÃO são carimbadas aqui (a migration não
-- sabe qual setor é o Financeiro) — ver scripts/backfill-private-segments.js
-- (dry-run por padrão).
-- CreateEnum
CREATE TYPE "CategoryVisibilityMode" AS ENUM ('NORMAL', 'SECTOR_PRIVATE');

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "preferredAssigneeEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "preferredAssigneeId" TEXT,
ADD COLUMN     "preferredAssigneeSetAt" TIMESTAMP(3),
ADD COLUMN     "preferredAssigneeSetById" TEXT;

-- AlterTable
ALTER TABLE "ContactNote" ADD COLUMN     "privateCategoryId" TEXT;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "privateCategoryId" TEXT;

-- AlterTable
ALTER TABLE "ConversationActivity" ADD COLUMN     "privateCategoryId" TEXT;

-- AlterTable
ALTER TABLE "Category" ADD COLUMN     "visibilityMode" "CategoryVisibilityMode" NOT NULL DEFAULT 'NORMAL';

-- AlterTable
ALTER TABLE "ConversationSettings" ADD COLUMN     "preferredAssigneeRoutingMessage" TEXT NOT NULL DEFAULT 'Olá! Identificamos seu atendimento e já estamos redirecionando você para o seu atendente responsável.';

-- CreateIndex
CREATE INDEX "Contact_companyId_preferredAssigneeId_idx" ON "Contact"("companyId", "preferredAssigneeId");

-- CreateIndex
CREATE INDEX "ContactNote_privateCategoryId_idx" ON "ContactNote"("privateCategoryId");

-- CreateIndex
CREATE INDEX "Message_conversationId_privateCategoryId_idx" ON "Message"("conversationId", "privateCategoryId");

-- CreateIndex
CREATE INDEX "ConversationActivity_conversationId_privateCategoryId_idx" ON "ConversationActivity"("conversationId", "privateCategoryId");

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_preferredAssigneeId_fkey" FOREIGN KEY ("preferredAssigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_preferredAssigneeSetById_fkey" FOREIGN KEY ("preferredAssigneeSetById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactNote" ADD CONSTRAINT "ContactNote_privateCategoryId_fkey" FOREIGN KEY ("privateCategoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_privateCategoryId_fkey" FOREIGN KEY ("privateCategoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationActivity" ADD CONSTRAINT "ConversationActivity_privateCategoryId_fkey" FOREIGN KEY ("privateCategoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

