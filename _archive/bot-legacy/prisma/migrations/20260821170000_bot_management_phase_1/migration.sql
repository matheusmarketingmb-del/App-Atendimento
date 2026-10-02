-- CreateEnum
CREATE TYPE "BotStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED');

-- CreateEnum
CREATE TYPE "BotFallbackAction" AS ENUM ('USE_BOT_FALLBACK', 'TRANSFER_TO_CATEGORY', 'TRANSFER_TO_HUMAN');

-- CreateTable
CREATE TABLE "Bot" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "BotStatus" NOT NULL DEFAULT 'DRAFT',
    "channel" "Channel" NOT NULL,
    "initialMessage" TEXT NOT NULL,
    "outsideHoursMessage" TEXT NOT NULL,
    "fallbackMessage" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
    "defaultCategoryId" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Bot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotSchedule" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "startTime" VARCHAR(5) NOT NULL,
    "endTime" VARCHAR(5) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BotSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotIntent" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "responseMessage" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "fallbackAction" "BotFallbackAction" NOT NULL DEFAULT 'USE_BOT_FALLBACK',
    "categoryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BotIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotIntentExample" (
    "id" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BotIntentExample_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Bot_status_channel_idx" ON "Bot"("status", "channel");

-- CreateIndex
CREATE INDEX "Bot_defaultCategoryId_idx" ON "Bot"("defaultCategoryId");

-- CreateIndex
CREATE UNIQUE INDEX "BotSchedule_botId_dayOfWeek_key" ON "BotSchedule"("botId", "dayOfWeek");

-- CreateIndex
CREATE INDEX "BotSchedule_botId_idx" ON "BotSchedule"("botId");

-- CreateIndex
CREATE INDEX "BotIntent_botId_active_priority_idx" ON "BotIntent"("botId", "active", "priority");

-- CreateIndex
CREATE INDEX "BotIntent_categoryId_idx" ON "BotIntent"("categoryId");

-- CreateIndex
CREATE INDEX "BotIntentExample_intentId_idx" ON "BotIntentExample"("intentId");

-- AddForeignKey
ALTER TABLE "Bot" ADD CONSTRAINT "Bot_defaultCategoryId_fkey" FOREIGN KEY ("defaultCategoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotSchedule" ADD CONSTRAINT "BotSchedule_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotIntent" ADD CONSTRAINT "BotIntent_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotIntent" ADD CONSTRAINT "BotIntent_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotIntentExample" ADD CONSTRAINT "BotIntentExample_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "BotIntent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
