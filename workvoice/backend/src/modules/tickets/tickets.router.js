import { Router } from 'express';
import { ROLES } from '../../config/constants.js';
import { authenticate, authorize } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { audit } from '../../utils/audit.js';
import { commentSchema, idParamSchema, statusSchema } from './tickets.schemas.js';
import * as tickets from './tickets.service.js';

/**
 * Routes communes à toutes les familles de tickets :
 *   GET    /mine                 mes tickets
 *   GET    /:id                  détail + fil d'échange (auteur ou RH)
 *   POST   /:id/commentaires     répondre (auteur ou RH)
 *   PATCH  /:id/statut           changer le statut (RH)
 * La création (POST /) est définie par chaque module, car ses champs diffèrent.
 */
export function buildTicketRouter(cfg, configure) {
  const router = Router();
  router.use(authenticate);

  configure?.(router);

  router.get('/mine', async (req, res) => {
    res.json({ data: await tickets.listMine(cfg, req.user.id) });
  });

  router.get('/:id', validate(idParamSchema, 'params'), async (req, res) => {
    const { id } = req.valid.params;
    const { ticket, identityDisclosed } = await tickets.getTicket(cfg, id, req.user);
    if (identityDisclosed) {
      await audit(req, 'CONSULTATION_IDENTITE', { entite: cfg.table, entiteId: id });
    }
    res.json({ data: ticket });
  });

  router.post(
    '/:id/commentaires',
    validate(idParamSchema, 'params'),
    validate(commentSchema),
    async (req, res) => {
      const { id } = req.valid.params;
      const result = await tickets.addComment(cfg, id, req.user, req.body.message);
      await audit(req, 'COMMENTAIRE_AJOUT', { entite: cfg.table, entiteId: id, details: { commentaire_id: result.id } });
      res.status(201).json({ data: result });
    },
  );

  router.patch(
    '/:id/statut',
    authorize(ROLES.RH),
    validate(idParamSchema, 'params'),
    validate(statusSchema),
    async (req, res) => {
      const { id } = req.valid.params;
      const result = await tickets.changeStatus(cfg, id, req.user, req.body.statut, req.body.commentaire);
      await audit(req, 'STATUT_CHANGEMENT', {
        entite: cfg.table,
        entiteId: id,
        details: { de: result.previous, vers: result.statut },
      });
      res.json({ data: result });
    },
  );

  return router;
}
