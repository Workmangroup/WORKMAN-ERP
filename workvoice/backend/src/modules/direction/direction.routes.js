import { Router } from 'express';
import { z } from 'zod';
import { directionPool, query, queryOne } from '../../config/db.js';
import { CATEGORIES_RECLAMATION, NIVEAUX_URGENCE, ROLES, STATUTS } from '../../config/constants.js';
import { authenticate, authorize } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { audit } from '../../utils/audit.js';
import { notFound } from '../../utils/httpError.js';
import { paged, paginate, paginationSchema } from '../../utils/pagination.js';
import { idParamSchema } from '../tickets/tickets.schemas.js';

/*
 * RÈGLE D'OR : ce module n'interroge QUE les vues v_direction_* via
 * directionPool. Il ne doit jamais importer tickets.service ni lire la table users.
 */

const router = Router();
router.use(authenticate, authorize(ROLES.DIRECTION));

const q = (sql, params) => query(sql, params, directionPool);
const q1 = (sql, params) => queryOne(sql, params, directionPool);

const OPEN = `statut NOT IN ('RESOLU','CLOTURE')`;
const AVG_DAYS = 'ROUND(AVG(TIMESTAMPDIFF(HOUR, date_creation, date_cloture)) / 24, 1)';
// Variante utilisable dans un GROUP BY qui mélange tickets ouverts et clôturés
const AVG_DAYS_CLOSED =
  'ROUND(AVG(CASE WHEN date_cloture IS NOT NULL THEN TIMESTAMPDIFF(HOUR, date_creation, date_cloture) END) / 24, 1)';

// GET /api/direction/dashboard — cartes KPI
router.get('/dashboard', async (_req, res) => {
  const [rec, dem, temps] = await Promise.all([
    q1(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(date_creation >= DATE_FORMAT(CURDATE(), '%Y-%m-01')), 0) AS ce_mois,
              COALESCE(SUM(date_creation >= DATE_FORMAT(CURDATE() - INTERVAL 1 MONTH, '%Y-%m-01')
                           AND date_creation < DATE_FORMAT(CURDATE(), '%Y-%m-01')), 0) AS mois_precedent,
              COALESCE(SUM(${OPEN}), 0) AS ouvertes,
              COALESCE(SUM(niveau_urgence = 'CRITIQUE' AND ${OPEN}), 0) AS critiques_ouvertes,
              COALESCE(SUM(statut IN ('RESOLU','CLOTURE')), 0) AS traitees
       FROM v_direction_reclamations`,
    ),
    q1(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(date_creation >= DATE_FORMAT(CURDATE(), '%Y-%m-01')), 0) AS ce_mois,
              COALESCE(SUM(${OPEN}), 0) AS ouvertes
       FROM v_direction_demandes`,
    ),
    q1(
      `SELECT
         (SELECT ${AVG_DAYS} FROM v_direction_reclamations WHERE date_cloture IS NOT NULL) AS reclamations,
         (SELECT ${AVG_DAYS} FROM v_direction_demandes     WHERE date_cloture IS NOT NULL) AS demandes,
         (SELECT ${AVG_DAYS} FROM (
            SELECT date_creation, date_cloture FROM v_direction_reclamations WHERE date_cloture IS NOT NULL
            UNION ALL
            SELECT date_creation, date_cloture FROM v_direction_demandes     WHERE date_cloture IS NOT NULL
          ) x) AS global`,
    ),
  ]);

  res.json({
    data: {
      kpi: {
        total_reclamations: rec.total,
        total_demandes: dem.total,
        temps_moyen_traitement_jours: temps.global,
        reclamations_ce_mois: rec.ce_mois,
        reclamations_mois_precedent: rec.mois_precedent,
        reclamations_ouvertes: rec.ouvertes,
        critiques_ouvertes: rec.critiques_ouvertes,
        taux_resolution: rec.total ? Math.round((rec.traitees / rec.total) * 100) : 0,
      },
      temps_moyen_jours: temps,
      demandes: dem,
    },
  });
});

// GET /api/direction/stats?annee=2026 — données des graphiques
const statsSchema = z.object({
  annee: z.coerce.number().int().min(2020).max(2100).default(() => new Date().getFullYear()),
});

