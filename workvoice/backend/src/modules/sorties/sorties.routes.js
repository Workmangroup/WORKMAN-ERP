import { Router } from 'express';
import { z } from 'zod';
import { pool, query, queryOne, transaction } from '../../config/db.js';
import { ABSENCE_STATUTS, LABELS, ROLES } from '../../config/constants.js';
import { authenticate, authorize } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { notifyRole, notifyUsers } from '../../services/notification.service.js';
import { audit } from '../../utils/audit.js';
import { badRequest, conflict, notFound } from '../../utils/httpError.js';
import { nextNumero } from '../../utils/numbering.js';
import { paged, paginate, paginationSchema } from '../../utils/pagination.js';
import { idParamSchema } from '../tickets/tickets.schemas.js';

/*
 * MODULE 2 — Autorisations de sortie.
 * Workflow : Collaborateur → RH → Validé/Refusé → Notification.
 */

const router = Router();
router.use(authenticate);

const IDENTITY_COLS = 'u.matricule, u.nom, u.prenom, u.email, u.telephone';
const ORGA_COLS = 'u.service, u.departement, u.site';
const fmtFr = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString('fr-FR');
const sortieLinkEmploye = (id) => `/employe/sorties/?id=${id}`;
const sortieLinkRh = (id) => `/rh/sorties/?id=${id}`;

async function loadSortie(id) {
  const s = await queryOne('SELECT s.*, m.libelle AS motif_libelle FROM sorties_demandes s JOIN sorties_motifs m ON m.id = s.motif_id WHERE s.id = ?', [id]);
  if (!s) throw notFound('Autorisation de sortie introuvable');
  return s;
}

router.get('/sorties/motifs', async (_req, res) => {
  res.json({ data: await query('SELECT id, libelle FROM sorties_motifs WHERE actif = 1 ORDER BY ordre, libelle') });
});

router.get('/me/sorties', async (req, res) => {
  const uid = req.user.id;
  const [data, cumulMois, cumulAnnee] = await Promise.all([
    query(
      `SELECT s.id, s.numero, s.date_sortie, s.heure_debut, s.heure_fin, s.duree_minutes, s.statut, s.motif_refus, s.date_creation, m.libelle AS motif_libelle
       FROM sorties_demandes s JOIN sorties_motifs m ON m.id = s.motif_id WHERE s.user_id = ? ORDER BY s.date_creation DESC`,
      [uid],
    ),
    queryOne(`SELECT COALESCE(SUM(duree_minutes), 0) AS n FROM sorties_demandes WHERE user_id = ? AND statut = 'VALIDE' AND date_sortie >= DATE_FORMAT(CURDATE(), '%Y-%m-01')`, [uid]),
    queryOne(`SELECT COALESCE(SUM(duree_minutes), 0) AS n FROM sorties_demandes WHERE user_id = ? AND statut = 'VALIDE' AND YEAR(date_sortie) = YEAR(CURDATE())`, [uid]),
  ]);
  res.json({ data, cumul_mois_minutes: Number(cumulMois.n), cumul_annee_minutes: Number(cumulAnnee.n) });
});

router.get('/sorties/:id', validate(idParamSchema, 'params'), async (req, res) => {
  const { id } = req.valid.params;
  const s = await loadSortie(id);
  const isRh = req.user.role === ROLES.RH;
  if (!isRh && s.user_id !== req.user.id) throw notFound('Autorisation de sortie introuvable');
  if (isRh) s.auteur = await queryOne(`SELECT ${IDENTITY_COLS}, ${ORGA_COLS} FROM users u WHERE u.id = ?`, [s.user_id]);
  res.json({ data: s });
});

