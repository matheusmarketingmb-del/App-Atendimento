-- Preserva a unicidade das globais e permite o mesmo atalho pessoal entre
-- atendentes diferentes. Troca somente índices, sem alterar/apagar registros.
BEGIN;
CREATE UNIQUE INDEX "QuickReply_global_active_shortcut_key"
  ON "QuickReply"("shortcut") WHERE "archivedAt" IS NULL AND "scope" = 'GLOBAL';
CREATE UNIQUE INDEX "QuickReply_personal_active_shortcut_key"
  ON "QuickReply"("ownerUserId", "shortcut") WHERE "archivedAt" IS NULL AND "scope" = 'PERSONAL';
DROP INDEX "QuickReply_active_shortcut_key";
COMMIT;
