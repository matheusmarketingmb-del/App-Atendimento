CREATE TABLE "ChatFeatureSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "values" JSONB NOT NULL DEFAULT '{}',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChatFeatureSettings_pkey" PRIMARY KEY ("id")
);
