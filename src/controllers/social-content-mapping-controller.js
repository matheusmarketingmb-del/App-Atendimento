// Painel de mapeamento post/reel -> produto (item 10/11 do plano Social) —
// somente Master, mesma barra de acesso das Integrações.
const mappings = require("../services/channels/social-content-mapping-service");

module.exports = {
  async list(req, res, next) {
    try { return res.json(await mappings.listMappings({ channel: req.query.channel, active: req.query.active === undefined ? undefined : req.query.active === "true" }, req.user)); }
    catch (error) { return next(error); }
  },
  async create(req, res, next) {
    try { return res.status(201).json(await mappings.createMapping(req.body, req.user)); }
    catch (error) { return next(error); }
  },
  async setActive(req, res, next) {
    try { return res.json(await mappings.setMappingActive(req.params.id, req.body.active, req.user)); }
    catch (error) { return next(error); }
  },
  async remove(req, res, next) {
    try { return res.json(await mappings.deleteMapping(req.params.id, req.user)); }
    catch (error) { return next(error); }
  },
};