const heureRegex = /^([01]\d|2[0-3]):[0-5]\d$/;
router.post('/sorties', validate(z.object({
  motif_id: z.coerce.number().int().positive({ error: 'Motif invalide' }),
  date_sortie: z.iso.date({ error: 'Date invalide' }),
  heure_debut: z.string().regex(heureRegex, 'Heure invalide (format HH:MM)'),
  heure_fin: z.string().regex(heureRegex, 'Heure invalide (format HH:MM)'),
  commentaire: z.string().trim().max(2000).optional().transform((v) => v || null),
})), async (req, res) => {
  const { motif_id, date_sortie, heure_debut, heure_fin, commentaire } = req.body;
  if (!(await queryOne('SELECT 1 FROM sorties_motifs WHERE id = ? AND actif = 1', [motif_id]))) throw badRequest('Motif invalide');
  const [h1, m1] = heure_debut.split(':').map(Number);
  const [h2, m2] = heure_fin.split(':').map(Number);
  const duree = (h2 * 60 + m2) - (h1 * 60 + m1);
  if (duree <= 0) throw badRequest("L'heure de fin doit être postérieure à l'heure de début");
  if (date_sortie < new Date().toISOString().slice(0, 10)) throw badRequest('La date ne peut pas être dans le passé');

  const { id, numero } = await transaction(async (conn) => {
    const numero = await nextNumero(conn, 'SOR');
    const [result] = await conn.query(
      'INSERT INTO sorties_demandes (numero, user_id, motif_id, date_sortie, heure_debut, heure_fin, duree_minutes, commentaire) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [numero, req.user.id, motif_id, date_sortie, heure_debut, heure_fin, duree, commentaire],
    );
    return { id: result.insertId, numero };
  });
  await audit(req, 'SORTIE_CREATION', { entite: 'sorties_demandes', entiteId: id, details: { numero } });
  await notifyRole(ROLES.RH, {
    type: 'NOUVELLE_SORTIE', titre: `Nouvelle autorisation de sortie ${numero}`,
    message: `Le ${fmtFr(date_sortie)} de ${heure_debut} à ${heure_fin}`, lien: sortieLinkRh(id),
  }, { excludeUserId: req.user.id });
  res.status(201).json({ data: { id, numero, duree_minutes: duree } });
});

router.post('/sorties/:id/annuler', validate(idParamSchema, 'params'), async (req, res) => {
  const { id } = req.valid.params;
  const s = await loadSortie(id);
  if (s.user_id !== req.user.id) throw notFound('Autorisation de sortie introuvable');
  if (s.statut !== 'EN_ATTENTE') throw conflict('Seule une demande en attente peut être annulée');
  await query("UPDATE sorties_demandes SET statut = 'ANNULE' WHERE id = ?", [id]);
  await audit(req, 'SORTIE_ANNULATION_COLLABORATEUR', { entite: 'sorties_demandes', entiteId: id });
  res.json({ data: { statut: 'ANNULE' } });
});

// ---------------------------------------------------------------- RH

