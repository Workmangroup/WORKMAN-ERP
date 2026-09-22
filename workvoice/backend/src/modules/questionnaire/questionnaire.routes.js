import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { pool, query, queryOne, transaction } from '../../config/db.js';
import { ROLES } from '../../config/constants.js';
import { authenticate, authorize } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { notifyRole } from '../../services/notification.service.js';
import { audit } from '../../utils/audit.js';
import { conflict, HttpError, notFound } from '../../utils/httpError.js';
import { idParamSchema } from '../tickets/tickets.schemas.js';

/*
 * Questionnaire de satisfaction du personnel (GRH-IFD-23).
 *
 * ANONYMAT : une réponse (questionnaire_reponses) ne contient jamais user_id.
 * La table questionnaire_participations sert uniquement à empêcher les doublons.
 * Les résultats ne sont publiés que pour des groupes d'au moins SEUIL répondants.
 */

export const SEUIL_ANONYMAT = 5;

const router = Router();
router.use(authenticate);

/** Score orienté satisfaction : les questions à formulation négative sont inversées. */
const SCORE_SQL = 'CASE WHEN q.inverse = 1 THEN 6 - d.note ELSE d.note END';
/** Indice 0–100 à partir d'une moyenne 1–5. */
const indice = (moy) => (moy === null || moy === undefined ? null : Math.round(((moy - 1) / 4) * 100));

async function activeQuestions() {
  return query('SELECT id, ordre, texte_fr, texte_ar, inverse FROM questionnaire_questions WHERE actif = 1 ORDER BY ordre');
}

async function openCampaign() {
  return queryOne(
    `SELECT id, titre, reference, date_debut, date_fin FROM questionnaire_campagnes
     WHERE statut = 'OUVERTE' AND date_debut <= CURDATE() AND (date_fin IS NULL OR date_fin >= CURDATE())
     ORDER BY date_debut DESC LIMIT 1`,
  );
}

// ---------------------------------------------------------------- Collaborateur

// GET /api/questionnaire/actif — campagne ouverte + questions + déjà répondu ?
router.get('/actif', async (req, res) => {
  const campagne = await openCampaign();
  if (!campagne) return res.json({ data: { campagne: null, questions: [], deja_repondu: false } });

  const [questions, participation] = await Promise.all([
    activeQuestions(),
    queryOne('SELECT 1 AS ok FROM questionnaire_participations WHERE campagne_id = ? AND user_id = ?', [campagne.id, req.user.id]),
  ]);
  res.json({
    data: {
      campagne,
      questions: questions.map((q) => ({ ...q, inverse: Boolean(q.inverse) })),
      deja_repondu: Boolean(participation),
    },
  });
});

// POST /api/questionnaire/campagnes/:id/reponses
const submitSchema = z.object({
  reponses: z
    .array(z.object({ question_id: z.coerce.number().int().positive(), note: z.coerce.number().int().min(1).max(5) }))
    .min(1, 'Veuillez répondre au questionnaire'),
  commentaire: z
    .string()
    .trim()
    .max(2000, 'Le commentaire ne peut pas dépasser 2000 caractères')
    .optional()
    .transform((v) => v || null),
});

