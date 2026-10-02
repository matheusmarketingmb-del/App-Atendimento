-- Feriados configuráveis do Bot de Triagem. Migration aditiva; sem datas
-- pré-cadastradas para preservar exatamente o funcionamento atual.
CREATE TABLE "BotHoliday" (
  "id" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "date" VARCHAR(10) NOT NULL,
  "name" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BotHoliday_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BotHoliday_botId_date_key" ON "BotHoliday"("botId", "date");
CREATE INDEX "BotHoliday_botId_date_idx" ON "BotHoliday"("botId", "date");

ALTER TABLE "BotHoliday" ADD CONSTRAINT "BotHoliday_botId_fkey"
  FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
