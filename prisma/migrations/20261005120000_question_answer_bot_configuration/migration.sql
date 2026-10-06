-- Additive only: no historical Bot, Conversation or Message rows are removed.
ALTER TABLE "Bot" ADD COLUMN IF NOT EXISTS "holidayMessage" TEXT;
