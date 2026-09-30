// Supervisão de equipes (Master/Supervisor). Regras e RBAC ficam no serviço.
const supervision = require("../services/supervision-service");

const handler = (fn) => async (req, res, next) => {
  try { return res.json(await fn(req)); } catch (error) { return next(error); }
};

module.exports = {
  teams: handler((req) => supervision.listTeams(req.user)),
  searchUsers: handler((req) => supervision.searchAssignableUsers(req.user, req.query.q)),
  addMember: handler((req) => supervision.addTeamMember(req.user, req.params.supervisorId, req.params.memberId)),
  removeMember: handler((req) => supervision.removeTeamMember(req.user, req.params.supervisorId, req.params.memberId)),
  overview: handler((req) => supervision.teamOverview(req.user, req.query)),
  memberConversations: handler((req) => supervision.memberConversations(req.user, req.params.userId, req.query)),
  timeline: handler((req) => supervision.conversationTimeline(req.user, req.params.id)),
};
