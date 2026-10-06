const authorization = require("../services/authorization-service");
const users = require("../services/user-management-service");
const inboxEvents = require("../realtime/inbox-events");

module.exports = {
  async list(req, res, next) {
    try { authorization.assertMaster(req.user); return res.json(await users.listUsers()); }
    catch (error) { return next(error); }
  },
  async activity(req, res, next) {
    try { return res.json(await users.listTeamActivity(req.user, { company: req.query.company })); }
    catch (error) { return next(error); }
  },
  async create(req, res, next) {
    try {
      authorization.assertMaster(req.user);
      const user = await users.createUser(req.body, req.user);
      inboxEvents.publish();
      return res.status(201).json(user);
    } catch (error) { return next(error); }
  },
  async update(req, res, next) {
    try {
      authorization.assertMaster(req.user);
      const user = await users.updateUser(req.params.id, req.body, req.user.id, req.user);
      inboxEvents.publish();
      return res.json(user);
    } catch (error) { return next(error); }
  },
};
