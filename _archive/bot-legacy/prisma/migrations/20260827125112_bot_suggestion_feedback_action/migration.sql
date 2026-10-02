-- AlterTable
ALTER TABLE "BotSuggestionFeedback" ADD COLUMN     "action" TEXT,
ALTER COLUMN "helpful" DROP NOT NULL;
