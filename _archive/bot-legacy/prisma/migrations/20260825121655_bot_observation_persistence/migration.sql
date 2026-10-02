-- CreateTable
CREATE TABLE "BotObservation" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "botId" TEXT,
    "botName" TEXT NOT NULL,
    "channel" "Channel" NOT NULL DEFAULT 'META',
    "withinHours" BOOLEAN NOT NULL,
    "intentId" TEXT,
    "intentName" TEXT,
    "matchedExample" TEXT,
    "categoryId" TEXT,
    "categoryName" TEXT,
    "fallbackAction" "BotFallbackAction",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BotObservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BotObservation_messageId_key" ON "BotObservation"("messageId");

-- CreateIndex
CREATE INDEX "BotObservation_conversationId_createdAt_idx" ON "BotObservation"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "BotObservation_botId_createdAt_idx" ON "BotObservation"("botId", "createdAt");

-- CreateIndex
CREATE INDEX "BotObservation_categoryId_idx" ON "BotObservation"("categoryId");

-- AddForeignKey
ALTER TABLE "BotObservation" ADD CONSTRAINT "BotObservation_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotObservation" ADD CONSTRAINT "BotObservation_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotObservation" ADD CONSTRAINT "BotObservation_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotObservation" ADD CONSTRAINT "BotObservation_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;
