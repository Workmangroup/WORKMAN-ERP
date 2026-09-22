import { Router } from 'express';
import { query, queryOne } from '../../config/db.js';
import { ROLES } from '../../config/constants.js';
import { authenticate, authorize } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { TICKET_KINDS } from '../tickets/tickets.config.js';
import { makeListSchema } from '../tickets/tickets.schemas.js';
import { listForRh } from '../tickets/tickets.service.js';

const router = Router();
router.use(authenticate, authorize(ROLES.RH));

const OPEN = `statut NOT IN ('RESOLU','CLOTURE')`;
const AVG_DAYS = 'ROUND(AVG(TIMESTAMPDIFF(HOUR, date_creation, date_cloture)) / 24, 1)';

// GET /api/rh/dashboard
router.get('/dashboard', async (_req, res) => {
  const [kpi, delais, parStatut, parType, derniers] = await Promise.all([
    queryOne(
      `SELECT
         (SELECT COUNT(*) FROM demandes     WHERE ${OPEN})                    AS demandes_ouvertes,
         (SELECT COUNT(*) FROM reclamations WHERE ${OPEN})                    AS reclamations_ouvertes,
         (SELECT COUNT(*) FROM suggestions  WHERE ${OPEN})                    AS suggestions_ouvertes,
         (SELECT COUNT(*) FROM reclamations WHERE niveau_urgence = 'CRITIQUE' AND ${OPEN}) AS critiques_ouvertes,
         (SELECT COUNT(*) FROM demandes     WHERE statut = 'NOUVEAU')
           + (SELECT COUNT(*) FROM reclamations WHERE statut = 'NOUVEAU')
           + (SELECT COUNT(*) FROM suggestions  WHERE statut = 'NOUVEAU')     AS a_prendre_en_charge`,
    ),
    queryOne(
      `SELECT
         (SELECT ${AVG_DAYS} FROM demandes     WHERE date_cloture IS NOT NULL) AS demandes,
         (SELECT ${AVG_DAYS} FROM reclamations WHERE date_cloture IS NOT NULL) AS reclamations,
         (SELECT ${AVG_DAYS} FROM (
            SELECT date_creation, date_cloture FROM demandes     WHERE date_cloture IS NOT NULL
            UNION ALL
            SELECT date_creation, date_cloture FROM reclamations WHERE date_cloture IS NOT NULL
          ) x) AS global`,
    ),
    query(
      `SELECT statut, SUM(kind = 'demande') AS demandes, SUM(kind = 'reclamation') AS reclamations
       FROM (SELECT 'demande' AS kind, statut FROM demandes
             UNION ALL SELECT 'reclamation', statut FROM reclamations) x
       GROUP BY statut
       ORDER BY FIELD(statut, 'NOUVEAU','EN_COURS','EN_ATTENTE','RESOLU','CLOTURE')`,
    ),
    query(
      `SELECT type_demande AS type, COUNT(*) AS total
       FROM demandes WHERE ${OPEN} GROUP BY type_demande ORDER BY total DESC`,
    ),
    query(
      `SELECT * FROM (
         SELECT 'demande' AS kind, d.id, d.numero_demande AS numero, d.type_demande AS type, d.objet, d.statut,
                NULL AS niveau_urgence, d.date_creation, u.nom, u.prenom, u.matricule, u.site
         FROM demandes d JOIN users u ON u.id = d.user_id
         UNION ALL
         SELECT 'reclamation', r.id, r.numero_reclamation, r.categorie, r.objet, r.statut,
                r.niveau_urgence, r.date_creation, u.nom, u.prenom, u.matricule, u.site
         FROM reclamations r JOIN users u ON u.id = r.user_id
       ) x
       ORDER BY date_creation DESC LIMIT 8`,
    ),
  ]);

  res.json({
    data: {
      kpi: { ...kpi, delai_moyen_jours: delais.global },
      delais_moyens_jours: delais,
      par_statut: parStatut,
      demandes_ouvertes_par_type: parType,
      derniers_tickets: derniers,
    },
  });
});

// GET /api/rh/demandes | /api/rh/reclamations | /api/rh/suggestions
for (const cfg of Object.values(TICKET_KINDS)) {
  router.get(`/${cfg.path}`, validate(makeListSchema(cfg), 'query'), async (req, res) => {
    res.json(await listForRh(cfg, req.valid.query));
  });
}

// GET /api/rh/referentiels — valeurs de filtres (sites, départements)
router.get('/referentiels', async (_req, res) => {
  const [sites, departements, services] = await Promise.all([
    query('SELECT DISTINCT site FROM users ORDER BY site'),
    query('SELECT DISTINCT departement FROM users ORDER BY departement'),
    query('SELECT DISTINCT service FROM users ORDER BY service'),
  ]);
  res.json({
    data: {
      sites: sites.map((r) => r.site),
      departements: departements.map((r) => r.departement),
      services: services.map((r) => r.service),
    },
  });
});

export default router;
