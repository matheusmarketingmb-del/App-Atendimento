-- Controle de custos da Meta — migration 100% aditiva: só tabelas e um enum
-- novos. Nenhuma coluna existente é alterada; nada é reescrito.
--
-- Rollback (manual, se necessário — apaga só os dados de custo):
--   DROP TABLE "MetaMessageCharge";
--   DROP TABLE "MetaPricing";
--   DROP TABLE "MetaCostBudget";
--   DROP TYPE "MetaPricingCategory";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261007140000_meta_cost_control';
-- e reverter o commit (o webhook de status volta a ignorar `pricing`).
-- CreateEnum
CREATE TYPE "MetaPricingCategory" AS ENUM ('SERVICE', 'MARKETING', 'UTILITY', 'AUTHENTICATION');

-- CreateTable
CREATE TABLE "MetaMessageCharge" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "channelAccountId" TEXT,
    "messageId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "messageType" TEXT NOT NULL,
    "templateName" TEXT,
    "templateCategory" TEXT,
    "category" "MetaPricingCategory" NOT NULL,
    "pricingCategory" TEXT,
    "pricingModel" TEXT,
    "pricingType" TEXT,
    "billable" BOOLEAN,
    "country" TEXT NOT NULL DEFAULT 'BR',
    "sentAt" TIMESTAMP(3) NOT NULL,
    "deliveredAt" TIMESTAMP(3),
    "estimatedCost" DECIMAL(12,6),
    "currency" TEXT NOT NULL DEFAULT 'BRL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetaMessageCharge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetaPricing" (
    "id" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "category" "MetaPricingCategory" NOT NULL,
    "price" DECIMAL(12,6) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BRL',
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MetaPricing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetaCostBudget" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "monthlyBudget" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BRL',
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MetaCostBudget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MetaMessageCharge_messageId_key" ON "MetaMessageCharge"("messageId");

-- CreateIndex
CREATE INDEX "MetaMessageCharge_companyId_sentAt_idx" ON "MetaMessageCharge"("companyId", "sentAt");

-- CreateIndex
CREATE INDEX "MetaMessageCharge_channelAccountId_sentAt_idx" ON "MetaMessageCharge"("channelAccountId", "sentAt");

-- CreateIndex
CREATE INDEX "MetaMessageCharge_category_sentAt_idx" ON "MetaMessageCharge"("category", "sentAt");

-- CreateIndex
CREATE INDEX "MetaPricing_country_category_effectiveFrom_idx" ON "MetaPricing"("country", "category", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "MetaCostBudget_companyId_key" ON "MetaCostBudget"("companyId");

-- AddForeignKey
ALTER TABLE "MetaMessageCharge" ADD CONSTRAINT "MetaMessageCharge_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetaMessageCharge" ADD CONSTRAINT "MetaMessageCharge_channelAccountId_fkey" FOREIGN KEY ("channelAccountId") REFERENCES "ChannelAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetaMessageCharge" ADD CONSTRAINT "MetaMessageCharge_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetaCostBudget" ADD CONSTRAINT "MetaCostBudget_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

