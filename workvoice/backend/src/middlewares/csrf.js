import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { HttpError } from '../utils/httpError.js';

export const CSRF_COOKIE = 'wv_csrf';
export const CSRF_HEADER = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Émet un jeton CSRF (cookie lisible par le frontend, qui le renvoie en en-tête). */
export function issueCsrfToken(res) {
  const token = crypto.randomBytes(32).toString('hex');
  res.cookie(CSRF_COOKIE, token, {
    httpOnly: false,
    secure: env.isProd,
    sameSite: 'lax',
    path: '/',
  });
  return token;
}

function safeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/**
 * Protection « double-submit cookie » : toute requête modifiante doit porter
 * l'en-tête X-CSRF-Token égal au cookie wv_csrf. Un site tiers peut faire
 * envoyer le cookie mais ne peut pas le lire pour construire l'en-tête.
 */
export function csrfProtection(req, _res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  const cookie = req.cookies?.[CSRF_COOKIE];
  const header = req.get(CSRF_HEADER);
  if (!cookie || !header || !safeEqual(cookie, header)) {
    return next(new HttpError(403, 'Jeton CSRF invalide ou manquant', 'CSRF_INVALID'));
  }
  next();
}
