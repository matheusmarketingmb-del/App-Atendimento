// Setor privado (Financeiro) — OPCIONAL. Carimba privateCategoryId em
// mensagens e eventos ANTIGOS que aconteceram enquanto a conversa estava no
// setor protegido (antes do flag existir). Reconstrói os intervalos pelo
// histórico de ConversationActivity (transferências/troca de setor/Bot,
// finalização e reabertura). Nunca apaga nem altera texto — só preenche o
// carimbo onde ele está vazio.
//
// Por padrão é SIMULAÇÃO (só mostra o que marcaria). Para gravar: --apply
// O setor precisa já estar com visibilityMode = SECTOR_PRIVATE.
//
// Uso: node scripts/backfill-private-segments.js --category=<categoryId> [--apply]
require("dotenv").config({ quiet: true });
const { PrismaClient } = require("@prisma/client");

const ENTER_ACTIONS = new Set([
  "CATEGORY_CHANGED", "CONVERSATION_TRANSFERRED", "BOT_FLOW_TRANSFERRED", "BOT_FLOW_HANDOFF", "BOT_FLOW_TRANSFERRED_TO_USER",
]);

// Setor (categoria) para onde a atividade levou a conversa; undefined = a
// atividade não muda setor.
function destinationOf(activity) {
  const details = activity.details || {};
  if (activity.action === "REOPENED_BY_CUSTOMER_MESSAGE") return null;
  if (!ENTER_ACTIONS.has(activity.action)) return undefined;
  if ("toCategoryId" in details) return details.toCategoryId || null;
  if ("categoryId" in details) return details.categoryId || null;
  return undefined;
}

function isFinalization(activity) {
  return (activity.action === "STATUS_CHANGED" && activity.details?.to === "FINALIZADO")
    || activity.action === "AUTO_FINALIZED_INACTIVITY";
}

// Intervalos [start, end) em que a conversa esteve no setor privado.
function privateIntervals(activities, sectorIds, conversation, now = new Date()) {
  const intervals = [];
  let openedAt = null;
  const close = (at) => { if (openedAt) intervals.push([openedAt, at]); openedAt = null; };
  for (const activity of activities) {
    if (isFinalization(activity)) { close(activity.createdAt); continue; }
    const destination = destinationOf(activity);
    if (destination === undefined) continue;
    const inside = Boolean(destination && sectorIds.has(destination));
    if (inside && !openedAt) openedAt = activity.createdAt;
    else if (!inside) close(activity.createdAt);
  }
  // Conversa ainda no setor e aberta: o intervalo vai até agora.
  if (openedAt && conversation.status !== "FINALIZADO" && sectorIds.has(conversation.categoryId)) close(now);
  else if (openedAt) close(conversation.finalizedAt || now);
  return intervals;
}

async function main({ prisma = new PrismaClient(), argv = process.argv, log = console.log } = {}) {
  const apply = argv.includes("--apply");
  const categoryId = (argv.find((arg) => arg.startsWith("--category=")) || "").split("=")[1];
  if (!categoryId) throw new Error("Informe --category=<id do setor protegido>.");
  const root = await prisma.category.findUnique({ where: { id: categoryId }, include: { children: { select: { id: true } } } });
  if (!root || root.parentId) throw new Error("Setor não encontrado ou é subcategoria (use o setor principal).");
  if (root.visibilityMode !== "SECTOR_PRIVATE") throw new Error(`O setor "${root.name}" ainda não está com histórico protegido (SECTOR_PRIVATE).`);
  const sectorIds = new Set([root.id, ...root.children.map(({ id }) => id)]);
  const sectorList = [...sectorIds];

  const candidates = await prisma.conversation.findMany({
    where: {
      companyId: root.companyId,
      OR: [
        { categoryId: { in: sectorList } },
        { activities: { some: { OR: sectorList.flatMap((id) => [
          { details: { path: ["toCategoryId"], equals: id } }, { details: { path: ["categoryId"], equals: id } },
        ]) } } },
      ],
    },
    select: { id: true, status: true, categoryId: true, finalizedAt: true },
  });

  let totalMessages = 0;
  let totalActivities = 0;
  for (const conversation of candidates) {
    const activities = await prisma.conversationActivity.findMany({
      where: { conversationId: conversation.id }, orderBy: { createdAt: "asc" },
      select: { action: true, details: true, createdAt: true },
    });
    const intervals = privateIntervals(activities, sectorIds, conversation);
    if (!intervals.length) continue;
    const windows = intervals.map(([start, end]) => ({ gte: start, lt: end }));
    const messageWhere = { conversationId: conversation.id, privateCategoryId: null, OR: windows.map((occurredAt) => ({ occurredAt })) };
    // O evento que ABRE o segmento já é dele; o que fecha (saída) não.
    const activityWhere = { conversationId: conversation.id, privateCategoryId: null, OR: windows.map((createdAt) => ({ createdAt })) };
    const [messages, events] = await Promise.all([
      prisma.message.count({ where: messageWhere }), prisma.conversationActivity.count({ where: activityWhere }),
    ]);
    if (!messages && !events) continue;
    log(`conversa ${conversation.id}: ${intervals.length} segmento(s), ${messages} mensagem(ns), ${events} evento(s)`);
    totalMessages += messages;
    totalActivities += events;
    if (apply) {
      await prisma.$transaction([
        prisma.message.updateMany({ where: messageWhere, data: { privateCategoryId: root.id } }),
        prisma.conversationActivity.updateMany({ where: activityWhere, data: { privateCategoryId: root.id } }),
      ]);
    }
  }
  log(`${apply ? "Carimbados" : "Seriam carimbados"}: ${totalMessages} mensagem(ns) e ${totalActivities} evento(s) do setor "${root.name}".`);
  if (!apply) log("Simulação — nada foi alterado. Use --apply para gravar.");
  log("Notas de contato antigas não são carimbadas (não têm vínculo com a conversa).");
  return { messages: totalMessages, activities: totalActivities, applied: apply };
}

if (require.main === module) {
  const prisma = new PrismaClient();
  main({ prisma }).catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
}

module.exports = { main, privateIntervals };
