// Multiempresa nos testes: empresas criadas pelo prisma/seed.js (mesmos ids
// da migration). `grantCompany` garante o acesso de forma idempotente —
// usuários de execuções anteriores do schema de teste podem existir sem ele.
const MIBRO = "cmp_mibro";
const SINCROFIT = "cmp_sincrofit";

async function grantCompany(prisma, userId, companyId = MIBRO, role = null) {
  await prisma.userCompanyAccess.upsert({
    where: { userId_companyId: { userId, companyId } },
    update: { role, active: true },
    create: { userId, companyId, role, active: true },
  });
}

module.exports = { MIBRO, SINCROFIT, grantCompany };
