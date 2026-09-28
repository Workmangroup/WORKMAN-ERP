import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { pool, query, queryOne, transaction } from '../../config/db.js';
import { CONGE_STATUTS, ROLES } from '../../config/constants.js';
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
 * MODULE 1 — Gestion des congés.
 * Workflow : Collaborateur → RH → Validé/Refusé → Notification.
 * Le solde n'est décompté qu'à la VALIDATION (jamais à la création), et
 * chaque mouvement de solde est historisé dans conges_mouvements.
 */

const router = Router();
router.use(authenticate);

const congeUpload = createScopedUpload(['.pdf', '.jpg', '.jpeg', '.png', '.docx'], 'PDF, JPG, PNG, DOCX');
const CONGE_ACTIFS = ['BROUILLON', 'EN_ATTENTE', 'VALIDE'];
const IDENTITY_COLS = 'u.matricule, u.nom, u.prenom, u.email, u.telephone';
const ORGA_COLS = 'u.service, u.departement, u.site';

const fmtFr = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString('fr-FR');
const congeLinkEmploye = (id) => `/employe/conges/?id=${id}`;
const congeLinkRh = (id) => `/rh/conges/?id=${id}`;

async function typesActifs() {
  return query('SELECT id, code, libelle, deduit_solde, ordre FROM conges_types WHERE actif = 1 ORDER BY ordre, libelle');
}

async function joursFeriesSet(debut, fin) {
  const rows = await query('SELECT date_ferie FROM jours_feries WHERE date_ferie BETWEEN ? AND ?', [debut, fin]);
  return new Set(rows.map((r) => new Date(r.date_ferie).toISOString().slice(0, 10)));
}

/** Nombre de jours ouvrés (hors samedi, dimanche, jours fériés configurés). */
async function computeJoursOuvres(debut, fin) {
  const feries = await joursFeriesSet(debut, fin);
  let n = 0;
  const cursor = new Date(`${debut}T00:00:00`);
  const end = new Date(`${fin}T00:00:00`);
  while (cursor <= end) {
    const jour = cursor.getDay(); // 0 = dimanche, 6 = samedi
    if (jour !== 0 && jour !== 6 && !feries.has(cursor.toISOString().slice(0, 10))) n++;
    cursor.setDate(cursor.getDate() + 1);
  }
  return n;
}

async function overlapExists(userId, debut, fin, excludeId = null) {
  const params = [userId, ...CONGE_ACTIFS, fin, debut];
  let sql = `SELECT 1 FROM conges_demandes WHERE user_id = ? AND statut IN (${CONGE_ACTIFS.map(() => '?').join(',')})
             AND date_debut <= ? AND date_fin >= ?`;
  if (excludeId) { sql += ' AND id <> ?'; params.push(excludeId); }
  return Boolean(await queryOne(`${sql} LIMIT 1`, params));
}

async function loadConge(id) {
  const d = await queryOne(
    `SELECT d.*, t.code AS type_code, t.libelle AS type_libelle, t.deduit_solde
     FROM conges_demandes d JOIN conges_types t ON t.id = d.type_id WHERE d.id = ?`,
    [id],
  );
  if (!d) throw notFound('Demande de congé introuvable');
  return d;
}

function shapeConge(d) {
  return { ...d, deduit_solde: Boolean(d.deduit_solde), has_piece_jointe: Boolean(d.piece_jointe), piece_jointe: undefined };
}

// ---------------------------------------------------------------- Référentiels

router.get('/conges/types', async (_req, res) => {
  res.json({ data: await typesActifs() });
});

router.post(
  '/conges/calcul-jours',
  validate(z.object({ date_debut: z.iso.date(), date_fin: z.iso.date() })),
  async (req, res) => {
    const { date_debut, date_fin } = req.body;
    if (date_fin < date_debut) throw badRequest('La date de fin doit être postérieure ou égale à la date de début');
    res.json({ data: { nb_jours: await computeJoursOuvres(date_debut, date_fin) } });
  },
);

// ---------------------------------------------------------------- Collaborateur

