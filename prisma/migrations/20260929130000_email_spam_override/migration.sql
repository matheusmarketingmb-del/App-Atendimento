ALTER TABLE "Conversation" ADD COLUMN "emailMailboxOverride" TEXT;

CREATE INDEX "Conversation_channel_emailMailboxOverride_idx"
ON "Conversation"("channel", "emailMailboxOverride");