router.get('/rh/sorties', authorize(ROLES.RH), validate(z.object({
  statut: z.enum(ABSENCE_STATUTS).optional(), site: z.string().trim().max(80).optional(),
  departement: z.string().trim().max(80).optional(), q: z.string().trim().max(100).optional(), ...paginationSchema,
}), 'query'), async (req, res) => {
  const f = req.valid.query;
  const where = [];
  const params = [];
  if (f.statut) { where.push('s.statut = ?'); params.push(f.statut); }
  if (f.site) { where.push('u.site = ?'); params.push(f.site); }
  if (f.departement) { where.push('u.departement = ?'); params.push(f.departement); }
  if (f.q) {
    where.push('(s.numero LIKE ? OR u.nom LIKE ? OR u.prenom LIKE ? OR u.matricule LIKE ?)');
    const like = `%${f.q.replace(/[\\%_]/g, '\\$&')}%`;
    params.push(like, like, like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const from = `FROM sorties_demandes s JOIN users u ON u.id = s.user_id JOIN sorties_motifs m ON m.id = s.motif_id ${whereSql}`;
  const { limit, offset } = paginate(f);
  const [rows, count] = await Promise.all([
    query(
      `SELECT s.id, s.numero, s.date_sortie, s.heure_debut, s.heure_fin, s.duree_minutes, s.statut, s.date_creation,
              m.libelle AS motif_libelle, u.matricule, u.nom, u.prenom, u.service, u.departement, u.site, u.societe
       ${from} ORDER BY (s.statut = 'EN_ATTENTE') DESC, s.date_creation DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    ),
    queryOne(`SELECT COUNT(*) AS n ${from}`, params),
  ]);
  res.json(paged(rows, count.n, f));
});

router.patch('/rh/sorties/:id/statut', authorize(ROLES.RH), validate(idParamSchema, 'params'), validate(z.object({
  statut: z.enum(['VALIDE', 'REFUSE', 'ANNULE'], { error: 'Statut invalide' }),
  motif_refus: z.string().trim().max(500).optional().transform((v) => v || null),
})), async (req, res) => {
  const { id } = req.valid.params;
  const { statut, motif_refus } = req.body;
  const s = await loadSortie(id);
  if (s.statut !== 'EN_ATTENTE' && statut !== 'ANNULE') throw conflict('Seule une demande en attente peut être validée ou refusée');
  await query('UPDATE sorties_demandes SET statut = ?, motif_refus = ?, traite_par = ?, date_traitement = NOW() WHERE id = ?', [statut, motif_refus, req.user.id, id]);
  await audit(req, 'SORTIE_STATUT_CHANGEMENT', { entite: 'sorties_demandes', entiteId: id, details: { de: s.statut, vers: statut } });
  if (statut !== 'ANNULE') {
    const label = LABELS.statut_absence[statut];
    await notifyUsers([s.user_id], {
      type: `SORTIE_${statut}`, titre: `Sortie ${s.numero} : ${label}`,
      message: statut === 'REFUSE' && motif_refus ? `Motif : ${motif_refus}` : `Votre demande de sortie a été ${label.toLowerCase()}.`,
      lien: sortieLinkEmploye(id),
    });
  }
  res.json({ data: { statut } });
});

// ---- Paramétrage : motifs ----
router.get('/rh/sorties/motifs', authorize(ROLES.RH), async (_req, res) => {
  res.json({ data: await query('SELECT id, libelle, actif, ordre FROM sorties_motifs ORDER BY ordre, libelle') });
});

router.post('/rh/sorties/motifs', authorize(ROLES.RH), validate(z.object({
  libelle: z.string({ error: 'Le libellé est obligatoire' }).trim().min(2).max(100),
})), async (req, res) => {
  try {
    const [result] = await pool.query('INSERT INTO sorties_motifs (libelle, ordre) VALUES (?, 99)', [req.body.libelle]);
    await audit(req, 'SORTIE_MOTIF_CREATION', { entite: 'sorties_motifs', entiteId: result.insertId });
    res.status(201).json({ data: { id: result.insertId } });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw conflict('Ce motif existe déjà');
    throw err;
  }
});

router.patch('/rh/sorties/motifs/:id', authorize(ROLES.RH), validate(idParamSchema, 'params'), validate(z.object({
  libelle: z.string({ error: 'Le libellé est obligatoire' }).trim().min(2).max(100),
  actif: z.coerce.boolean(),
})), async (req, res) => {
  const { id } = req.valid.params;
  if (!(await queryOne('SELECT id FROM sorties_motifs WHERE id = ?', [id]))) throw notFound('Motif introuvable');
  await query('UPDATE sorties_motifs SET libelle = ?, actif = ? WHERE id = ?', [req.body.libelle, req.body.actif ? 1 : 0, id]);
  await audit(req, 'SORTIE_MOTIF_MODIFICATION', { entite: 'sorties_motifs', entiteId: id });
  res.json({ data: await queryOne('SELECT id, libelle, actif, ordre FROM sorties_motifs WHERE id = ?', [id]) });
});

router.delete('/rh/sorties/motifs/:id', authorize(ROLES.RH), validate(idParamSchema, 'params'), async (req, res) => {
  const { id } = req.valid.params;
  const used = await queryOne('SELECT COUNT(*) AS n FROM sorties_demandes WHERE motif_id = ?', [id]);
  if (used.n > 0) throw conflict('Ce motif est déjà utilisé : le désactiver à la place');
  await query('DELETE FROM sorties_motifs WHERE id = ?', [id]);
  await audit(req, 'SORTIE_MOTIF_SUPPRESSION', { entite: 'sorties_motifs', entiteId: id });
  res.status(204).end();
});

// ---- Tableau RH ----
router.get('/rh/sorties/dashboard', authorize(ROLES.RH), async (_req, res) => {
  const [kpi, parService, parSociete] = await Promise.all([
    queryOne(
      `SELECT CAST(COALESCE(SUM(statut = 'EN_ATTENTE'), 0) AS SIGNED) AS en_attente,
              CAST(COALESCE(SUM(statut = 'VALIDE'), 0) AS SIGNED) AS validees,
              CAST(COALESCE(SUM(statut = 'REFUSE'), 0) AS SIGNED) AS refusees,
              CAST(COALESCE(SUM(CASE WHEN statut = 'VALIDE' THEN duree_minutes END), 0) AS SIGNED) AS temps_total_minutes
       FROM sorties_demandes`,
    ),
    query(
      `SELECT u.service, COUNT(*) AS total, CAST(COALESCE(SUM(s.duree_minutes), 0) AS SIGNED) AS minutes
       FROM sorties_demandes s JOIN users u ON u.id = s.user_id WHERE s.statut = 'VALIDE' GROUP BY u.service ORDER BY minutes DESC`,
    ),
    query(
      `SELECT COALESCE(u.societe, 'Non renseignée') AS societe, COUNT(*) AS total, CAST(COALESCE(SUM(s.duree_minutes), 0) AS SIGNED) AS minutes
       FROM sorties_demandes s JOIN users u ON u.id = s.user_id WHERE s.statut = 'VALIDE' GROUP BY societe ORDER BY minutes DESC`,
    ),
  ]);
  res.json({ data: { kpi, par_service: parService, par_societe: parSociete } });
});

// ---- Analyse IA ----
router.get('/rh/sorties/analyse', authorize(ROLES.RH), async (_req, res) => {
  const alertes = [];

  const frequents = await query(
    `SELECT u.nom, u.prenom, u.service, COUNT(*) AS nb FROM sorties_demandes s JOIN users u ON u.id = s.user_id
     WHERE s.statut = 'VALIDE' AND s.date_creation >= NOW() - INTERVAL 30 DAY GROUP BY s.user_id HAVING nb >= 4 ORDER BY nb DESC LIMIT 20`,
  );
  for (const u of frequents) alertes.push({ niveau: 'INFO', categorie: 'UTILISATEUR_FREQUENT', message: `${u.prenom} ${u.nom} (${u.service}) : ${u.nb} sorties validées ce mois-ci` });

  const anormales = await query(
    `SELECT s.numero, u.nom, u.prenom, s.duree_minutes FROM sorties_demandes s JOIN users u ON u.id = s.user_id
     WHERE s.statut = 'VALIDE' AND s.duree_minutes > 180 AND s.date_creation >= NOW() - INTERVAL 30 DAY ORDER BY s.duree_minutes DESC LIMIT 20`,
  );
  for (const s of anormales) {
    const h = Math.floor(s.duree_minutes / 60);
    const m = s.duree_minutes % 60;
    alertes.push({ niveau: 'ATTENTION', categorie: 'DUREE_ANORMALE', message: `${s.numero} — ${s.prenom} ${s.nom} : durée de ${h} h ${m}` });
  }

  const motifsFrequents = await query(
    `SELECT m.libelle, COUNT(*) AS nb FROM sorties_demandes s JOIN sorties_motifs m ON m.id = s.motif_id
     WHERE s.date_creation >= NOW() - INTERVAL 30 DAY GROUP BY m.libelle ORDER BY nb DESC LIMIT 5`,
  );

  res.json({ data: { alertes, motifs_frequents: motifsFrequents } });
});

export default router;
