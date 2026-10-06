const prisma = require("../database/prisma");
const auth = require("../services/auth-service");
const { accessPayload } = require("./company-controller");

const controller = {
  async status(req, res, next) {
    try {
      const setupRequired = (await prisma.user.count()) === 0;
      const user = await auth.userFromToken(req.cookies[auth.COOKIE_NAME]);
      const publicUser = user ? auth.publicUser(user) : null;
      // Multiempresa: empresas acessíveis + cargo em cada uma + filtro salvo.
      const companyAccess = publicUser ? await accessPayload(publicUser) : null;
      if (publicUser) {
        // Menus: mostra Campanhas/prioridade se valer em ALGUMA empresa.
        const companyService = require("../services/company-service");
        for (const { companyId } of await companyService.companyAccess(publicUser)) {
          const scoped = await companyService.userForCompany(publicUser, companyId);
          for (const key of ["canManageCampaigns", "canSetConversationPriority", "canTransferConversations", "canStartConversations", "canMergeContacts", "canManageCategories"]) {
            if (scoped?.[key]) publicUser[key] = true;
          }
        }
      }
      return res.json({ setupRequired, authenticated: Boolean(user), user: publicUser, companyAccess });
    } catch (error) { return next(error); }
  },
  async setup(req, res, next) {
    try {
      const user = await auth.setup(req.body);
      auth.setSession(res, user);
      return res.status(201).json({ user: auth.publicUser(user) });
    } catch (error) { return next(error); }
  },
  async login(req, res, next) {
    try {
      const user = await auth.login(req.body);
      auth.setSession(res, user);
      return res.json({ user: auth.publicUser(user) });
    } catch (error) { return next(error); }
  },
  async logout(req, res, next) {
    try {
      await auth.invalidateSession(req.cookies[auth.COOKIE_NAME]);
    } catch (error) { return next(error); }
    auth.clearSession(res);
    return res.sendStatus(204);
  },
};

module.exports = controller;
