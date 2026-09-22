import crypto from 'node:crypto';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { pool, query, queryOne } from '../../config/db.js';
import { ROLES } from '../../config/constants.js';
import { authenticate, authorize } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { audit } from '../../utils/audit.js';
import { badRequest, conflict, HttpError, notFound } from '../../utils/httpError.js';
import { paged, paginate, paginationSchema } from '../../utils/pagination.js';
import { idParamSchema } from '../tickets/tickets.schemas.js';

/*
 * Gestion des collaborateurs par le service RH : création des comptes,
 * attribution des accès (rôle), désactivation, réinitialisation du mot de passe,
 * import en masse. Toutes les actions sont journalisées.
 */

const router = Router();
router.use(authenticate, authorize(ROLES.RH));

const ADMIN_COLS = `id, matricule, nom, prenom, email, telephone, service, departement, site, role, actif,
  mdp_temporaire, derniere_connexion, created_at`;
// Coût réduit pour les mots de passe provisoires : ils sont changés à la première connexion
const BCRYPT_COST_TEMP = 10;
const IMPORT_MAX_LIGNES = 100;

const shapeUser = (u) => ({ ...u, actif: Boolean(u.actif), mdp_temporaire: Boolean(u.mdp_temporaire) });

/** Mot de passe provisoire lisible (sans 0/O, 1/l/I) : majuscule, minuscule et chiffre garantis. */
export function tempPassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  const all = upper + lower + digits;
  const pick = (s) => s[crypto.randomInt(s.length)];
  const chars = [pick(upper), pick(lower), pick(digits), ...Array.from({ length: 9 }, () => pick(all))];
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

const txt = (label, min, max) =>
  z.string({ error: `${label} est obligatoire` }).trim().min(min, min > 1 ? `${label} doit contenir au moins ${min} caractères` : `${label} est obligatoire`).max(max, `${label} ne peut pas dépasser ${max} caractères`);

export const collaborateurSchema = z.object({
  matricule: txt('Le matricule', 2, 20)
    .transform((v) => v.toUpperCase())
    .refine((v) => /^[A-Z0-9._-]+$/.test(v), 'Le matricule ne doit contenir que des lettres, chiffres, points ou tirets'),
  nom: txt('Le nom', 1, 80),
  prenom: txt('Le prénom', 1, 80),
  service: txt('Le service', 1, 80),
  departement: txt('Le département', 1, 80),
  site: txt('Le site', 1, 80),
  role: z.enum([ROLES.EMPLOYE, ROLES.RH, ROLES.DIRECTION], { error: 'Rôle invalide' }).default(ROLES.EMPLOYE),
  email: z
    .union([z.email('Adresse e-mail invalide').max(150), z.literal(''), z.null()])
    .optional()
    .transform((v) => (v ? v.toLowerCase() : null)),
  telephone: z
    .union([z.string().trim().max(30).regex(/^[+0-9 ().-]*$/, 'Numéro de téléphone invalide'), z.null()])
    .optional()
    .transform((v) => v || null),
});

async function loadUser(id) {
  const u = await queryOne(`SELECT ${ADMIN_COLS} FROM users WHERE id = ?`, [id]);
  if (!u) throw notFound('Collaborateur introuvable');
  return u;
}

async function assertOtherActiveRh(userId) {
  const { n } = await queryOne("SELECT COUNT(*) AS n FROM users WHERE role = 'RH' AND actif = 1 AND id <> ?", [userId]);
  if (n === 0) throw conflict("Impossible : ce compte est le dernier accès RH actif de l'application.");
}

const duplicateMessage = (err, matricule) =>
  err.message.includes('email') ? 'Cette adresse e-mail est déjà utilisée par un autre collaborateur' : `Le matricule ${matricule} existe déjà`;

