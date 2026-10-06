-- Preserve compatibility with the category visibility already present in the current app.
ALTER TABLE "Category" ADD COLUMN IF NOT EXISTS "masterOnly" BOOLEAN NOT NULL DEFAULT false;
