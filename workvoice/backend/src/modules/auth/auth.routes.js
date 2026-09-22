import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { query, queryOne } from '../../config/db.js';
import { AUTH_COOKIE, authCookieOptions, authenticate, signToken } from '../../middlewares/auth.js';
import { issueCsrfToken } from '../../middlewares/csrf.js';
import { loginLimiter } from '../../middlewares/rateLimit.js';
import { validate } from '../../middlewares/validate.js';
import { audit } from '../../utils/audit.js';
import { HttpError, unauthorized } from '../../utils/httpError.js';

const router = Router();

export const BCRYPT_COST = 12;
// Hash factice : un matricule inconnu coûte le même temps qu'un mauvais mot de passe
const DUMMY_HASH = bcrypt.hashSync('workvoice-dummy-password', BCRYPT_COST);

const loginSchema = z.object({
  matricule: z.string({ error: 'Le matricule est obligatoire' }).trim().toUpperCase().min(1, 'Le matricule est obligatoire').max(20),
  password: z.string({ error: 'Le mot de passe est obligatoire' }).min(1, 'Le mot de passe est obligatoire').max(200),
});

export const passwordPolicy = z
  .string()
  .min(10, 'Au moins 10 caractères')
  .max(200)
  .regex(/[a-z]/, 'Au moins une minuscule')
  .regex(/[A-Z]/, 'Au moins une majuscule')
  .regex(/[0-9]/, 'Au moins un chiffre');

const changePasswordSchema = z
  .object({
    ancien: z.string().min(1, "L'ancien mot de passe est obligatoire"),
    nouveau: passwordPolicy,
  })
  .refine((d) => d.ancien !== d.nouveau, { path: ['nouveau'], message: "Le nouveau mot de passe doit être différent de l'ancien" });

const PUBLIC_COLS = 'id, matricule, nom, prenom, email, telephone, service, departement, site, role, derniere_connexion, mdp_temporaire';

async function publicUser(id) {
  const u = await queryOne(`SELECT ${PUBLIC_COLS} FROM users WHERE id = ?`, [id]);
  return { ...u, mdp_temporaire: Boolean(u.mdp_temporaire) };
}

// GET /api/auth/csrf — à appeler au chargement de l'application
router.get('/csrf', (_req, res) => {
  res.json({ csrfToken: issueCsrfToken(res) });
});

// POST /api/auth/login
router.post('/login', loginLimiter, validate(loginSchema), async (req, res) => {
  const { matricule, password } = req.body;
  const user = await queryOne('SELECT id, role, password, actif FROM users WHERE matricule = ?', [matricule]);

  const ok = await bcrypt.compare(password, user?.password ?? DUMMY_HASH);
  if (!user || !ok || !user.actif) {
    await audit(req, 'CONNEXION_ECHEC', { userId: user?.id ?? null, details: { matricule } });
    throw unauthorized('Matricule ou mot de passe incorrect');
  }

  res.cookie(AUTH_COOKIE, signToken(user), { ...authCookieOptions(), maxAge: 8 * 60 * 60 * 1000 });
  issueCsrfToken(res); // nouveau jeton CSRF à chaque connexion

  await query('UPDATE users SET derniere_connexion = NOW() WHERE id = ?', [user.id]);
  await audit(req, 'CONNEXION', { userId: user.id });

  res.json({ data: await publicUser(user.id) });
});

// POST /api/auth/logout
router.post('/logout', async (req, res) => {
  res.clearCookie(AUTH_COOKIE, authCookieOptions());
  res.status(204).end();
});

// GET /api/auth/me
router.get('/me', authenticate, async (req, res) => {
  res.json({ data: await publicUser(req.user.id) });
});

// PUT /api/auth/password
router.put('/password', authenticate, validate(changePasswordSchema), async (req, res) => {
  const { password } = await queryOne('SELECT password FROM users WHERE id = ?', [req.user.id]);
  if (!(await bcrypt.compare(req.body.ancien, password))) {
    throw new HttpError(400, 'Ancien mot de passe incorrect', 'BAD_PASSWORD');
  }
  const hash = await bcrypt.hash(req.body.nouveau, BCRYPT_COST);
  await query('UPDATE users SET password = ?, mdp_temporaire = 0 WHERE id = ?', [hash, req.user.id]);
  await audit(req, 'MOT_DE_PASSE_CHANGEMENT');
  res.status(204).end();
});

export default router;
