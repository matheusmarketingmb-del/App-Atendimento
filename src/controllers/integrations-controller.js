// Painel de Integrações — somente Master. Segredos permanecem no backend.
const accounts = require("../services/channels/channel-account-service");
const globalSettings = require("../services/channels/integration-global-settings-service");
const oauth = require("../services/channels/integration-oauth-service");
const { getOAuthProvider, getOAuthScopes } = require("../services/channels/oauth-providers");

const OAUTH_PROVIDERS_BY_CHANNEL = Object.freeze({
  EMAIL: ["GOOGLE", "MICROSOFT"],
  GOOGLE_REVIEWS: ["GOOGLE"],
  MERCADO_LIVRE: ["MERCADO_LIVRE"],
  AMAZON_MARKETPLACE: ["AMAZON"],
  INSTAGRAM_DIRECT: ["META"],
  INSTAGRAM_COMMENTS: ["META"],
  FACEBOOK_MESSENGER: ["META"],
  FACEBOOK_COMMENTS: ["META"],
});

function validRedirectUri(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.pathname === "/oauth-callback.html";
  } catch (_error) { return false; }
}

module.exports = {
  async overview(req, res, next) {
    try { return res.json(await accounts.listChannelOverview(req.user)); }
    catch (error) { return next(error); }
  },
  async list(req, res, next) {
    try { return res.json(await accounts.listAccounts(req.user)); }
    catch (error) { return next(error); }
  },
  async detail(req, res, next) {
    try { return res.json(await accounts.getAccount(req.params.accountId, req.user)); }
    catch (error) { return next(error); }
  },
  async create(req, res, next) {
    try { return res.status(201).json(await accounts.createAccount(req.body, req.user)); }
    catch (error) { return next(error); }
  },
  async update(req, res, next) {
    try { return res.json(await accounts.updateAccount(req.params.accountId, req.body, req.user)); }
    catch (error) { return next(error); }
  },
  async setEnabled(req, res, next) {
    try { return res.json(await accounts.setEnabled(req.params.accountId, req.body.enabled, req.user)); }
    catch (error) { return next(error); }
  },
  async setAccess(req, res, next) {
    try { return res.json(await accounts.setAccountAccess(req.params.accountId, req.body.userIds, req.body.categoryIds, req.user, req.body.outboundCategoryIds)); }
    catch (error) { return next(error); }
  },  async remove(req, res, next) {
    try { return res.json(await accounts.deleteAccount(req.params.accountId, req.user)); }
    catch (error) { return next(error); }
  },
  async testConnection(req, res, next) {
    try { return res.json(await accounts.testConnection(req.params.accountId, req.user)); }
    catch (error) { return next(error); }
  },
  async getGlobalSettings(req, res, next) {
    try { return res.json(await globalSettings.getGlobalSettingsForManager(req.user)); }
    catch (error) { return next(error); }
  },
  async setGlobalSettings(req, res, next) {
    try { return res.json(await globalSettings.setNewChannelsEnabled(req.body.newChannelsEnabled, req.user)); }
    catch (error) { return next(error); }
  },
  async setSocialReplyFlags(req, res, next) {
    try { return res.json(await globalSettings.setSocialReplyFlags(req.body, req.user)); }
    catch (error) { return next(error); }
  },

  async oauthStart(req, res, next) {
    try {
      accounts.assertIntegrationManager(req.user);
      const { channel, channelAccountId = null, provider, name = null } = req.body;
      if (!OAUTH_PROVIDERS_BY_CHANNEL[channel]?.includes(provider)) {
        return res.status(400).json({ error: "Provider OAuth não permitido para este canal." });
      }
      if (channelAccountId) {
        const target = await accounts.getAccount(channelAccountId, req.user);
        if (target.channel !== channel) return res.status(400).json({ error: "Conta OAuth não corresponde ao canal informado." });
      }
      const config = getOAuthProvider(provider);
      const clientId = process.env[config.clientIdEnv];
      const redirectUri = process.env[config.redirectUriEnv];
      if (!clientId || !redirectUri) return res.status(400).json({ error: `OAuth do provider não configurado no servidor (${config.clientIdEnv}/${config.redirectUriEnv}).` });
      if (!validRedirectUri(redirectUri)) return res.status(400).json({ error: "Redirect URI OAuth inválida; use HTTPS terminando em /oauth-callback.html." });
      const scopes = getOAuthScopes(provider, channel);
      const result = await oauth.createAuthorizationRequest({
        channel, channelAccountId, provider, clientId, redirectUri, scopes,
        actorUserId: req.user.id, context: { preferredName: name || null, scopes },
      });
      return res.json(result);
    } catch (error) { return next(error); }
  },

  async oauthCallback(req, res, next) {
    try {
      accounts.assertIntegrationManager(req.user);
      const { state, code, sellingPartnerId = null } = req.body;
      if (typeof state !== "string" || !state || typeof code !== "string" || !code) {
        return res.status(400).json({ error: "State e código OAuth são obrigatórios." });
      }
      const record = await oauth.consumeState(state, req.user.id);
      const provider = record.metadata?.provider;
      const config = getOAuthProvider(provider);
      const clientId = process.env[config.tokenClientIdEnv || config.clientIdEnv];
      const clientSecret = process.env[config.clientSecretEnv];
      if (!clientId || !clientSecret) return res.status(400).json({ error: "Credenciais OAuth globais não configuradas no servidor." });
      const token = await oauth.exchangeCodeForToken({ provider, code, clientId, clientSecret, redirectUri: record.redirectUri, codeVerifier: record.metadata?.codeVerifier });
      if (!token?.access_token) return res.status(502).json({ error: "Provider OAuth não devolveu access_token." });
      const candidates = await oauth.discoverOAuthAccounts({ provider, channel: record.channel, accessToken: token.access_token, callbackMetadata: { sellingPartnerId } });
      const result = await accounts.saveOAuthConnection({
        accountId: record.channelAccountId, channel: record.channel, provider, token,
        scopes: record.metadata?.scopes || [], candidates, preferredName: record.metadata?.preferredName,
      }, req.user);
      return res.json({
        connected: !result.selectionRequired, selectionRequired: result.selectionRequired,
        channelAccountId: result.account.id, candidates: result.candidates,
      });
    } catch (error) { return next(error); }
  },

  async oauthSelect(req, res, next) {
    try {
      const account = await accounts.selectOAuthCandidate(req.params.accountId, String(req.body.candidateId || ""), req.user);
      return res.json({ connected: true, account });
    } catch (error) { return next(error); }
  },
};
