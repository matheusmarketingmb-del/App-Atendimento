const companyService = require("../services/company-service");
const audit = require("../services/audit-service");

// Empresas visíveis para o usuário logado (filtro "Todas | Mibro | …"),
// com o cargo dele em cada uma e a preferência salva. Nunca lista empresa
// sem acesso — "Todas" só aparece no front quando há mais de uma.
async function accessPayload(user) {
  const access = await companyService.companyAccess(user);
  return {
    companies: access.map(({ company, role }) => ({ ...company, role })),
    preference: await companyService.getCompanyFilterPreference(user),
    isGlobalMaster: companyService.isGlobalMaster(user),
  };
}

const controller = {
  accessPayload,
  async mine(req, res, next) {
    try { return res.json(await accessPayload(req.user)); } catch (error) { return next(error); }
  },
  async setPreference(req, res, next) {
    try {
      const preference = await companyService.setCompanyFilterPreference(req.user, req.body?.company);
      return res.json({ preference });
    } catch (error) { return next(error); }
  },
  async adminList(req, res, next) {
    try {
      companyService.assertGlobalMaster(req.user);
      const companies = await companyService.listCompanies({ includeInactive: true });
      return res.json({ companies: companies.map(companyService.publicCompany) });
    } catch (error) { return next(error); }
  },
  async create(req, res, next) {
    try {
      const company = await companyService.createCompany(req.body || {}, req.user);
      await audit.recordAudit({ actor: req.user, action: "COMPANY_CREATED", entityType: "COMPANY", entityId: company.id, summary: `Empresa ${company.name} criada.`, companyId: company.id });
      return res.status(201).json({ company });
    } catch (error) { return next(error); }
  },
  async update(req, res, next) {
    try {
      const company = await companyService.updateCompany(req.params.companyId, req.body || {}, req.user);
      await audit.recordAudit({ actor: req.user, action: "COMPANY_UPDATED", entityType: "COMPANY", entityId: company.id, summary: `Empresa ${company.name} atualizada.`, companyId: company.id });
      return res.json({ company });
    } catch (error) { return next(error); }
  },
};

module.exports = controller;
