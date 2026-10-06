-- Multiempresa — passo 2/2: validação + obrigatoriedade + unicidade por
-- empresa. Aborta com mensagem clara (sem alterar nada) se algum registro
-- ficou sem empresa ou se conversa e contato divergirem de empresa.
-- Todas as unicidades novas são MAIS permissivas que as antigas (acrescentam
-- companyId), portanto nunca falham com os dados existentes.
-- Rollback: DROP NOT NULL nas colunas e recriar os índices únicos antigos
-- (só possível enquanto não houver dados duplicados entre empresas).

DO $$
DECLARE
  missing TEXT := '';
  n BIGINT;
BEGIN
  SELECT count(*) INTO n FROM "ChannelAccount" WHERE "companyId" IS NULL; IF n > 0 THEN missing := missing || ' ChannelAccount=' || n; END IF;
  SELECT count(*) INTO n FROM "Contact"        WHERE "companyId" IS NULL; IF n > 0 THEN missing := missing || ' Contact=' || n; END IF;
  SELECT count(*) INTO n FROM "Conversation"   WHERE "companyId" IS NULL; IF n > 0 THEN missing := missing || ' Conversation=' || n; END IF;
  SELECT count(*) INTO n FROM "Category"       WHERE "companyId" IS NULL; IF n > 0 THEN missing := missing || ' Category=' || n; END IF;
  SELECT count(*) INTO n FROM "Bot"            WHERE "companyId" IS NULL; IF n > 0 THEN missing := missing || ' Bot=' || n; END IF;
  SELECT count(*) INTO n FROM "Campaign"       WHERE "companyId" IS NULL; IF n > 0 THEN missing := missing || ' Campaign=' || n; END IF;
  SELECT count(*) INTO n FROM "OptOut"         WHERE "companyId" IS NULL; IF n > 0 THEN missing := missing || ' OptOut=' || n; END IF;
  SELECT count(*) INTO n FROM "QuickReply"     WHERE "scope" = 'COMPANY' AND "companyId" IS NULL; IF n > 0 THEN missing := missing || ' QuickReply(COMPANY)=' || n; END IF;
  SELECT count(*) INTO n FROM "Conversation" c JOIN "Contact" k ON k."id" = c."contactId" WHERE c."companyId" <> k."companyId";
  IF n > 0 THEN missing := missing || ' Conversation<>Contact=' || n; END IF;
  IF missing <> '' THEN
    RAISE EXCEPTION 'Multiempresa: registros sem empresa ou inconsistentes:%', missing;
  END IF;
END $$;

ALTER TABLE "ChannelAccount" ALTER COLUMN "companyId" SET NOT NULL;
ALTER TABLE "Contact"        ALTER COLUMN "companyId" SET NOT NULL;
ALTER TABLE "Conversation"   ALTER COLUMN "companyId" SET NOT NULL;
ALTER TABLE "Category"       ALTER COLUMN "companyId" SET NOT NULL;
ALTER TABLE "Bot"            ALTER COLUMN "companyId" SET NOT NULL;
ALTER TABLE "Campaign"       ALTER COLUMN "companyId" SET NOT NULL;
ALTER TABLE "OptOut"         ALTER COLUMN "companyId" SET NOT NULL;

-- Mesmo telefone pode ser cliente das duas empresas (históricos separados).
DROP INDEX "Contact_channel_externalId_key";
CREATE UNIQUE INDEX "Contact_companyId_channel_externalId_key" ON "Contact"("companyId", "channel", "externalId");

-- "Suporte" pode existir na Mibro e na Sincrofit.
DROP INDEX "Category_code_key";
CREATE UNIQUE INDEX "Category_companyId_code_key" ON "Category"("companyId", "code");

-- Opt-out por empresa.
DROP INDEX "OptOut_phone_key";
CREATE UNIQUE INDEX "OptOut_companyId_phone_key" ON "OptOut"("companyId", "phone");

-- Biblioteca de respostas do Bot por empresa (chave global com companyId
-- nulo tem unicidade garantida em bot-response-library-service.js).
DROP INDEX "BotResponse_key_key";
CREATE UNIQUE INDEX "BotResponse_companyId_key_key" ON "BotResponse"("companyId", "key");