router.get('/me/conges', async (req, res) => {
  res.json({ data: await query(
    `SELECT d.id, d.numero, d.date_debut, d.date_fin, d.nb_jours, d.statut, d.motif_refus, d.date_creation, d.date_traitement,
            t.code AS type_code, t.libelle AS type_libelle
     FROM conges_demandes d JOIN conges_types t ON t.id = d.type_id
     WHERE d.user_id = ? ORDER BY d.date_creation DESC`,
    [req.user.id],
  ) });
});

router.get('/me/solde-conges', async (req, res) => {
  const user = await queryOne('SELECT solde_conge_initial, solde_conge_actuel FROM users WHERE id = ?', [req.user.id]);
  const historique = await query(
    `SELECT m.id, m.type, m.jours, m.solde_apres, m.commentaire, m.date_creation, d.numero
     FROM conges_mouvements m LEFT JOIN conges_demandes d ON d.id = m.demande_id
     WHERE m.user_id = ? ORDER BY m.date_creation DESC LIMIT 50`,
    [req.user.id],
  );
  res.json({ data: { solde_initial: Number(user.solde_conge_initial), solde_actuel: Number(user.solde_conge_actuel), historique } });
});

router.get('/conges/:id', validate(idParamSchema, 'params'), async (req, res) => {
  const { id } = req.valid.params;
  const d = await loadConge(id);
  const isRh = req.user.role === ROLES.RH;
  if (!isRh && d.user_id !== req.user.id) throw notFound('Demande de congé introuvable');
  if (isRh) d.auteur = await queryOne(`SELECT ${IDENTITY_COLS}, ${ORGA_COLS} FROM users u WHERE u.id = ?`, [d.user_id]);
  res.json({ data: shapeConge(d) });
});

const congeCreateSchema = z.object({
  type_id: z.coerce.number().int().positive({ error: 'Type de congé invalide' }),
  date_debut: z.iso.date({ error: 'Date de début invalide' }),
  date_fin: z.iso.date({ error: 'Date de fin invalide' }),
  commentaire: z.string().trim().max(2000).optional().transform((v) => v || null),
});

