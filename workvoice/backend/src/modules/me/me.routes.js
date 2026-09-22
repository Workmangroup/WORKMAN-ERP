import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../../config/db.js';
import { STATUTS, STATUTS_TERMINES } from '../../config/constants.js';
import { authenticate } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { audit } from '../../utils/audit.js';
import { conflict } from '../../utils/httpError.js';

const router = Router();
router.use(authenticate);

/** Sous-requêtes « mes tickets » unifiées (demandes + réclamations + suggestions). */
const myTicketsUnion = (kinds) =>
  [
    kinds.includes('demande') &&
      `SELECT 'demande' AS kind, id, numero_demande AS numero, type_demande AS type, objet, statut,
              date_creation, date_maj, date_cloture FROM demandes WHERE user_id = :uid`,
    kinds.includes('reclamation') &&
      `SELECT 'reclamation', id, numero_reclamation, categorie, objet, statut,
              date_creation, date_maj, date_cloture FROM reclamations WHERE user_id = :uid`,
    kinds.includes('suggestion') &&
      `SELECT 'suggestion', id, numero_suggestion, theme, objet, statut,
              date_creation, date_maj, date_cloture FROM suggestions WHERE user_id = :uid`,
  ]
    .filter(Boolean)
    .join(' UNION ALL ');

const ALL_KINDS = ['demande', 'reclamation', 'suggestion'];

/** mysql2 `query` ne gère pas les paramètres nommés : on les remplace par position. */
function named(sql, values) {
  const params = [];
  const text = sql.replace(/:(\w+)/g, (_, k) => {
    params.push(values[k]);
    return '?';
  });
  return [text, params];
}

// GET /api/me/dashboard
router.get('/dashboard', async (req, res) => {
  const uid = req.user.id;

  const [counts] = await query(
    ...named(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(statut NOT IN ('RESOLU','CLOTURE')), 0) AS en_cours,
              COALESCE(SUM(statut IN ('RESOLU','CLOTURE')), 0)     AS cloturees,
              COALESCE(SUM(statut = 'EN_ATTENTE'), 0)              AS en_attente
       FROM (${myTicketsUnion(ALL_KINDS)}) x`,
      { uid },
    ),
  );

  const dernieresReponses = await query(
    `SELECT c.id, c.message, c.date_creation, 'demande' AS kind, d.id AS ticket_id, d.numero_demande AS numero, d.objet
       FROM commentaires c JOIN demandes d ON d.id = c.demande_id JOIN users a ON a.id = c.user_id
       WHERE d.user_id = ? AND a.role = 'RH'
     UNION ALL
     SELECT c.id, c.message, c.date_creation, 'reclamation', r.id, r.numero_reclamation, r.objet
       FROM commentaires c JOIN reclamations r ON r.id = c.reclamation_id JOIN users a ON a.id = c.user_id
       WHERE r.user_id = ? AND a.role = 'RH'
     UNION ALL
     SELECT c.id, c.message, c.date_creation, 'suggestion', s.id, s.numero_suggestion, s.objet
       FROM commentaires c JOIN suggestions s ON s.id = c.suggestion_id JOIN users a ON a.id = c.user_id
       WHERE s.user_id = ? AND a.role = 'RH'
     ORDER BY date_creation DESC
     LIMIT 5`,
    [uid, uid, uid],
  );

  const recents = await query(...named(`${myTicketsUnion(ALL_KINDS)} ORDER BY date_creation DESC LIMIT 5`, { uid }));
  const { non_lues } = await queryOne('SELECT COUNT(*) AS non_lues FROM notifications WHERE user_id = ? AND lu = 0', [uid]);

  res.json({
    data: {
      compteurs: { ...counts, notifications_non_lues: non_lues },
      dernieres_reponses: dernieresReponses.map((r) => ({ ...r, auteur: 'Service RH' })),
      recents,
    },
  });
});

// GET /api/me/historique?kind=&statut=
const historiqueSchema = z.object({
  kind: z.enum(ALL_KINDS).optional(),
  statut: z.enum(STATUTS).optional(),
  termines: z.enum(['true', 'false']).optional(),
});

router.get('/historique', validate(historiqueSchema, 'query'), async (req, res) => {
  const { kind, statut, termines } = req.valid.query;
  const where = [];
  const values = { uid: req.user.id };
  if (statut) { where.push('statut = :statut'); values.statut = statut; }
  if (termines === 'true') { where.push('statut IN (:termines)'); values.termines = STATUTS_TERMINES; }
  if (termines === 'false') { where.push('statut NOT IN (:termines)'); values.termines = STATUTS_TERMINES; }

  const rows = await query(
    ...named(
      `SELECT * FROM (${myTicketsUnion(kind ? [kind] : ALL_KINDS)}) x
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY date_creation DESC LIMIT 500`,
      values,
    ),
  );
  res.json({ data: rows });
});

// GET /api/me/profile
router.get('/profile', async (req, res) => {
  const profile = await queryOne(
    `SELECT id, matricule, nom, prenom, email, telephone, service, departement, site, role,
            derniere_connexion, created_at
     FROM users WHERE id = ?`,
    [req.user.id],
  );
  res.json({ data: profile });
});

// PUT /api/me/profile — seules les coordonnées sont modifiables par le collaborateur
const profileSchema = z.object({
  email: z.union([z.email('Adresse e-mail invalide').max(150), z.literal('')]).transform((v) => v || null),
  telephone: z
    .string()
    .trim()
    .max(30)
    .regex(/^[+0-9 ().-]*$/, 'Numéro de téléphone invalide')
    .transform((v) => v || null),
});

router.put('/profile', validate(profileSchema), async (req, res) => {
  try {
    await query('UPDATE users SET email = ?, telephone = ? WHERE id = ?', [req.body.email, req.body.telephone, req.user.id]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw conflict('Cette adresse e-mail est déjà utilisée');
    throw err;
  }
  await audit(req, 'PROFIL_MODIFICATION', { details: { champs: ['email', 'telephone'] } });
  res.json({ data: { email: req.body.email, telephone: req.body.telephone } });
});

export default router;
