// Multiempresa — OPCIONAL. Grava em mensagens antigas do WhatsApp o número
// (channelAccountId) da própria conversa. A empresa delas já é conhecida
// pela conversa; isto só completa o histórico para relatórios por número.
// Por padrão é SIMULAÇÃO (só conta). Para gravar: --apply
// Lotes pequenos para não travar a tabela de mensagens em produção.
//
// Uso: node scripts/multiempresa-backfill-messages.js [--apply] [--batch=5000]
require("dotenv").config({ quiet: true });
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();
const apply = process.argv.includes("--apply");
const batch = Math.min(Math.max(Number((process.argv.find((arg) => arg.startsWith("--batch=")) || "").split("=")[1]) || 5000, 100), 50000);

(async () => {
  const pending = Number((await prisma.$queryRawUnsafe(`
    SELECT count(*)::int AS n FROM "Message" m JOIN "Conversation" c ON c.id = m."conversationId"
    WHERE m.channel = 'META' AND m."channelAccountId" IS NULL AND c."channelAccountId" IS NOT NULL`))[0].n);
  console.log(`${pending} mensagem(ns) WhatsApp sem número, com conversa vinculada a um número.`);
  if (!apply) {
    console.log("Simulação — nada foi alterado. Use --apply para gravar.");
    await prisma.$disconnect();
    return;
  }
  let updated = 0;
  for (;;) {
    const count = await prisma.$executeRawUnsafe(`
      UPDATE "Message" m SET "channelAccountId" = c."channelAccountId"
      FROM "Conversation" c
      WHERE m.id IN (
        SELECT m2.id FROM "Message" m2 JOIN "Conversation" c2 ON c2.id = m2."conversationId"
        WHERE m2.channel = 'META' AND m2."channelAccountId" IS NULL AND c2."channelAccountId" IS NOT NULL
        LIMIT ${batch}
      ) AND c.id = m."conversationId"`);
    updated += count;
    if (count) console.log(`  +${count} (total ${updated})`);
    if (count < batch) break;
  }
  console.log(`Concluído: ${updated} mensagem(ns) atualizada(s). Nenhuma mensagem foi apagada nem teve conteúdo alterado.`);
  await prisma.$disconnect();
})().catch(async (error) => { console.error(error.message); await prisma.$disconnect(); process.exit(1); });
