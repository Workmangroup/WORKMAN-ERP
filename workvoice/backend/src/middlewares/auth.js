import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { queryOne } from '../config/db.js';
import { forbidden, HttpError, unauthorized } from '../utils/httpError.js';

const PASSWORD_CHANGE_PATHS = ['/auth/me', '/auth/password', '/auth/logout'];

export const AUTH_COOKIE = 'wv_token';

export function signToken(user) {
  return jwt.sign({ role: user.role }, env.jwt.secret, {
    subject: String(user.id),
    issuer: env.jwt.issuer,
    expiresIn: env.jwt.expiresIn,
    algorithm: 'HS256',
  });
}

export function authCookieOptions() {
  return {
    httpOnly: true,
    secure: env.isProd,
    sameSite: 'lax',
    path: '/',
  };
}

/**
 * Vérifie le JWT (cookie httpOnly) puis recharge l'utilisateur en base :
 * un compte désactivé ou dont le rôle a changé perd immédiatement l'accès.
 */
export async function authenticate(req, _res, next) {
  const token = req.cookies?.[AUTH_COOKIE];
  if (!token) return next(unauthorized());

  let payload;
  try {
    payload = jwt.verify(token, env.jwt.secret, { issuer: env.jwt.issuer, algorithms: ['HS256'] });
  } catch {
    return next(unauthorized('Session expirée, veuillez vous reconnecter'));
  }

  const user = await queryOne(
    `SELECT id, matricule, nom, prenom, email, telephone, service, departement, site, role, mdp_temporaire
     FROM users WHERE id = ? AND actif = 1`,
    [Number(payload.sub)],
  );
  if (!user || user.role !== payload.role) return next(unauthorized('Session invalide'));

  // Mot de passe provisoire (créé ou réinitialisé par le RH) : seul le changement de mot de passe est permis
  const path = req.originalUrl.split('?')[0].replace(/^\/api/, '').replace(/\/$/, '');
  if (user.mdp_temporaire && !PASSWORD_CHANGE_PATHS.includes(path)) {
    return next(new HttpError(403, 'Vous devez choisir votre mot de passe personnel avant de continuer', 'PASSWORD_CHANGE_REQUIRED'));
  }

  req.user = user;
  next();
}

/** Restreint une route à un ou plusieurs rôles. */
export function authorize(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden());
    next();
  };
}
