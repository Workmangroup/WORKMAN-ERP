import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { pool, query, queryOne, transaction } from '../../config/db.js';
import { ABSENCE_STATUTS, LABELS, ROLES } from '../../config/constants.js';
import { authenticate, authorize } from '../../middlewares/auth.js';
import { createScopedUpload, removeUploaded } from '../../middlewares/upload.js';
import { validate } from '../../middlewares/validate.js';
import { notifyRole, notifyUsers } from '../../services/notification.service.js';
import { audit } from '../../utils/audit.js';
import { badRequest, conflict, notFound } from '../../utils/httpError.js';
import { nextNumero } from '../../utils/numbering.js';
import { paged, paginate, paginationSchema } from '../../utils/pagination.js';
import { idParamSchema } from '../tickets/tickets.schemas.js';

/*
 * MODULE 3 — Déclaration des retards.
 * Workflow : Collaborateur → RH → Validé/Refusé.
 */

const router = Router();
router.use(authenticate);

const retardUpload = createScopedUpload(['.pdf', '.jpg', '.jpeg', '.png', '.doc', '.docx', '.zip'], 'PDF, JPG, PNG, DOC, DOCX, ZIP');
const IDENTITY_COLS = 'u.matricule, u.nom, u.prenom, u.email, u.telephone';
const ORGA_COLS = 'u.service, u.departement, u.site';
const SEUILS_AUTORISES = [3, 5, 10];
const fmtFr = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString('fr-FR');
const retardLinkEmploye = (id) => `/employe/retards/?id=${id}`;
const retardLinkRh = (id) => `/rh/retards/?id=${id}`;

async function loadRetard(id) {
  const r = await queryOne('SELECT r.*, m.libelle AS motif_libelle FROM retards_declarations r JOIN retards_motifs m ON m.id = r.motif_id WHERE r.id = ?', [id]);
  if (!r) throw notFound('Déclaration de retard introuvable');
  return r;
}
function shapeRetard(r) {
  return { ...r, has_piece_jointe: Boolean(r.piece_jointe), piece_jointe: undefined };
}

router.get('/retards/motifs', async (_req, res) => {
  res.json({ data: await query('SELECT id, libelle FROM retards_motifs WHERE actif = 1 ORDER BY ordre, libelle') });
});

router.get('/me/retards', async (req, res) => {
  res.json({ data: await query(
    `SELECT r.id, r.numero, r.date_retard, r.heure_arrivee, r.statut, r.motif_refus, r.date_creation, m.libelle AS motif_libelle,
            (r.piece_jointe IS NOT NULL) AS has_piece_jointe
     FROM retards_declarations r JOIN retards_motifs m ON m.id = r.motif_id WHERE r.user_id = ? ORDER BY r.date_creation DESC`,
    [req.user.id],
  ) });
});

router.get('/retards/:id', validate(idParamSchema, 'params'), async (req, res) => {
  const { id } = req.valid.params;
  const r = await loadRetard(id);
  const isRh = req.user.role === ROLES.RH;
  if (!isRh && r.user_id !== req.user.id) throw notFound('Déclaration de retard introuvable');
  if (isRh) r.auteur = await queryOne(`SELECT ${IDENTITY_COLS}, ${ORGA_COLS} FROM users u WHERE u.id = ?`, [r.user_id]);
  res.json({ data: shapeRetard(r) });
});

const retardCreateSchema = z.object({
  motif_id: z.coerce.number().int().positive({ error: 'Motif invalide' }),
  date_retard: z.iso.date({ error: 'Date invalide' }),
  heure_arrivee: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Heure d'arrivée invalide (format HH:MM)"),
  commentaire: z.string().trim().max(2000).optional().transform((v) => v || null),
});

