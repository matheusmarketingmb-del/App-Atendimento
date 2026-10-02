-- Personalidade configurável por Bot ("Bot -> Personalidade").
-- Migration 100% aditiva: nova tabela + 2 novos enums, nenhuma coluna
-- existente é alterada/removida, nenhum dado existente é tocado. Um Bot sem
-- linha em "BotPersonality" continua funcionando normalmente — o backend usa
-- o preset padrão da Mibro Brasil (DEFAULT_PERSONALITY em
-- bot-personality-constants.js), nunca falha por ausência do registro.

CREATE TYPE "BotPersonalityPreset" AS ENUM ('TRIAGEM', 'SUPORTE', 'COMERCIAL', 'POS_VENDA', 'PERSONALIZADO');
CREATE TYPE "BotResponseLength" AS ENUM ('SHORT', 'MEDIUM', 'LONG');

CREATE TABLE "BotPersonality" (
  "id" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "preset" "BotPersonalityPreset" NOT NULL DEFAULT 'PERSONALIZADO',
  "assistantName" TEXT,
  "roleDescription" TEXT,
  "tone" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "responseStyle" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "mandatoryBehaviors" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "forbiddenBehaviors" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "additionalInstructions" TEXT,
  "responseLength" "BotResponseLength" NOT NULL DEFAULT 'MEDIUM',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BotPersonality_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BotPersonality_botId_key" ON "BotPersonality"("botId");
CREATE INDEX "BotPersonality_preset_idx" ON "BotPersonality"("preset");

ALTER TABLE "BotPersonality" ADD CONSTRAINT "BotPersonality_botId_fkey"
  FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
