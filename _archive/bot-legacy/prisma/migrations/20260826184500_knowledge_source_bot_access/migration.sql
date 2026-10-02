CREATE TABLE "KnowledgeSourceBot" (
    "knowledgeSourceId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeSourceBot_pkey" PRIMARY KEY ("knowledgeSourceId","botId")
);

CREATE INDEX "KnowledgeSourceBot_botId_idx" ON "KnowledgeSourceBot"("botId");

ALTER TABLE "KnowledgeSourceBot"
ADD CONSTRAINT "KnowledgeSourceBot_knowledgeSourceId_fkey"
FOREIGN KEY ("knowledgeSourceId") REFERENCES "KnowledgeSource"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "KnowledgeSourceBot"
ADD CONSTRAINT "KnowledgeSourceBot_botId_fkey"
FOREIGN KEY ("botId") REFERENCES "Bot"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "KnowledgeSourceBot" ("knowledgeSourceId", "botId")
SELECT "id", "botId"
FROM "KnowledgeSource"
WHERE "botId" IS NOT NULL
ON CONFLICT DO NOTHING;
