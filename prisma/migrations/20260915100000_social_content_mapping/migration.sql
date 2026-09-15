-- Mapeamento manual post/reel -> produto (item 10/11 do plano Social).
-- Aditiva, tabela nova, sem impacto em dados existentes.
CREATE TABLE "SocialContentMapping" (
    "id" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "externalPostId" TEXT NOT NULL,
    "title" TEXT,
    "product" TEXT,
    "permalink" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialContentMapping_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SocialContentMapping_channel_externalPostId_key" ON "SocialContentMapping"("channel", "externalPostId");
CREATE INDEX "SocialContentMapping_channel_active_idx" ON "SocialContentMapping"("channel", "active");

ALTER TABLE "SocialContentMapping" ADD CONSTRAINT "SocialContentMapping_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
