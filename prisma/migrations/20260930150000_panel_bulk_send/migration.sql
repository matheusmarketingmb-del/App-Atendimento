-- Envio em massa pelo painel "Nova conversa": reaproveita Campaign/
-- CampaignContact. Migration puramente aditiva (nenhum dado alterado/removido).

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN "origin" TEXT,
ADD COLUMN "idempotencyKey" TEXT;

-- AlterTable
ALTER TABLE "CampaignContact" ADD COLUMN "templateName" TEXT,
ADD COLUMN "templateLanguage" TEXT,
ADD COLUMN "templateCategory" TEXT,
ADD COLUMN "variableValues" JSONB;

-- CreateIndex
CREATE UNIQUE INDEX "Campaign_idempotencyKey_key" ON "Campaign"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Campaign_origin_createdAt_idx" ON "Campaign"("origin", "createdAt");