router.post('/campagnes/:id/reponses', validate(idParamSchema, 'params'), validate(submitSchema), async (req, res) => {
  const campagneId = req.valid.params.id;
  const campagne = await openCampaign();
  if (!campagne || campagne.id !== campagneId) {
    throw new HttpError(409, "Ce questionnaire n'est pas ouvert aux réponses", 'CAMPAGNE_FERMEE');
  }

  const questions = await activeQuestions();
  const expected = new Set(questions.map((q) => q.id));
  const answered = new Map(req.body.reponses.map((r) => [r.question_id, r.note]));
  const missing = [...expected].filter((id) => !answered.has(id));
  const unknown = [...answered.keys()].filter((id) => !expected.has(id));
  if (missing.length || unknown.length) {
    throw new HttpError(422, 'Merci de répondre à toutes les questions', 'QUESTIONNAIRE_INCOMPLET', { manquantes: missing });
  }

  try {
    await transaction(async (conn) => {
      await conn.query(
        'INSERT INTO questionnaire_participations (campagne_id, user_id, date_participation) VALUES (?, ?, CURDATE())',
        [campagneId, req.user.id],
      );
      const reponseId = crypto.randomUUID();
      await conn.query(
        `INSERT INTO questionnaire_reponses (id, campagne_id, service, departement, site, date_soumission, commentaire)
         VALUES (?, ?, ?, ?, ?, CURDATE(), ?)`,
        [reponseId, campagneId, req.user.service, req.user.departement, req.user.site, req.body.commentaire],
      );
      await conn.query('INSERT INTO questionnaire_reponses_detail (reponse_id, question_id, note) VALUES ?', [
        [...answered].map(([questionId, note]) => [reponseId, questionId, note]),
      ]);
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw conflict('Vous avez déjà répondu à ce questionnaire. Merci !');
    throw err;
  }

  // Seule la participation est journalisée — jamais l'identifiant de la réponse
  await audit(req, 'QUESTIONNAIRE_PARTICIPATION', { entite: 'questionnaire_campagnes', entiteId: campagneId });
  res.status(201).json({ data: { ok: true } });
});

// ---------------------------------------------------------------- RH & Direction

const staff = authorize(ROLES.RH, ROLES.DIRECTION);

// GET /api/questionnaire/campagnes — liste + participation + indice global
router.get('/campagnes', staff, async (_req, res) => {
  const [campagnes, effectif, indices] = await Promise.all([
    query(
      `SELECT c.id, c.titre, c.reference, c.date_debut, c.date_fin, c.statut, c.created_at,
              (SELECT COUNT(*) FROM questionnaire_reponses r WHERE r.campagne_id = c.id) AS nb_reponses
       FROM questionnaire_campagnes c ORDER BY c.date_debut DESC`,
    ),
    queryOne("SELECT COUNT(*) AS n FROM users WHERE actif = 1 AND role = 'EMPLOYE'"),
    query(
      `SELECT r.campagne_id, AVG(${SCORE_SQL}) AS moyenne
       FROM questionnaire_reponses r
       JOIN questionnaire_reponses_detail d ON d.reponse_id = r.id
       JOIN questionnaire_questions q ON q.id = d.question_id
       GROUP BY r.campagne_id`,
    ),
  ]);
  const byCampagne = Object.fromEntries(indices.map((i) => [i.campagne_id, i.moyenne]));
  res.json({
    data: campagnes.map((c) => ({
      ...c,
      effectif: effectif.n,
      taux_participation: effectif.n ? Math.round((c.nb_reponses / effectif.n) * 100) : 0,
      indice_satisfaction: c.nb_reponses >= SEUIL_ANONYMAT ? indice(byCampagne[c.id]) : null,
    })),
  });
});

// POST /api/questionnaire/campagnes — RH
const createSchema = z
  .object({
    titre: z.string({ error: 'Le titre est obligatoire' }).trim().min(3, 'Le titre doit contenir au moins 3 caractères').max(150),
    date_debut: z.iso.date('Date de début invalide'),
    date_fin: z.union([z.iso.date('Date de fin invalide'), z.literal('')]).optional().transform((v) => v || null),
    ouvrir: z.boolean().default(false),
  })
  .refine((d) => !d.date_fin || d.date_fin >= d.date_debut, { path: ['date_fin'], message: 'La date de fin doit suivre la date de début' });

async function assertNoOtherOpen(exceptId = 0) {
  const other = await queryOne("SELECT titre FROM questionnaire_campagnes WHERE statut = 'OUVERTE' AND id <> ?", [exceptId]);
  if (other) throw conflict(`La campagne « ${other.titre} » est déjà ouverte. Clôturez-la d'abord.`);
}

async function announce(campagneId, titre) {
  await notifyRole(
    ROLES.EMPLOYE,
    {
      type: 'QUESTIONNAIRE_OUVERT',
      titre: 'Questionnaire de satisfaction',
      message: `« ${titre} » est ouvert. Votre avis compte : 2 minutes, réponses anonymes.`,
      lien: '/employe/questionnaire/',
    },
    { email: false },
  );
  return campagneId;
}

router.post('/campagnes', authorize(ROLES.RH), validate(createSchema), async (req, res) => {
  const { titre, date_debut, date_fin, ouvrir } = req.body;
  if (ouvrir) await assertNoOtherOpen();
  const [result] = await pool.query(
    'INSERT INTO questionnaire_campagnes (titre, date_debut, date_fin, statut, created_by) VALUES (?, ?, ?, ?, ?)',
    [titre, date_debut, date_fin, ouvrir ? 'OUVERTE' : 'BROUILLON', req.user.id],
  );
  await audit(req, 'QUESTIONNAIRE_CAMPAGNE_CREATION', { entite: 'questionnaire_campagnes', entiteId: result.insertId });
  if (ouvrir) await announce(result.insertId, titre);
  res.status(201).json({ data: { id: result.insertId } });
});

// PATCH /api/questionnaire/campagnes/:id/statut — RH
const statutSchema = z.object({ statut: z.enum(['OUVERTE', 'CLOTUREE'], { error: 'Statut invalide' }) });

router.patch('/campagnes/:id/statut', authorize(ROLES.RH), validate(idParamSchema, 'params'), validate(statutSchema), async (req, res) => {
  const { id } = req.valid.params;
  const campagne = await queryOne('SELECT id, titre, statut FROM questionnaire_campagnes WHERE id = ?', [id]);
  if (!campagne) throw notFound('Campagne introuvable');
  if (req.body.statut === 'OUVERTE') await assertNoOtherOpen(id);

  await query('UPDATE questionnaire_campagnes SET statut = ? WHERE id = ?', [req.body.statut, id]);
  await audit(req, 'QUESTIONNAIRE_CAMPAGNE_STATUT', {
    entite: 'questionnaire_campagnes',
    entiteId: id,
    details: { de: campagne.statut, vers: req.body.statut },
  });
  if (req.body.statut === 'OUVERTE' && campagne.statut !== 'OUVERTE') await announce(id, campagne.titre);
  res.json({ data: { statut: req.body.statut } });
});

// GET /api/questionnaire/campagnes/:id/resultats?site=&departement=
const resultatsSchema = z.object({
  site: z.string().trim().max(80).optional(),
  departement: z.string().trim().max(80).optional(),
});

router.get(
  '/campagnes/:id/resultats',
  staff,
  validate(idParamSchema, 'params'),
  validate(resultatsSchema, 'query'),
  async (req, res) => {
    const { id } = req.valid.params;
    const { site, departement } = req.valid.query;
    const campagne = await queryOne(
      'SELECT id, titre, reference, date_debut, date_fin, statut FROM questionnaire_campagnes WHERE id = ?',
      [id],
    );
    if (!campagne) throw notFound('Campagne introuvable');

    const where = ['r.campagne_id = ?'];
    const params = [id];
    if (site) { where.push('r.site = ?'); params.push(site); }
    if (departement) { where.push('r.departement = ?'); params.push(departement); }
    const whereSql = where.join(' AND ');

    const [{ n }, effectif, questions] = await Promise.all([
      queryOne(`SELECT COUNT(*) AS n FROM questionnaire_reponses r WHERE ${whereSql}`, params),
      queryOne("SELECT COUNT(*) AS n FROM users WHERE actif = 1 AND role = 'EMPLOYE'"),
      query('SELECT id, ordre, texte_fr, texte_ar, inverse FROM questionnaire_questions ORDER BY ordre'),
    ]);

    const base = {
      campagne,
      seuil: SEUIL_ANONYMAT,
      nb_reponses: n,
      effectif: effectif.n,
      taux_participation: effectif.n && !site && !departement ? Math.round((n / effectif.n) * 100) : null,
    };

    // Groupe trop petit : rien n'est publié (protection de l'anonymat)
    if (n < SEUIL_ANONYMAT) return res.json({ data: { ...base, insuffisant: true } });

    const [distribution, parDepartement, parSite, commentaires] = await Promise.all([
      query(
        `SELECT d.question_id, d.note, COUNT(*) AS total
         FROM questionnaire_reponses r JOIN questionnaire_reponses_detail d ON d.reponse_id = r.id
         WHERE ${whereSql} GROUP BY d.question_id, d.note`,
        params,
      ),
      query(
        `SELECT r.departement AS groupe, COUNT(DISTINCT r.id) AS n, AVG(${SCORE_SQL}) AS moyenne
         FROM questionnaire_reponses r
         JOIN questionnaire_reponses_detail d ON d.reponse_id = r.id
         JOIN questionnaire_questions q ON q.id = d.question_id
         WHERE ${whereSql} GROUP BY r.departement ORDER BY r.departement`,
        params,
      ),
      query(
        `SELECT r.site AS groupe, COUNT(DISTINCT r.id) AS n, AVG(${SCORE_SQL}) AS moyenne
         FROM questionnaire_reponses r
         JOIN questionnaire_reponses_detail d ON d.reponse_id = r.id
         JOIN questionnaire_questions q ON q.id = d.question_id
         WHERE ${whereSql} GROUP BY r.site ORDER BY r.site`,
        params,
      ),
      // L'identifiant UUID donne un ordre aléatoire : impossible de déduire l'ordre de dépôt
      query(`SELECT commentaire FROM questionnaire_reponses r WHERE ${whereSql} AND commentaire IS NOT NULL ORDER BY r.id LIMIT 100`, params),
    ]);

    let totalScore = 0;
    let totalCount = 0;
    const parQuestion = questions
      .map((q) => {
        const counts = [1, 2, 3, 4, 5].map((note) => distribution.find((d) => d.question_id === q.id && d.note === note)?.total ?? 0);
        const total = counts.reduce((a, b) => a + b, 0);
        if (!total) return null;
        const moyenne = counts.reduce((s, c, i) => s + c * (i + 1), 0) / total;
        const scoreMoyen = q.inverse ? 6 - moyenne : moyenne;
        totalScore += scoreMoyen * total;
        totalCount += total;
        // « Favorable » = d'accord (4–5), ou pas d'accord (1–2) pour une question négative
        const favorables = q.inverse ? counts[0] + counts[1] : counts[3] + counts[4];
        return {
          question_id: q.id,
          ordre: q.ordre,
          texte_fr: q.texte_fr,
          texte_ar: q.texte_ar,
          inverse: Boolean(q.inverse),
          repartition: counts, // index 0 = note 1 (pas du tout d'accord) … index 4 = note 5
          total,
          moyenne: Math.round(moyenne * 100) / 100,
          indice: indice(scoreMoyen),
          taux_favorable: Math.round((favorables / total) * 100),
        };
      })
      .filter(Boolean);

    const groups = (rows) => {
      const visible = rows.filter((g) => g.n >= SEUIL_ANONYMAT).map((g) => ({ groupe: g.groupe, n: g.n, indice: indice(g.moyenne) }));
      const masques = rows.filter((g) => g.n < SEUIL_ANONYMAT).reduce((s, g) => s + g.n, 0);
      return { groupes: visible, reponses_masquees: masques };
    };

    res.json({
      data: {
        ...base,
        insuffisant: false,
        indice_satisfaction: totalCount ? indice(totalScore / totalCount) : null,
        par_question: parQuestion,
        par_departement: groups(parDepartement),
        par_site: groups(parSite),
        commentaires: commentaires.map((c) => c.commentaire),
      },
    });
  },
);

// GET /api/questionnaire/referentiels — valeurs de filtres présentes dans les réponses
router.get('/referentiels', staff, async (_req, res) => {
  const [sites, departements] = await Promise.all([
    query('SELECT DISTINCT site FROM questionnaire_reponses ORDER BY site'),
    query('SELECT DISTINCT departement FROM questionnaire_reponses ORDER BY departement'),
  ]);
  res.json({ data: { sites: sites.map((r) => r.site), departements: departements.map((r) => r.departement) } });
});

export default router;
