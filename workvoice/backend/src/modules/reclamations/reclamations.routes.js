import { LABELS, ROLES } from '../../config/constants.js';
import { validate } from '../../middlewares/validate.js';
import { notifyRole } from '../../services/notification.service.js';
import { audit } from '../../utils/audit.js';
import { TICKET_KINDS } from '../tickets/tickets.config.js';
import { buildTicketRouter } from '../tickets/tickets.router.js';
import { reclamationCreateSchema } from '../tickets/tickets.schemas.js';
import * as tickets from '../tickets/tickets.service.js';

const cfg = TICKET_KINDS.reclamation;

export default buildTicketRouter(cfg, (router) => {
  // POST /api/reclamations — JSON
  router.post('/', validate(reclamationCreateSchema), async (req, res) => {
    const data = req.body;
    const created = await tickets.createTicket(cfg, req.user, data);

    await audit(req, 'RECLAMATION_CREATION', {
      entite: cfg.table,
      entiteId: created.id,
      details: { numero: created.numero, urgence: data.niveau_urgence, confidentielle: Boolean(data.confidentielle) },
    });

    // Réclamation critique : alerte Direction, strictement anonymisée
    if (data.niveau_urgence === 'CRITIQUE') {
      const orga = data.confidentielle
        ? `Département ${req.user.departement} · Site ${req.user.site}`
        : `Service ${req.user.service} · Département ${req.user.departement} · Site ${req.user.site}`;
      await notifyRole(ROLES.DIRECTION, {
        type: 'RECLAMATION_CRITIQUE',
        titre: `Réclamation critique ${created.numero}`,
        message: `${LABELS.categorie[data.categorie]} — ${orga}`,
        lien: `/direction/reclamation/?id=${created.id}`,
      });
    }

    res.status(201).json({ data: created });
  });
});
