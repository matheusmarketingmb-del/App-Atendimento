// Multiempresa — relatório de consistência (somente leitura). Rodar antes e
// depois das migrations 20261006* para comparar contagens e confirmar que
// nada ficou sem empresa ou com empresa divergente.
//
// Uso: node scripts/multiempresa-report.js [--json]
require("dotenv").config({ quiet: true });
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();
const TABLES = ["User", "Contact", "Conversation", "Message", "Category", "Bot", "BotFlow", "QuickReply", "Campaign",
  "CampaignContact", "ChannelAccount", "OptOut", "BotResponse", "AuditLog", "ConversationActivity", "ContactNote"];
const COMPANY_TABLES = ["Contact", "Conversation", "Category", "Bot", "Campaign", "ChannelAccount", "OptOut", "QuickReply", "BotResponse"];

const one = async (sql) => Number((await prisma.$queryRawUnsafe(sql))[0]?.n || 0);
const columnExists = async (table, column) => (await prisma.$queryRawUnsafe(
  "SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2", table, column,
)).length > 0;

(async () => {
  const report = { generatedAt: new Date().toISOString(), counts: {}, byCompany: {}, problems: [] };
  for (const table of TABLES) report.counts[table] = await one(`SELECT count(*)::int AS n FROM "${table}"`);
  const multiCompany = await columnExists("Conversation", "companyId");
  report.migrated = multiCompany;
  if (multiCompany) {
    for (const table of COMPANY_TABLES) {
      const rows = await prisma.$queryRawUnsafe(`SELECT COALESCE(c.slug, '(sem empresa)') AS company, count(*)::int AS n FROM "${table}" t LEFT JOIN "Company" c ON c.id = t."companyId" GROUP BY 1 ORDER BY 1`);
      report.byCompany[table] = Object.fromEntries(rows.map((row) => [row.company, Number(row.n)]));
    }
    const checks = [
      ["Contato sem empresa", `SELECT count(*)::int AS n FROM "Contact" WHERE "companyId" IS NULL`],
      ["Conversa sem empresa", `SELECT count(*)::int AS n FROM "Conversation" WHERE "companyId" IS NULL`],
      ["Conversa x contato com empresas diferentes", `SELECT count(*)::int AS n FROM "Conversation" v JOIN "Contact" k ON k.id = v."contactId" WHERE v."companyId" <> k."companyId"`],
      ["Conversa x número de outra empresa", `SELECT count(*)::int AS n FROM "Conversation" v JOIN "ChannelAccount" a ON a.id = v."channelAccountId" WHERE v."companyId" <> a."companyId"`],
      ["Conversa WhatsApp sem número", `SELECT count(*)::int AS n FROM "Conversation" WHERE channel = 'META' AND "channelAccountId" IS NULL`],
      ["Conversa em setor de outra empresa", `SELECT count(*)::int AS n FROM "Conversation" v JOIN "Category" g ON g.id = v."categoryId" WHERE v."companyId" <> g."companyId"`],
      ["Subsetor em empresa diferente da principal", `SELECT count(*)::int AS n FROM "Category" s JOIN "Category" p ON p.id = s."parentId" WHERE s."companyId" <> p."companyId"`],
      ["Campanha com número de outra empresa", `SELECT count(*)::int AS n FROM "Campaign" m JOIN "ChannelAccount" a ON a.id = m."channelAccountId" WHERE m."companyId" <> a."companyId"`],
      ["Resposta rápida COMPANY sem empresa", `SELECT count(*)::int AS n FROM "QuickReply" WHERE scope = 'COMPANY' AND "companyId" IS NULL`],
      ["Resposta rápida GLOBAL com empresa", `SELECT count(*)::int AS n FROM "QuickReply" WHERE scope = 'GLOBAL' AND "companyId" IS NOT NULL`],
      ["Usuário ativo (não Master) sem empresa", `SELECT count(*)::int AS n FROM "User" u WHERE u.active AND u.role NOT IN ('ADMIN','BOT') AND NOT EXISTS (SELECT 1 FROM "UserCompanyAccess" x WHERE x."userId" = u.id AND x.active)`],
      ["Mensagem WhatsApp sem número (histórico — informativo)", `SELECT count(*)::int AS n FROM "Message" WHERE channel = 'META' AND "channelAccountId" IS NULL`],
    ];
    for (const [label, sql] of checks) {
      const n = await one(sql);
      report.problems.push({ check: label, count: n, ok: n === 0 || label.includes("informativo") });
    }
  }
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Relatório multiempresa — ${report.generatedAt}${multiCompany ? "" : " (migrations multiempresa ainda NÃO aplicadas)"}`);
    console.log("\nContagens:");
    for (const [table, n] of Object.entries(report.counts)) console.log(`  ${table.padEnd(22)} ${n}`);
    if (multiCompany) {
      console.log("\nPor empresa:");
      for (const [table, rows] of Object.entries(report.byCompany)) console.log(`  ${table.padEnd(22)} ${Object.entries(rows).map(([company, n]) => `${company}=${n}`).join("  ")}`);
      console.log("\nVerificações:");
      for (const item of report.problems) console.log(`  ${item.ok ? "ok  " : "ERRO"} ${item.check}: ${item.count}`);
    }
  }
  await prisma.$disconnect();
  process.exitCode = report.problems.some((item) => !item.ok) ? 1 : 0;
})().catch(async (error) => { console.error(error.message); await prisma.$disconnect(); process.exit(1); });
