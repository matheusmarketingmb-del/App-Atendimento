-- Chat interno com grupos (aditiva: nenhum dado existente é alterado ou removido).

-- Novo tipo de chat: grupo criado por usuário.
ALTER TYPE "InternalChatType" ADD VALUE 'GROUP';

-- Papel do membro dentro do chat (só tem efeito em grupos).
CREATE TYPE "InternalChatMemberRole" AS ENUM ('MEMBER', 'ADMIN');

ALTER TABLE "InternalChatMember"
  ADD COLUMN "role" "InternalChatMemberRole" NOT NULL DEFAULT 'MEMBER';

-- Criador do grupo e data de encerramento (grupo encerrado = somente leitura).
ALTER TABLE "InternalChat"
  ADD COLUMN "createdByUserId" TEXT,
  ADD COLUMN "archivedAt" TIMESTAMP(3);

CREATE INDEX "InternalChat_createdByUserId_idx" ON "InternalChat"("createdByUserId");

ALTER TABLE "InternalChat"
  ADD CONSTRAINT "InternalChat_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
