/*
  How a fake world carries a request, as Foundry does (socket.js): a player's
  request goes to the active GM by query, and the GM's handler is told who
  sent it. `deliverTo(handlers)` hands a request to the GM's heardRequest
  with the user it names as the sender Foundry gives (pass `from` to send it
  as someone else: a forged request), and anything else to the socket
  handlers. `withQuery(user, sent)` is that user with a query that records
  what a player's client sent it.
*/
import { heardRequest, isRequest } from "../module/scripts/foundry/socket.js";

export const deliverTo = handlers => (msg, { from } = {}) => isRequest(msg)
  ? heardRequest(msg, { user: globalThis.game.users.get(from ?? msg.userId) }).catch(refused => ({ refused }))
  : Promise.all(handlers.map(h => h(msg)));

export const withQuery = (user, sent) => user && { ...user, query: async (_name, data) => { sent.push(data); return true; } };
