import { validate } from '../../middlewares/validate.js';
import { audit } from '../../utils/audit.js';
import { TICKET_KINDS } from '../tickets/tickets.config.js';
import { buildTicketRouter } from '../tickets/tickets.router.js';
import { suggestionCreateSchema } from '../tickets/tickets.schemas.js';
import * as tickets from '../tickets/tickets.service.js';

const cfg = TICKET_KINDS.suggestion;

export default buildTicketRouter(cfg, (router) => {
  // POST /api/suggestions — JSON
  router.post('/', validate(suggestionCreateSchema), async (req, res) => {
    const created = await tickets.createTicket(cfg, req.user, req.body);
    await audit(req, 'SUGGESTION_CREATION', { entite: cfg.table, entiteId: created.id, details: { numero: created.numero } });
    res.status(201).json({ data: created });
  });
});
