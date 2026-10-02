const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const categories = [
  ["ATENDIMENTO", "Atendimento", "#0f766e"],
  ["SUPORTE", "Suporte", "#2563eb"],
  ["COMERCIAL", "Comercial", "#059669"],
  ["PARCERIAS", "Parcerias", "#7c3aed"],
  ["ATACADO", "Atacado", "#7c3aed"],
  ["GARANTIA", "Garantia", "#dc2626"], ["PEDIDOS", "Pedidos", "#d97706"],
  ["TROCAS_DEVOLUCOES", "Trocas e devoluções", "#db2777"], ["OUTROS", "Outros", "#6b7280"],
];
// Bot de Triagem Inicial (item "Integrar o Bot de Triagem ao sistema de
// Bots"): mesmos valores da migration prisma/migrations/20260902170000_bot_system_triage.
// Duplicado aqui porque `npm test` roda via `prisma db push` (não aplica
// migrations, só sincroniza o schema) — sem isso, o schema de teste teria as
// colunas/tabelas novas mas nenhum Bot SYSTEM_TRIAGE, e handleIncomingTriage
// ficaria em "estado seguro" (sem bot) em vez de testar o fluxo real.
const triageBotId = "system-triage-bot";
const triageSchedules = [
  [0, false], [1, true], [2, true], [3, true], [4, true], [5, true], [6, false],
].map(([dayOfWeek, enabled]) => ({ dayOfWeek, enabled, startTime: "08:00", endTime: "17:00" }));
const triageOptions = [
  ["ATENDIMENTO", "Atendimento", 10],
  ["SUPORTE", "Suporte", 20],
  ["COMERCIAL", "Comercial", 30],
  ["PARCERIAS", "Parcerias", 40],
];

async function seedTriageBot(client = prisma) {
  const bot = await client.bot.upsert({
    where: { id: triageBotId },
    update: {},
    create: {
      id: triageBotId,
      name: "Triagem Inicial",
      description: "Bot do sistema: recebe a primeira mensagem do cliente, mostra o menu de setores e encaminha a conversa. Migrado do fluxo hardcoded para configuração.",
      status: "ACTIVE",
      type: "SYSTEM_TRIAGE",
      isSystem: true,
      channel: "META",
      initialMessage: "👋 {{saudacao}}! Seja bem-vindo(a) à Mibro Brasil!\n\nÉ um prazer receber você por aqui. Nosso atendimento funciona de {{horario}}.\n\nPara encaminharmos você à equipe certa, escolha abaixo o setor com o qual deseja falar.",
      outsideHoursMessage: "🌙 {{saudacao}}! Agradecemos por entrar em contato com a Mibro Brasil.\n\nNo momento, nossa equipe não está online. Nosso atendimento funciona de {{horario}}.\n\nPor favor, envie uma nova mensagem dentro desse horário e teremos prazer em atender você. Até breve!",
      fallbackMessage: "Desculpe, tivemos um problema para continuar automaticamente. Já avisamos nossa equipe e alguém vai falar com você em instantes.",
      handoffMessage: "✅ Perfeito{{saudacao_virgula}}! Encaminhamos seu atendimento para o setor {{categoria}}. Em breve, nossa equipe continuará a conversa por aqui.",
      timezone: "America/Sao_Paulo",
      runOnNewConversation: true,
      runAfterReopen: true,
      autoReplyEnabled: true,
    },
  });

  for (const schedule of triageSchedules) {
    await client.botSchedule.upsert({
      where: { botId_dayOfWeek: { botId: bot.id, dayOfWeek: schedule.dayOfWeek } },
      update: {}, create: { ...schedule, botId: bot.id },
    });
  }

  for (const [code, label, order] of triageOptions) {
    const category = await client.category.findUnique({ where: { code } });
    if (!category) continue;
    await client.botTriageOption.upsert({
      where: { botId_categoryId: { botId: bot.id, categoryId: category.id } },
      update: {}, create: { botId: bot.id, categoryId: category.id, label, order, enabled: true },
    });
  }
  return bot;
}

async function main() {
  for (const [index, [code, name, color]] of categories.entries()) {
    const data = { code, name, color, displayOrder: (index + 1) * 10 };
    await prisma.category.upsert({ where: { code }, update: data, create: data });
  }
  await seedTriageBot();
}
module.exports = { main, seedTriageBot };

// Só roda sozinho quando chamado como script (`node prisma/seed.js` /
// `npm run db:seed` / `db:seed` do run-tests.js) — quando importado por um
// teste (ex.: test/triage-bot.test.js recriando o Bot de sistema depois de
// um `bot.deleteMany()` sem filtro de outro arquivo de teste), só expõe as
// funções, sem abrir uma segunda conexão nem desconectar o Prisma do módulo
// de quem importou.
if (require.main === module) {
  main().then(() => console.log("Categorias iniciais cadastradas."))
    .catch((error) => { console.error(error); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
}
