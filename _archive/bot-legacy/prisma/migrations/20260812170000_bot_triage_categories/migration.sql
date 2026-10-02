INSERT INTO "Category" ("id", "code", "name", "color", "active", "displayOrder", "createdAt", "updatedAt")
VALUES
  ('triage-atendimento', 'ATENDIMENTO', 'Atendimento', '#0f766e', true, 10, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('triage-parcerias', 'PARCERIAS', 'Parcerias', '#7c3aed', true, 40, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE SET
  "name" = EXCLUDED."name",
  "color" = EXCLUDED."color",
  "active" = true,
  "displayOrder" = EXCLUDED."displayOrder",
  "updatedAt" = CURRENT_TIMESTAMP;

UPDATE "Category" SET "displayOrder" = 20, "updatedAt" = CURRENT_TIMESTAMP WHERE "code" = 'SUPORTE';
UPDATE "Category" SET "displayOrder" = 30, "updatedAt" = CURRENT_TIMESTAMP WHERE "code" = 'COMERCIAL';
