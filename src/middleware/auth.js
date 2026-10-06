const auth = require("../services/auth-service");

async function authenticate(req, res, next) {
  try {
    const user = await auth.userFromToken(req.cookies[auth.COOKIE_NAME]);
    if (!user) return res.status(401).json({ error: "Autenticação necessária." });
    req.user = auth.publicUser(user);
    return next();
  } catch (error) { return next(error); }
}

async function requirePageAuth(req, res, next) {
  try {
    const user = await auth.userFromToken(req.cookies[auth.COOKIE_NAME]);
    if (!user) return res.redirect("/login.html");
    req.user = auth.publicUser(user);
    return next();
  } catch (error) { return next(error); }
}

async function requireMasterPage(req, res, next) {
  try {
    const user = await auth.userFromToken(req.cookies[auth.COOKIE_NAME]);
    if (!user) return res.redirect("/login.html");
    if (user.role !== "ADMIN") return res.status(403).send("Acesso restrito a conta Master.");
    req.user = auth.publicUser(user);
    return next();
  } catch (error) { return next(error); }
}

// Campanhas (item 27): Admin/Supervisor por padrão, ou um Atendente com o
// flag canManageCampaigns — mesma regra de auth-service.js#publicUser.
async function requireCampaignsPage(req, res, next) {
  try {
    const user = await auth.userFromToken(req.cookies[auth.COOKIE_NAME]);
    if (!user) return res.redirect("/login.html");
    const publicUser = auth.publicUser(user);
    // Multiempresa: abre se puder gerenciar campanhas em ALGUMA empresa (o
    // cargo/permissão pode variar por empresa); cada ação revalida a empresa.
    const companyIds = await require("../services/campaign-service").manageableCompanyIds(publicUser);
    if (!companyIds.length) return res.status(403).send("Acesso restrito a Admin/Supervisor ou usuários autorizados.");
    req.user = publicUser;
    return next();
  } catch (error) { return next(error); }
}

// Configurações → Conversas (item 13): Admin edita, Supervisor só visualiza —
// mesma régua de "requireCampaignsPage", trocando o flag por checagem de role.
async function requireConversationSettingsPage(req, res, next) {
  try {
    const user = await auth.userFromToken(req.cookies[auth.COOKIE_NAME]);
    if (!user) return res.redirect("/login.html");
    const publicUser = auth.publicUser(user);
    if (publicUser.role !== "ADMIN" && publicUser.role !== "SUPERVISOR") {
      return res.status(403).send("Acesso restrito a Admin ou Supervisor.");
    }
    req.user = publicUser;
    return next();
  } catch (error) { return next(error); }
}

module.exports = {
  authenticate, requireCampaignsPage, requireConversationSettingsPage, requireMasterPage, requirePageAuth,
};
