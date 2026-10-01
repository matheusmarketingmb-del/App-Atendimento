-- Somente colunas novas; não move nem apaga conversas/mensagens antigas.
ALTER TABLE "Contact" ADD COLUMN "whatsappInboxId" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "whatsappSendAccountId" TEXT;
CREATE UNIQUE INDEX "Contact_whatsappInboxId_key" ON "Contact"("whatsappInboxId");
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_whatsappInboxId_fkey" FOREIGN KEY ("whatsappInboxId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
