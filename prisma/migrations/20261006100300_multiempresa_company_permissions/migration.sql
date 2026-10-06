-- Multiempresa — permissões individuais por empresa (aditiva; nulo = usa as
-- permissões do cadastro do usuário, comportamento anterior).
ALTER TABLE "UserCompanyAccess" ADD COLUMN "permissions" JSONB;
