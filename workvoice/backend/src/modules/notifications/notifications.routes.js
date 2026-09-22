import { Router } from 'express';
import { query, queryOne } from '../../config/db.js';
import { authenticate } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { idParamSchema } from '../tickets/tickets.schemas.js';

const router = Router();
router.use(authenticate);

// GET /api/notifications — 30 dernières + compteur de non lues
router.get('/', async (req, res) => {
  const [rows, { non_lues }] = await Promise.all([
    query(
      `SELECT id, type, titre, message, lien, lu, date_creation
       FROM notifications WHERE user_id = ? ORDER BY date_creation DESC, id DESC LIMIT 30`,
      [req.user.id],
    ),
    queryOne('SELECT COUNT(*) AS non_lues FROM notifications WHERE user_id = ? AND lu = 0', [req.user.id]),
  ]);
  res.json({ data: rows.map((n) => ({ ...n, lu: Boolean(n.lu) })), non_lues });
});

// PATCH /api/notifications/tout-lu
router.patch('/tout-lu', async (req, res) => {
  await query('UPDATE notifications SET lu = 1 WHERE user_id = ? AND lu = 0', [req.user.id]);
  res.status(204).end();
});

// PATCH /api/notifications/:id/lu
router.patch('/:id/lu', validate(idParamSchema, 'params'), async (req, res) => {
  // La condition user_id empêche de marquer les notifications d'un autre
  await query('UPDATE notifications SET lu = 1 WHERE id = ? AND user_id = ?', [req.valid.params.id, req.user.id]);
  res.status(204).end();
});

export default router;