router.post('/retards', retardUpload.single('piece_jointe'), async (req, res) => {
  let data;
  try {
    data = retardCreateSchema.parse(req.body ?? {});
  } catch (err) {
    removeUploaded(req.file);
    throw err;
  }
  if (!(await queryOne('SELECT 1 FROM retards_motifs WHERE id = ? AND actif = 1', [data.motif_id]))) {
    removeUploaded(req.file);
    throw badRequest('Motif invalide');
  }
  if (data.date_retard > new Date().toISOString().slice(0, 10)) {
    removeUploaded(req.file);
    throw badRequest('La date ne peut pas être dans le futur');
  }

  let id;
  let numero;
  try {
    ({ id, numero } = await transaction(async (conn) => {
      const numero = await nextNumero(conn, 'RET');
      const [result] = await conn.query(
        `INSERT INTO retards_declarations (numero, user_id, date_retard, heure_arrivee, motif_id, commentaire, piece_jointe, piece_jointe_nom, piece_jointe_mime)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [numero, req.user.id, data.date_retard, data.heure_arrivee, data.motif_id, data.commentaire,
         req.file?.filename ?? null, req.file?.originalname?.slice(0, 255) ?? null, req.file?.mimetype ?? null],
      );
      return { id: result.insertId, numero };
    }));
  } catch (err) {
    removeUploaded(req.file);
    throw err;
  }

  await audit(req, 'RETARD_CREATION', { entite: 'retards_declarations', entiteId: id, details: { numero } });
  await notifyRole(ROLES.RH, {
    type: 'NOUVEAU_RETARD', titre: `Déclaration de retard ${numero}`,
    message: `Le ${fmtFr(data.date_retard)}, arrivée à ${data.heure_arrivee}`, lien: retardLinkRh(id),
  }, { excludeUserId: req.user.id });
  res.status(201).json({ data: { id, numero } });
});

router.post('/retards/:id/annuler', validate(idParamSchema, 'params'), async (req, res) => {
  const { id } = req.valid.params;
  const r = await loadRetard(id);
  if (r.user_id !== req.user.id) throw notFound('Déclaration de retard introuvable');
  if (r.statut !== 'EN_ATTENTE') throw conflict('Seule une déclaration en attente peut être annulée');
  await query("UPDATE retards_declarations SET statut = 'ANNULE' WHERE id = ?", [id]);
  await audit(req, 'RETARD_ANNULATION_COLLABORATEUR', { entite: 'retards_declarations', entiteId: id });
  res.json({ data: { statut: 'ANNULE' } });
});

router.get('/retards/:id/piece-jointe', validate(idParamSchema, 'params'), async (req, res, next) => {
  const { id } = req.valid.params;
  const r = await loadRetard(id);
  if (req.user.role !== ROLES.RH && r.user_id !== req.user.id) throw notFound('Déclaration de retard introuvable');
  if (!r.piece_jointe) throw notFound('Aucune pièce jointe');
  await audit(req, 'RETARD_PIECE_JOINTE_TELECHARGEMENT', { entite: 'retards_declarations', entiteId: id });
  res.download(path.join(env.uploadDir, path.basename(r.piece_jointe)), r.piece_jointe_nom ?? 'piece-jointe', (err) => {
    if (err && !res.headersSent) next(notFound('Fichier introuvable sur le serveur'));
  });
});

// ---------------------------------------------------------------- RH

router.get('/rh/retards', authorize(ROLES.RH), validate(z.object({
  statut: z.enum(ABSENCE_STATUTS).optional(), site: z.string().trim().max(80).optional(),
  departement: z.string().trim().max(80).optional(), q: z.string().trim().max(100).optional(), ...paginationSchema,
}), 'query'), async (req, res) => {
  const f = req.valid.query;
  const where = [];
  const params = [];
  if (f.statut) { where.push('r.statut = ?'); params.push(f.statut); }
  if (f.site) { where.push('u.site = ?'); params.push(f.site); }
  if (f.departement) { where.push('u.departement = ?'); params.push(f.departement); }
  if (f.q) {
    where.push('(r.numero LIKE ? OR u.nom LIKE ? OR u.prenom LIKE ? OR u.matricule LIKE ?)');
    const like = `%${f.q.replace(/[\\%_]/g, '\\$&')}%`;
    params.push(like, like, like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const from = `FROM retards_declarations r JOIN users u ON u.id = r.user_id JOIN retards_motifs m ON m.id = r.motif_id ${whereSql}`;
  const { limit, offset } = paginate(f);
  const [rows, count] = await Promise.all([
    query(
      `SELECT r.id, r.numero, r.date_retard, r.heure_arrivee, r.statut, r.date_creation, m.libelle AS motif_libelle,
              u.matricule, u.nom, u.prenom, u.service, u.departement, u.site, (r.piece_jointe IS NOT NULL) AS has_piece_jointe
       ${from} ORDER BY (r.statut = 'EN_ATTENTE') DESC, r.date_creation DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    ),
    queryOne(`SELECT COUNT(*) AS n ${from}`, params),
  ]);
  res.json(paged(rows, count.n, f));
});

router.patch('/rh/retards/:id/statut', authorize(ROLES.RH), validate(idParamSchema, 'params'), validate(z.object({
  statut: z.enum(['VALIDE', 'REFUSE', 'ANNULE'], { error: 'Statut invalide' }),
  motif_refus: z.string().trim().max(500).optional().transform((v) => v || null),
})), async (req, res) => {
  const { id } = req.valid.params;
  const { statut, motif_refus } = req.body;
  const r = await loadRetard(id);
  if (r.statut !== 'EN_ATTENTE' && statut !== 'ANNULE') throw conflict('Seule une déclaration en attente peut être validée ou refusée');
  await query('UPDATE retards_declarations SET statut = ?, motif_refus = ?, traite_par = ?, date_traitement = NOW() WHERE id = ?', [statut, motif_refus, req.user.id, id]);
  await audit(req, 'RETARD_STATUT_CHANGEMENT', { entite: 'retards_declarations', entiteId: id, details: { de: r.statut, vers: statut } });
  if (statut !== 'ANNULE') {
    const label = LABELS.statut_absence[statut];
    await notifyUsers([r.user_id], {
      type: `RETARD_${statut}`, titre: `Retard ${r.numero} : ${label}`,
      message: statut === 'REFUSE' && motif_refus ? `Motif : ${motif_refus}` : `Votre déclaration de retard a été ${label.toLowerCase()}.`,
      lien: retardLinkEmploye(id),
    });
  }
  res.json({ data: { statut } });
});

// ---- Paramétrage : motifs ----
router.get('/rh/retards/motifs', authorize(ROLES.RH), async (_req, res) => {
  res.json({ data: await query('SELECT id, libelle, actif, ordre FROM retards_motifs ORDER BY ordre, libelle') });
});

router.post('/rh/retards/motifs', authorize(ROLES.RH), validate(z.object({
  libelle: z.string({ error: 'Le libellé est obligatoire' }).trim().min(2).max(100),
})), async (req, res) => {
  try {
    const [result] = await pool.query('INSERT INTO retards_motifs (libelle, ordre) VALUES (?, 99)', [req.body.libelle]);
    await audit(req, 'RETARD_MOTIF_CREATION', { entite: 'retards_motifs', entiteId: result.insertId });
    res.status(201).json({ data: { id: result.insertId } });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw conflict('Ce motif existe déjà');
    throw err;
  }
});

router.patch('/rh/retards/motifs/:id', authorize(ROLES.RH), validate(idParamSchema, 'params'), validate(z.object({
  libelle: z.string({ error: 'Le libellé est obligatoire' }).trim().min(2).max(100),
  actif: z.coerce.boolean(),
})), async (req, res) => {
  const { id } = req.valid.params;
  if (!(await queryOne('SELECT id FROM retards_motifs WHERE id = ?', [id]))) throw notFound('Motif introuvable');
  await query('UPDATE retards_motifs SET libelle = ?, actif = ? WHERE id = ?', [req.body.libelle, req.body.actif ? 1 : 0, id]);
  await audit(req, 'RETARD_MOTIF_MODIFICATION', { entite: 'retards_motifs', entiteId: id });
  res.json({ data: await queryOne('SELECT id, libelle, actif, ordre FROM retards_motifs WHERE id = ?', [id]) });
});

router.delete('/rh/retards/motifs/:id', authorize(ROLES.RH), validate(idParamSchema, 'params'), async (req, res) => {
  const { id } = req.valid.params;
  const used = await queryOne('SELECT COUNT(*) AS n FROM retards_declarations WHERE motif_id = ?', [id]);
  if (used.n > 0) throw conflict('Ce motif est déjà utilisé : le désactiver à la place');
  await query('DELETE FROM retards_motifs WHERE id = ?', [id]);
  await audit(req, 'RETARD_MOTIF_SUPPRESSION', { entite: 'retards_motifs', entiteId: id });
  res.status(204).end();
});

// ---- Tableau RH ----
router.get('/rh/retards/dashboard', authorize(ROLES.RH), async (_req, res) => {
  const [kpi, evolutionMensuelle, parService] = await Promise.all([
    queryOne(
      `SELECT CAST(COALESCE(SUM(statut = 'EN_ATTENTE'), 0) AS SIGNED) AS en_attente,
              CAST(COALESCE(SUM(statut = 'VALIDE'), 0) AS SIGNED) AS valides,
              CAST(COALESCE(SUM(statut = 'REFUSE'), 0) AS SIGNED) AS refuses
       FROM retards_declarations`,
    ),
    query(
      `SELECT DATE_FORMAT(date_retard, '%Y-%m') AS mois, COUNT(*) AS total FROM retards_declarations
       WHERE statut = 'VALIDE' AND date_retard >= CURDATE() - INTERVAL 12 MONTH GROUP BY mois ORDER BY mois`,
    ),
    query(
      `SELECT u.service, COUNT(*) AS total FROM retards_declarations r JOIN users u ON u.id = r.user_id
       WHERE r.statut = 'VALIDE' GROUP BY u.service ORDER BY total DESC`,
    ),
  ]);
  res.json({ data: { kpi, evolution_mensuelle: evolutionMensuelle, par_service: parService } });
});

// ---- Analyse IA ----
router.get('/rh/retards/analyse', authorize(ROLES.RH), validate(z.object({ seuil: z.coerce.number().int().optional() }), 'query'), async (req, res) => {
  let seuil = req.valid.query.seuil ?? 3;
  if (!SEUILS_AUTORISES.includes(seuil)) seuil = 3;

  const [topCollaborateurs, parService, heuresCritiques, causesRecurrentes, evolutionAnnuelle, evolutionMensuelle, parMotifTransport] = await Promise.all([
    query(
      `SELECT u.nom, u.prenom, u.service, COUNT(*) AS nb FROM retards_declarations r JOIN users u ON u.id = r.user_id
       WHERE r.statut = 'VALIDE' AND r.date_retard >= CURDATE() - INTERVAL 90 DAY
       GROUP BY r.user_id HAVING nb >= ? ORDER BY nb DESC LIMIT 20`,
      [seuil],
    ),
    query(
      `SELECT u.service, COUNT(*) AS nb FROM retards_declarations r JOIN users u ON u.id = r.user_id
       WHERE r.statut = 'VALIDE' AND r.date_retard >= CURDATE() - INTERVAL 90 DAY GROUP BY u.service ORDER BY nb DESC LIMIT 10`,
    ),
    query(
      `SELECT HOUR(heure_arrivee) AS heure, COUNT(*) AS nb FROM retards_declarations
       WHERE statut = 'VALIDE' AND date_retard >= CURDATE() - INTERVAL 90 DAY GROUP BY heure ORDER BY nb DESC LIMIT 5`,
    ),
    query(
      `SELECT m.libelle, COUNT(*) AS nb FROM retards_declarations r JOIN retards_motifs m ON m.id = r.motif_id
       WHERE r.statut = 'VALIDE' AND r.date_retard >= CURDATE() - INTERVAL 90 DAY GROUP BY m.libelle ORDER BY nb DESC LIMIT 10`,
    ),
    query(`SELECT YEAR(date_retard) AS annee, COUNT(*) AS nb FROM retards_declarations WHERE statut = 'VALIDE' GROUP BY annee ORDER BY annee`),
    query(
      `SELECT DATE_FORMAT(date_retard, '%Y-%m') AS mois, COUNT(*) AS nb FROM retards_declarations
       WHERE statut = 'VALIDE' AND date_retard >= CURDATE() - INTERVAL 12 MONTH GROUP BY mois ORDER BY mois`,
    ),
    queryOne(
      `SELECT COUNT(*) AS nb FROM retards_declarations r JOIN retards_motifs m ON m.id = r.motif_id
       WHERE r.statut = 'VALIDE' AND m.libelle IN ('Embouteillage', 'Transport public') AND r.date_retard >= DATE_FORMAT(CURDATE(), '%Y-%m-01')`,
    ),
  ]);

  const alertes = topCollaborateurs.map((u) => ({
    niveau: 'ATTENTION', categorie: 'COLLABORATEUR_SEUIL',
    message: `${u.prenom} ${u.nom} (${u.service}) : ${u.nb} retards sur les 90 derniers jours — seuil de ${seuil} dépassé`,
  }));
  if (Number(parMotifTransport.nb) >= 5) {
    alertes.push({ niveau: 'INFO', categorie: 'CAUSE_TRANSPORT', message: `${parMotifTransport.nb} retards liés au transport ce mois-ci` });
  }

  res.json({ data: {
    seuil, top_collaborateurs: topCollaborateurs, par_service: parService, heures_critiques: heuresCritiques,
    causes_recurrentes: causesRecurrentes, evolution_annuelle: evolutionAnnuelle, evolution_mensuelle: evolutionMensuelle, alertes,
  } });
});

export default router;
