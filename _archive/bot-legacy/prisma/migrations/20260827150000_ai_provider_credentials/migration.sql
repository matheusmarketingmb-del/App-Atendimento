-- CreateTable
CREATE TABLE "AiProviderCredential" (
    "provider" TEXT NOT NULL,
    "encryptedKey" BYTEA NOT NULL,
    "encryptionIv" BYTEA NOT NULL,
    "encryptionAuthTag" BYTEA NOT NULL,
    "lastFour" TEXT NOT NULL,
    "defaultModel" TEXT,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiProviderCredential_pkey" PRIMARY KEY ("provider")
);

-- AddForeignKey
ALTER TABLE "AiProviderCredential" ADD CONSTRAINT "AiProviderCredential_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