async function insertCollaborateur(d) {
  const password = tempPassword();
  try {
    const [res] = await pool.query(
      `INSERT INTO users (matricule, nom, prenom, email, telephone, service, departement, site, role, password, mdp_temporaire, actif)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`,
      [d.matricule, d.nom, d.prenom, d.email, d.telephone, d.service, d.departement, d.site, d.role, await bcrypt.hash(password, BCRYPT_COST_TEMP)],
    );
    return { id: res.insertId, password };
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw conflict(duplicateMessage(err, d.matricule));
    throw err;
  }
}

// GET /api/rh/collaborateurs
const listSchema = z.object({
  q: z.string().trim().max(100).optional(),
  role: z.enum([ROLES.EMPLOYE, ROLES.RH, ROLES.DIRECTION]).optional(),
  actif: z.enum(['true', 'false']).optional(),
  site: z.string().trim().max(80).optional(),
  departement: z.string().trim().max(80).optional(),
  service: z.string().trim().max(80).optional(),
  ...paginationSchema,
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

router.get('/', validate(listSchema, 'query'), async (req, res) => {
  const f = req.valid.query;
  const where = [];
  const params = [];
  if (f.q) {
    where.push("(matricule LIKE ? OR nom LIKE ? OR prenom LIKE ? OR email LIKE ? OR CONCAT(prenom, ' ', nom) LIKE ?)");
    const like = `%${f.q.replace(/[\\%_]/g, '\\$&')}%`;
    params.push(like, like, like, like, like);
  }
  if (f.role) { where.push('role = ?'); params.push(f.role); }
  if (f.actif) where.push(f.actif === 'true' ? 'actif = 1' : 'actif = 0');
  for (const col of ['site', 'departement', 'service']) {
    if (f[col]) { where.push(`${col} = ?`); params.push(f[col]); }
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { limit, offset } = paginate(f);
  const [rows, count, stats] = await Promise.all([
    query(`SELECT ${ADMIN_COLS} FROM users ${whereSql} ORDER BY nom, prenom LIMIT ? OFFSET ?`, [...params, limit, offset]),
    queryOne(`SELECT COUNT(*) AS n FROM users ${whereSql}`, params),
    queryOne(
      `SELECT CAST(COALESCE(SUM(actif = 1), 0) AS SIGNED) AS actifs,
              CAST(COALESCE(SUM(actif = 0), 0) AS SIGNED) AS inactifs,
              CAST(COALESCE(SUM(actif = 1 AND role = 'EMPLOYE'), 0) AS SIGNED) AS employes,
              CAST(COALESCE(SUM(actif = 1 AND role = 'RH'), 0) AS SIGNED) AS rh,
              CAST(COALESCE(SUM(actif = 1 AND role = 'DIRECTION'), 0) AS SIGNED) AS direction,
              CAST(COALESCE(SUM(actif = 1 AND mdp_temporaire = 1), 0) AS SIGNED) AS en_attente_activation
       FROM users`,
    ),
  ]);
  res.json({ ...paged(rows.map(shapeUser), count.n, f), stats });
});

// POST /api/rh/collaborateurs
router.post('/', validate(collaborateurSchema), async (req, res) => {
  const { id, password } = await insertCollaborateur(req.body);
  await audit(req, 'COLLABORATEUR_CREATION', { entite: 'users', entiteId: id, details: { matricule: req.body.matricule, role: req.body.role } });
  // Le mot de passe provisoire n'est renvoyé qu'une seule fois, ici
  res.status(201).json({ data: shapeUser(await loadUser(id)), mot_de_passe_temporaire: password });
});

// POST /api/rh/collaborateurs/import — avant /:id
router.post('/import', async (req, res) => {
  const lignes = req.body?.lignes;
  if (!Array.isArray(lignes) || !lignes.length) throw badRequest('Aucune ligne à importer');
  if (lignes.length > IMPORT_MAX_LIGNES) throw badRequest(`Maximum ${IMPORT_MAX_LIGNES} lignes par envoi`);

  const resultats = [];
  let crees = 0;
  for (const [i, ligne] of lignes.entries()) {
    const base = { ligne: Number(ligne?._ligne ?? i + 1), matricule: String(ligne?.matricule ?? ''), nom: String(ligne?.nom ?? ''), prenom: String(ligne?.prenom ?? '') };
    const parsed = collaborateurSchema.safeParse(ligne ?? {});
    if (!parsed.success) {
      resultats.push({ ...base, statut: 'erreur', message: parsed.error.issues.map((x) => x.message).join(' · ') });
      continue;
    }
    try {
      const { id, password } = await insertCollaborateur(parsed.data);
      crees++;
      resultats.push({ ...base, matricule: parsed.data.matricule, statut: 'cree', id, role: parsed.data.role, mot_de_passe: password });
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      resultats.push({ ...base, statut: 'erreur', message: err.message });
    }
  }
  await audit(req, 'COLLABORATEURS_IMPORT', { entite: 'users', details: { lignes: lignes.length, crees } });
  res.json({ data: { crees, erreurs: lignes.length - crees, resultats } });
});

// PUT /api/rh/collaborateurs/:id — informations et accès (rôle)
router.put('/:id', validate(idParamSchema, 'params'), validate(collaborateurSchema), async (req, res) => {
  const { id } = req.valid.params;
  const before = await loadUser(id);
  const d = req.body;
  if (before.role === ROLES.RH && d.role !== ROLES.RH) {
    if (id === req.user.id) throw conflict('Vous ne pouvez pas retirer votre propre accès RH.');
    await assertOtherActiveRh(id);
  }
  try {
    await query(
      `UPDATE users SET matricule = ?, nom = ?, prenom = ?, email = ?, telephone = ?, service = ?, departement = ?, site = ?, role = ?
       WHERE id = ?`,
      [d.matricule, d.nom, d.prenom, d.email, d.telephone, d.service, d.departement, d.site, d.role, id],
    );
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw conflict(duplicateMessage(err, d.matricule));
    throw err;
  }
  const changes = {};
  for (const k of ['matricule', 'nom', 'prenom', 'email', 'telephone', 'service', 'departement', 'site', 'role']) {
    if (String(before[k] ?? '') !== String(d[k] ?? '')) changes[k] = { de: before[k], vers: d[k] };
  }
  await audit(req, changes.role ? 'COLLABORATEUR_ACCES_MODIFIE' : 'COLLABORATEUR_MODIFICATION', { entite: 'users', entiteId: id, details: changes });
  res.json({ data: shapeUser(await loadUser(id)) });
});

// PATCH /api/rh/collaborateurs/:id/statut — activer / désactiver l'accès (effet immédiat)
router.patch('/:id/statut', validate(idParamSchema, 'params'), validate(z.object({ actif: z.boolean() })), async (req, res) => {
  const { id } = req.valid.params;
  const user = await loadUser(id);
  if (!req.body.actif) {
    if (id === req.user.id) throw conflict('Vous ne pouvez pas désactiver votre propre compte.');
    if (user.role === ROLES.RH) await assertOtherActiveRh(id);
  }
  await query('UPDATE users SET actif = ? WHERE id = ?', [req.body.actif ? 1 : 0, id]);
  await audit(req, req.body.actif ? 'COLLABORATEUR_REACTIVATION' : 'COLLABORATEUR_DESACTIVATION', { entite: 'users', entiteId: id, details: { matricule: user.matricule } });
  res.json({ data: shapeUser(await loadUser(id)) });
});

// POST /api/rh/collaborateurs/:id/mot-de-passe — réinitialisation
router.post('/:id/mot-de-passe', validate(idParamSchema, 'params'), async (req, res) => {
  const { id } = req.valid.params;
  const user = await loadUser(id);
  const password = tempPassword();
  await query('UPDATE users SET password = ?, mdp_temporaire = 1 WHERE id = ?', [await bcrypt.hash(password, BCRYPT_COST_TEMP), id]);
  await audit(req, 'COLLABORATEUR_MDP_REINITIALISE', { entite: 'users', entiteId: id, details: { matricule: user.matricule } });
  res.json({ data: shapeUser(await loadUser(id)), mot_de_passe_temporaire: password });
});

export default router;
