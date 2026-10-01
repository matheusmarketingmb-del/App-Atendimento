-- Envio de áudio + respostas rápidas pessoais de áudio. Totalmente aditivo:
-- respostas existentes continuam GLOBAL/TEXT (defaults), nenhuma coluna
-- existente é alterada. O áudio fica no storage de mídia já existente
-- (media-storage-service.js) — aqui só a referência e os metadados.
CREATE TYPE "QuickReplyScope" AS ENUM ('GLOBAL', 'PERSONAL');
CREATE TYPE "QuickReplyContentType" AS ENUM ('TEXT', 'AUDIO');

ALTER TABLE "Message" ADD COLUMN "mediaDurationMs" INTEGER;

ALTER TABLE "QuickReply" ADD COLUMN "scope" "QuickReplyScope" NOT NULL DEFAULT 'GLOBAL';
ALTER TABLE "QuickReply" ADD COLUMN "contentType" "QuickReplyContentType" NOT NULL DEFAULT 'TEXT';
ALTER TABLE "QuickReply" ADD COLUMN "ownerUserId" TEXT;
ALTER TABLE "QuickReply" ADD COLUMN "mediaStorageKey" TEXT;
ALTER TABLE "QuickReply" ADD COLUMN "mediaMimeType" TEXT;
ALTER TABLE "QuickReply" ADD COLUMN "mediaFileName" TEXT;
ALTER TABLE "QuickReply" ADD COLUMN "mediaSize" INTEGER;
ALTER TABLE "QuickReply" ADD COLUMN "mediaDurationMs" INTEGER;

CREATE INDEX "QuickReply_scope_ownerUserId_idx" ON "QuickReply"("scope", "ownerUserId");

ALTER TABLE "QuickReply" ADD CONSTRAINT "QuickReply_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