router.get('/stats', validate(statsSchema, 'query'), async (req, res) => {
  const { annee } = req.valid.query;
  const range = 'date_creation >= ? AND date_creation < ?';
  const p = [`${annee}-01-01`, `${annee + 1}-01-01`];

  const [parService, parCategorie, parSite, parDepartement, parUrgence, recMois, demMois] = await Promise.all([
    q(`SELECT COALESCE(service, 'Non communiqué') AS service, COUNT(*) AS total
       FROM v_direction_reclamations WHERE ${range} GROUP BY 1 ORDER BY total DESC`, p),
    q(`SELECT categorie, COUNT(*) AS total
       FROM v_direction_reclamations WHERE ${range} GROUP BY categorie ORDER BY total DESC`, p),
    q(`SELECT site, COUNT(*) AS total
       FROM v_direction_reclamations WHERE ${range} GROUP BY site ORDER BY total DESC`, p),
    q(`SELECT departement, COUNT(*) AS total
       FROM v_direction_reclamations WHERE ${range} GROUP BY departement ORDER BY total DESC`, p),
    q(`SELECT niveau_urgence, COUNT(*) AS total
       FROM v_direction_reclamations WHERE ${range}
       GROUP BY niveau_urgence ORDER BY FIELD(niveau_urgence, 'FAIBLE','MOYEN','ELEVE','CRITIQUE')`, p),
    q(`SELECT MONTH(date_creation) AS mois, COUNT(*) AS total,
              ${AVG_DAYS_CLOSED} AS temps_moyen
       FROM v_direction_reclamations WHERE ${range} GROUP BY mois`, p),
    q(`SELECT MONTH(date_creation) AS mois, COUNT(*) AS total,
              ${AVG_DAYS_CLOSED} AS temps_moyen
       FROM v_direction_demandes WHERE ${range} GROUP BY mois`, p),
  ]);

  const byMonth = (rows) => Object.fromEntries(rows.map((r) => [r.mois, r]));
  const rm = byMonth(recMois);
  const dm = byMonth(demMois);
  const mois = Array.from({ length: 12 }, (_, i) => i + 1);
  // Mois pas encore écoulés de l'année en cours : null (et non 0) pour ne pas tracer une fausse chute
  const now = new Date();
  const future = (m) => annee > now.getFullYear() || (annee === now.getFullYear() && m > now.getMonth() + 1);

  res.json({
    data: {
      annee,
      reclamations_par_service: parService,
      reclamations_par_categorie: parCategorie,
      reclamations_par_site: parSite,
      reclamations_par_departement: parDepartement,
      reclamations_par_urgence: parUrgence,
      evolution_mensuelle: mois.map((m) => ({
        mois: m,
        reclamations: future(m) ? null : rm[m]?.total ?? 0,
        demandes: future(m) ? null : dm[m]?.total ?? 0,
      })),
      temps_moyen_mensuel: mois.map((m) => ({
        mois: m,
        reclamations: rm[m]?.temps_moyen ?? null,
        demandes: dm[m]?.temps_moyen ?? null,
      })),
    },
  });
});

// GET /api/direction/reclamations — liste anonymisée
const listSchema = z.object({
  categorie: z.enum(CATEGORIES_RECLAMATION).optional(),
  urgence: z.enum(NIVEAUX_URGENCE).optional(),
  statut: z.enum(STATUTS).optional(),
  site: z.string().trim().max(80).optional(),
  departement: z.string().trim().max(80).optional(),
  q: z.string().trim().max(100).optional(),
  ...paginationSchema,
});

const DIRECTION_COLS = `id, numero_reclamation AS numero, categorie, objet, description, niveau_urgence,
  confidentielle, statut, date_creation, date_cloture, service, departement, site`;

const shape = (r) => ({ ...r, confidentielle: Boolean(r.confidentielle), service: r.service ?? 'Non communiqué' });

router.get('/reclamations', validate(listSchema, 'query'), async (req, res) => {
  const f = req.valid.query;
  const where = [];
  const params = [];
  if (f.categorie) { where.push('categorie = ?'); params.push(f.categorie); }
  if (f.urgence) { where.push('niveau_urgence = ?'); params.push(f.urgence); }
  if (f.statut) { where.push('statut = ?'); params.push(f.statut); }
  if (f.site) { where.push('site = ?'); params.push(f.site); }
  if (f.departement) { where.push('departement = ?'); params.push(f.departement); }
  if (f.q) {
    where.push('(numero_reclamation LIKE ? OR objet LIKE ? OR description LIKE ?)');
    const like = `%${f.q.replace(/[\\%_]/g, '\\$&')}%`;
    params.push(like, like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { limit, offset } = paginate(f);

  const [rows, count] = await Promise.all([
    q(`SELECT ${DIRECTION_COLS} FROM v_direction_reclamations ${whereSql}
       ORDER BY date_creation DESC LIMIT ? OFFSET ?`, [...params, limit, offset]),
    q1(`SELECT COUNT(*) AS total FROM v_direction_reclamations ${whereSql}`, params),
  ]);

  res.json(paged(rows.map(shape), count.total, f));
});

// GET /api/direction/reclamations/:id — détail anonymisé (sans commentaires ni pièces jointes)
router.get('/reclamations/:id', validate(idParamSchema, 'params'), async (req, res) => {
  const row = await q1(`SELECT ${DIRECTION_COLS} FROM v_direction_reclamations WHERE id = ?`, [req.valid.params.id]);
  if (!row) throw notFound('Réclamation introuvable');
  await audit(req, 'DIRECTION_CONSULTATION', { entite: 'reclamations', entiteId: row.id });
  res.json({ data: shape(row) });
});

// GET /api/direction/referentiels
router.get('/referentiels', async (_req, res) => {
  const [sites, departements] = await Promise.all([
    q('SELECT DISTINCT site FROM v_direction_reclamations ORDER BY site'),
    q('SELECT DISTINCT departement FROM v_direction_reclamations ORDER BY departement'),
  ]);
  res.json({ data: { sites: sites.map((r) => r.site), departements: departements.map((r) => r.departement) } });
});

export default router;
