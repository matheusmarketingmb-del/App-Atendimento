-- Respostas Rápidas podem atender mais de uma categoria.
-- Migração aditiva: preserva categoryId e replica os vínculos atuais.
CREATE TABLE "QuickReplyCategory" (
  "quickReplyId" TEXT NOT NULL,
  "categoryId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "QuickReplyCategory_pkey" PRIMARY KEY ("quickReplyId", "categoryId")
);
CREATE INDEX "QuickReplyCategory_categoryId_idx" ON "QuickReplyCategory"("categoryId");
ALTER TABLE "QuickReplyCategory" ADD CONSTRAINT "QuickReplyCategory_quickReplyId_fkey"
  FOREIGN KEY ("quickReplyId") REFERENCES "QuickReply"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QuickReplyCategory" ADD CONSTRAINT "QuickReplyCategory_categoryId_fkey"
  FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;
INSERT INTO "QuickReplyCategory" ("quickReplyId", "categoryId")
SELECT "id", "categoryId" FROM "QuickReply" WHERE "categoryId" IS NOT NULL
ON CONFLICT DO NOTHING;