router.post('/conges', congeUpload.single('piece_jointe'), async (req, res) => {
  let data;
  try {
    data = congeCreateSchema.parse(req.body ?? {});
  } catch (err) {
    removeUploaded(req.file);
    throw err;
  }
  const user = req.user;

  const type = await queryOne('SELECT id, deduit_solde FROM conges_types WHERE id = ? AND actif = 1', [data.type_id]);
  if (!type) { removeUploaded(req.file); throw badRequest('Type de congé invalide'); }
  if (data.date_fin < data.date_debut) { removeUploaded(req.file); throw badRequest('La date de fin doit être postérieure ou égale à la date de début'); }
  const today = new Date().toISOString().slice(0, 10);
  if (data.date_debut < today) { removeUploaded(req.file); throw badRequest('La date de début ne peut pas être dans le passé'); }
  if (await overlapExists(user.id, data.date_debut, data.date_fin)) {
    removeUploaded(req.file);
    throw conflict('Vous avez déjà une demande de congé sur cette période (chevauchement)');
  }
  const doublon = await queryOne(
    `SELECT 1 FROM conges_demandes WHERE user_id = ? AND type_id = ? AND date_debut = ? AND date_fin = ?
     AND statut IN (${CONGE_ACTIFS.map(() => '?').join(',')}) LIMIT 1`,
    [user.id, data.type_id, data.date_debut, data.date_fin, ...CONGE_ACTIFS],
  );
  if (doublon) { removeUploaded(req.file); throw conflict('Une demande identique existe déjà'); }

  const nbJours = await computeJoursOuvres(data.date_debut, data.date_fin);
  if (nbJours <= 0) { removeUploaded(req.file); throw badRequest('La période sélectionnée ne contient aucun jour ouvré'); }
  const soldeActuel = await queryOne('SELECT solde_conge_actuel FROM users WHERE id = ?', [user.id]);
  if (type.deduit_solde && nbJours > Number(soldeActuel.solde_conge_actuel) + 0.001) {
    removeUploaded(req.file);
    throw conflict(`Solde de congé insuffisant : ${soldeActuel.solde_conge_actuel} jour(s) disponible(s) pour ${nbJours} demandé(s)`);
  }

  let id;
  let numero;
  try {
    ({ id, numero } = await transaction(async (conn) => {
      const numero = await nextNumero(conn, 'CNG');
      const [res] = await conn.query(
        `INSERT INTO conges_demandes (numero, user_id, type_id, date_debut, date_fin, nb_jours, commentaire, piece_jointe, piece_jointe_nom, piece_jointe_mime)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [numero, user.id, data.type_id, data.date_debut, data.date_fin, nbJours, data.commentaire,
         req.file?.filename ?? null, req.file?.originalname?.slice(0, 255) ?? null, req.file?.mimetype ?? null],
      );
      return { id: res.insertId, numero };
    }));
  } catch (err) {
    removeUploaded(req.file);
    throw err;
  }

  await audit(req, 'CONGE_CREATION', { entite: 'conges_demandes', entiteId: id, details: { numero } });
  await notifyRole(ROLES.RH, {
    type: 'NOUVELLE_DEMANDE_CONGE',
    titre: `Nouvelle demande de congé ${numero}`,
    message: `Demande du ${fmtFr(data.date_debut)} au ${fmtFr(data.date_fin)} (${nbJours} j)`,
    lien: congeLinkRh(id),
  }, { excludeUserId: user.id });
  res.status(201).json({ data: { id, numero, nb_jours: nbJours } });
});

router.post('/conges/:id/annuler', validate(idParamSchema, 'params'), async (req, res) => {
  const { id } = req.valid.params;
  const d = await loadConge(id);
  if (d.user_id !== req.user.id) throw notFound('Demande de congé introuvable');
  if (!['BROUILLON', 'EN_ATTENTE'].includes(d.statut)) throw conflict('Seule une demande en attente peut être annulée par le collaborateur');
  await query("UPDATE conges_demandes SET statut = 'ANNULE' WHERE id = ?", [id]);
  await audit(req, 'CONGE_ANNULATION_COLLABORATEUR', { entite: 'conges_demandes', entiteId: id });
  await notifyRole(ROLES.RH, {
    type: 'CONGE_ANNULE', titre: `Demande de congé ${d.numero} annulée`,
    message: 'Le collaborateur a annulé sa demande.', lien: congeLinkRh(id),
  }, { excludeUserId: req.user.id, email: false });
  res.json({ data: { statut: 'ANNULE' } });
});

router.get('/conges/:id/piece-jointe', validate(idParamSchema, 'params'), async (req, res, next) => {
  const { id } = req.valid.params;
  const d = await loadConge(id);
  if (req.user.role !== ROLES.RH && d.user_id !== req.user.id) throw notFound('Demande de congé introuvable');
  if (!d.piece_jointe) throw notFound('Aucune pièce jointe');
  await audit(req, 'CONGE_PIECE_JOINTE_TELECHARGEMENT', { entite: 'conges_demandes', entiteId: id });
  res.download(path.join(env.uploadDir, path.basename(d.piece_jointe)), d.piece_jointe_nom ?? 'piece-jointe', (err) => {
    if (err && !res.headersSent) next(notFound('Fichier introuvable sur le serveur'));
  });
});

// ---------------------------------------------------------------- RH



router.get('/rh/conges', authorize(ROLES.RH), validate(z.object({
  statut: z.enum(CONGE_STATUTS).optional(), type_id: z.coerce.number().int().positive().optional(),
  site: z.string().trim().max(80).optional(), departement: z.string().trim().max(80).optional(),
  q: z.string().trim().max(100).optional(), ...paginationSchema,
}), 'query'), async (req, res) => {
  const f = req.valid.query;
  const where = [];
  const params = [];
  if (f.statut) { where.push('d.statut = ?'); params.push(f.statut); }
  if (f.type_id) { where.push('d.type_id = ?'); params.push(f.type_id); }
  if (f.site) { where.push('u.site = ?'); params.push(f.site); }
  if (f.departement) { where.push('u.departement = ?'); params.push(f.departement); }
  if (f.q) {
    where.push('(d.numero LIKE ? OR u.nom LIKE ? OR u.prenom LIKE ? OR u.matricule LIKE ?)');
    const like = `%${f.q.replace(/[\\%_]/g, '\\$&')}%`;
    params.push(like, like, like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const from = `FROM conges_demandes d JOIN users u ON u.id = d.user_id JOIN conges_types t ON t.id = d.type_id ${whereSql}`;
  const { limit, offset } = paginate(f);
  const [rows, count] = await Promise.all([
    query(
      `SELECT d.id, d.numero, d.date_debut, d.date_fin, d.nb_jours, d.statut, d.date_creation,
              t.code AS type_code, t.libelle AS type_libelle,
              u.matricule, u.nom, u.prenom, u.service, u.departement, u.site
       ${from} ORDER BY (d.statut = 'EN_ATTENTE') DESC, d.date_creation DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    ),
    queryOne(`SELECT COUNT(*) AS n ${from}`, params),
  ]);
  res.json(paged(rows, count.n, f));
});

router.patch('/rh/conges/:id/statut', authorize(ROLES.RH), validate(idParamSchema, 'params'), validate(z.object({
  statut: z.enum(['VALIDE', 'REFUSE', 'ANNULE'], { error: 'Statut invalide' }),
  motif_refus: z.string().trim().max(500).optional().transform((v) => v || null),
})), async (req, res) => {
  const { id } = req.valid.params;
  const { statut, motif_refus } = req.body;
  const d = await loadConge(id);

  if (statut === 'VALIDE') {
    if (!['BROUILLON', 'EN_ATTENTE'].includes(d.statut)) throw conflict('Seule une demande en attente peut être validée');
    const user = await queryOne('SELECT solde_conge_actuel FROM users WHERE id = ?', [d.user_id]);
    if (d.deduit_solde && Number(user.solde_conge_actuel) < Number(d.nb_jours) - 0.001) {
      throw conflict(`Solde insuffisant (${user.solde_conge_actuel} j disponible(s) pour ${d.nb_jours} j)`);
    }
    await transaction(async (conn) => {
      await conn.query("UPDATE conges_demandes SET statut = 'VALIDE', traite_par = ?, date_traitement = NOW() WHERE id = ?", [req.user.id, id]);
      if (d.deduit_solde) {
        const nouveauSolde = Math.round((Number(user.solde_conge_actuel) - Number(d.nb_jours)) * 10) / 10;
        await conn.query('UPDATE users SET solde_conge_actuel = ? WHERE id = ?', [nouveauSolde, d.user_id]);
        await conn.query(
          "INSERT INTO conges_mouvements (user_id, demande_id, type, jours, solde_apres, commentaire, created_by) VALUES (?, ?, 'DEDUCTION', ?, ?, ?, ?)",
          [d.user_id, id, -d.nb_jours, nouveauSolde, `Congé ${d.numero} validé`, req.user.id],
        );
      }
    });
    await notifyUsers([d.user_id], {
      type: 'CONGE_VALIDE', titre: `Congé ${d.numero} validé`,
      message: `Votre demande de congé du ${fmtFr(d.date_debut)} au ${fmtFr(d.date_fin)} a été validée.`,
      lien: congeLinkEmploye(id),
    });
  } else if (statut === 'REFUSE') {
    if (!['BROUILLON', 'EN_ATTENTE'].includes(d.statut)) throw conflict('Seule une demande en attente peut être refusée');
    await query("UPDATE conges_demandes SET statut = 'REFUSE', motif_refus = ?, traite_par = ?, date_traitement = NOW() WHERE id = ?", [motif_refus, req.user.id, id]);
    await notifyUsers([d.user_id], {
      type: 'CONGE_REFUSE', titre: `Congé ${d.numero} refusé`,
      message: motif_refus ? `Motif : ${motif_refus}` : 'Votre demande de congé a été refusée.',
      lien: congeLinkEmploye(id),
    });
  } else { // ANNULE, à l'initiative du RH (y compris sur une demande déjà validée : crédit du solde)
    if (d.statut === 'ANNULE') throw conflict('Cette demande est déjà annulée');
    await transaction(async (conn) => {
      await conn.query("UPDATE conges_demandes SET statut = 'ANNULE', traite_par = ?, date_traitement = NOW() WHERE id = ?", [req.user.id, id]);
      if (d.statut === 'VALIDE' && d.deduit_solde) {
        const user = await queryOne('SELECT solde_conge_actuel FROM users WHERE id = ?', [d.user_id]);
        const nouveauSolde = Math.round((Number(user.solde_conge_actuel) + Number(d.nb_jours)) * 10) / 10;
        await conn.query('UPDATE users SET solde_conge_actuel = ? WHERE id = ?', [nouveauSolde, d.user_id]);
        await conn.query(
          "INSERT INTO conges_mouvements (user_id, demande_id, type, jours, solde_apres, commentaire, created_by) VALUES (?, ?, 'ANNULATION', ?, ?, ?, ?)",
          [d.user_id, id, d.nb_jours, nouveauSolde, `Annulation du congé ${d.numero} par le RH`, req.user.id],
        );
      }
    });
    await notifyUsers([d.user_id], {
      type: 'CONGE_ANNULE_RH', titre: `Congé ${d.numero} annulé`,
      message: 'Votre demande de congé a été annulée par le service RH.', lien: congeLinkEmploye(id),
    });
  }
  await audit(req, 'CONGE_STATUT_CHANGEMENT', { entite: 'conges_demandes', entiteId: id, details: { de: d.statut, vers: statut } });
  res.json({ data: { statut } });
});

router.post('/rh/conges/soldes/:userId/ajustement', authorize(ROLES.RH), validate(z.object({ userId: z.coerce.number().int().positive() }), 'params'), validate(z.object({
  jours: z.coerce.number().refine((v) => Math.abs(v) >= 0.1 && Math.abs(v) <= 365, 'Nombre de jours invalide'),
  commentaire: z.string({ error: 'Le commentaire est obligatoire' }).trim().min(3, 'Le commentaire doit contenir au moins 3 caractères').max(255),
})), async (req, res) => {
  const { userId } = req.valid.params;
  const { jours, commentaire } = req.body;
  const user = await queryOne('SELECT id, solde_conge_actuel FROM users WHERE id = ?', [userId]);
  if (!user) throw notFound('Collaborateur introuvable');
  const nouveauSolde = Math.round((Number(user.solde_conge_actuel) + jours) * 10) / 10;
  await transaction(async (conn) => {
    await conn.query('UPDATE users SET solde_conge_actuel = ? WHERE id = ?', [nouveauSolde, userId]);
    await conn.query(
      "INSERT INTO conges_mouvements (user_id, type, jours, solde_apres, commentaire, created_by) VALUES (?, 'AJUSTEMENT', ?, ?, ?, ?)",
      [userId, jours, nouveauSolde, commentaire, req.user.id],
    );
  });
  await audit(req, 'CONGE_SOLDE_AJUSTEMENT', { entite: 'users', entiteId: userId, details: { jours, commentaire } });
  res.json({ data: { solde_actuel: nouveauSolde } });
});

router.get('/rh/conges/soldes/:userId/historique', authorize(ROLES.RH), validate(z.object({ userId: z.coerce.number().int().positive() }), 'params'), async (req, res) => {
  res.json({ data: await query(
    `SELECT m.id, m.type, m.jours, m.solde_apres, m.commentaire, m.date_creation, d.numero
     FROM conges_mouvements m LEFT JOIN conges_demandes d ON d.id = m.demande_id
     WHERE m.user_id = ? ORDER BY m.date_creation DESC`,
    [req.valid.params.userId],
  ) });
});

// ---- Paramétrage : types de congé ----
router.get('/rh/conges/types', authorize(ROLES.RH), async (_req, res) => {
  res.json({ data: await query('SELECT id, code, libelle, deduit_solde, is_systeme, actif, ordre FROM conges_types ORDER BY ordre, libelle') });
});

router.post('/rh/conges/types', authorize(ROLES.RH), validate(z.object({
  code: z.string({ error: 'Le code est obligatoire' }).trim().min(2).max(30),
  libelle: z.string({ error: 'Le libellé est obligatoire' }).trim().min(2).max(100),
  deduit_solde: z.coerce.boolean().default(false),
})), async (req, res) => {
  const code = req.body.code.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  try {
    const [result] = await pool.query('INSERT INTO conges_types (code, libelle, deduit_solde, is_systeme, ordre) VALUES (?, ?, ?, 0, 99)', [code, req.body.libelle, req.body.deduit_solde ? 1 : 0]);
    await audit(req, 'CONGE_TYPE_CREATION', { entite: 'conges_types', entiteId: result.insertId });
    res.status(201).json({ data: { id: result.insertId } });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw conflict('Ce code de type existe déjà');
    throw err;
  }
});

router.patch('/rh/conges/types/:id', authorize(ROLES.RH), validate(idParamSchema, 'params'), validate(z.object({
  libelle: z.string({ error: 'Le libellé est obligatoire' }).trim().min(2).max(100),
  actif: z.coerce.boolean(),
  deduit_solde: z.coerce.boolean(),
})), async (req, res) => {
  const { id } = req.valid.params;
  const exists = await queryOne('SELECT id FROM conges_types WHERE id = ?', [id]);
  if (!exists) throw notFound('Type introuvable');
  await query('UPDATE conges_types SET libelle = ?, actif = ?, deduit_solde = ? WHERE id = ?', [req.body.libelle, req.body.actif ? 1 : 0, req.body.deduit_solde ? 1 : 0, id]);
  await audit(req, 'CONGE_TYPE_MODIFICATION', { entite: 'conges_types', entiteId: id });
  res.json({ data: await queryOne('SELECT id, code, libelle, deduit_solde, is_systeme, actif, ordre FROM conges_types WHERE id = ?', [id]) });
});

router.delete('/rh/conges/types/:id', authorize(ROLES.RH), validate(idParamSchema, 'params'), async (req, res) => {
  const { id } = req.valid.params;
  const type = await queryOne('SELECT is_systeme FROM conges_types WHERE id = ?', [id]);
  if (!type) throw notFound('Type introuvable');
  if (type.is_systeme) throw conflict('Ce type standard ne peut pas être supprimé (le désactiver à la place)');
  const used = await queryOne('SELECT COUNT(*) AS n FROM conges_demandes WHERE type_id = ?', [id]);
  if (used.n > 0) throw conflict('Ce type est déjà utilisé par des demandes existantes : le désactiver à la place');
  await query('DELETE FROM conges_types WHERE id = ?', [id]);
  await audit(req, 'CONGE_TYPE_SUPPRESSION', { entite: 'conges_types', entiteId: id });
  res.status(204).end();
});

// ---- Paramétrage : jours fériés ----
router.get('/rh/conges/jours-feries', authorize(ROLES.RH), validate(z.object({ annee: z.coerce.number().int().optional() }), 'query'), async (req, res) => {
  const annee = req.valid.query.annee ?? new Date().getFullYear();
  res.json({ data: await query('SELECT id, date_ferie, libelle FROM jours_feries WHERE YEAR(date_ferie) = ? ORDER BY date_ferie', [annee]) });
});

router.post('/rh/conges/jours-feries', authorize(ROLES.RH), validate(z.object({
  date_ferie: z.iso.date({ error: 'Date invalide' }),
  libelle: z.string({ error: 'Le libellé est obligatoire' }).trim().min(2).max(150),
})), async (req, res) => {
  try {
    const [result] = await pool.query('INSERT INTO jours_feries (date_ferie, libelle) VALUES (?, ?)', [req.body.date_ferie, req.body.libelle]);
    await audit(req, 'JOUR_FERIE_AJOUT', { entite: 'jours_feries', entiteId: result.insertId });
    res.status(201).json({ data: { id: result.insertId } });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw conflict('Ce jour férié est déjà configuré');
    throw err;
  }
});

router.delete('/rh/conges/jours-feries/:id', authorize(ROLES.RH), validate(idParamSchema, 'params'), async (req, res) => {
  await query('DELETE FROM jours_feries WHERE id = ?', [req.valid.params.id]);
  await audit(req, 'JOUR_FERIE_SUPPRESSION', { entite: 'jours_feries', entiteId: req.valid.params.id });
  res.status(204).end();
});

// ---- Tableau RH ----
router.get('/rh/conges/dashboard', authorize(ROLES.RH), async (_req, res) => {
  const [kpi, soldes, calendrier] = await Promise.all([
    queryOne(
      `SELECT CAST(COALESCE(SUM(statut = 'EN_ATTENTE'), 0) AS SIGNED) AS en_attente,
              CAST(COALESCE(SUM(statut = 'VALIDE'), 0) AS SIGNED) AS validees,
              CAST(COALESCE(SUM(statut = 'REFUSE'), 0) AS SIGNED) AS refusees
       FROM conges_demandes`,
    ),
    query(
      `SELECT id, matricule, nom, prenom, service, departement, site, solde_conge_initial, solde_conge_actuel
       FROM users WHERE actif = 1 AND role = 'EMPLOYE' ORDER BY solde_conge_actuel ASC, nom`,
    ),
    query(
      `SELECT d.id, d.numero, d.date_debut, d.date_fin, u.nom, u.prenom, u.service, u.site, t.libelle AS type_libelle
       FROM conges_demandes d JOIN users u ON u.id = d.user_id JOIN conges_types t ON t.id = d.type_id
       WHERE d.statut = 'VALIDE' AND d.date_fin >= CURDATE() ORDER BY d.date_debut LIMIT 200`,
    ),
  ]);
  res.json({ data: { kpi, soldes, calendrier } });
});

// ---- Analyse IA (règles statistiques) ----
router.get('/rh/conges/analyse', authorize(ROLES.RH), async (_req, res) => {
  const alertes = [];

  const soldeFaible = await query(
    `SELECT matricule, nom, prenom, service, solde_conge_actuel FROM users
     WHERE actif = 1 AND role = 'EMPLOYE' AND solde_conge_actuel < 3 ORDER BY solde_conge_actuel LIMIT 20`,
  );
  for (const u of soldeFaible) {
    alertes.push({ niveau: 'ATTENTION', categorie: 'SOLDE_FAIBLE', message: `${u.prenom} ${u.nom} (${u.service}) : solde inférieur à 3 jours (${u.solde_conge_actuel} j)` });
  }

  const frequents = await query(
    `SELECT u.matricule, u.nom, u.prenom, u.service, COUNT(*) AS nb
     FROM conges_demandes d JOIN users u ON u.id = d.user_id
     WHERE d.statut = 'VALIDE' AND d.date_creation >= NOW() - INTERVAL 90 DAY
     GROUP BY d.user_id HAVING nb >= 3 ORDER BY nb DESC LIMIT 20`,
  );
  for (const u of frequents) {
    alertes.push({ niveau: 'INFO', categorie: 'ABSENCES_REPETITIVES', message: `${u.prenom} ${u.nom} (${u.service}) : ${u.nb} congés validés sur les 90 derniers jours` });
  }

  const sousEffectif = await query(
    `SELECT u.service, d1.date_debut, COUNT(DISTINCT d1.user_id) AS nb
     FROM conges_demandes d1 JOIN users u ON u.id = d1.user_id
     JOIN conges_demandes d2 JOIN users u2 ON u2.id = d2.user_id
       ON u2.service = u.service AND d2.statut = 'VALIDE'
       AND d2.date_debut <= d1.date_fin AND d2.date_fin >= d1.date_debut
     WHERE d1.statut = 'VALIDE' AND d1.date_fin >= CURDATE()
     GROUP BY u.service, d1.date_debut HAVING nb >= 3 ORDER BY nb DESC LIMIT 20`,
  );
  for (const r of sousEffectif) {
    alertes.push({ niveau: 'CRITIQUE', categorie: 'RISQUE_SOUS_EFFECTIF', message: `${r.nb} collaborateurs du service ${r.service} absents simultanément le ${fmtFr(new Date(r.date_debut).toISOString().slice(0, 10))}` });
  }

  res.json({ data: { alertes } });
});

export default router;
