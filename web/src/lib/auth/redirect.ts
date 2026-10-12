import { ROUTES } from './constants'

/**
 * Empêche les redirections ouvertes : seul un chemin interne absolu est accepté
 * (pas de "//evil.com", "/\evil.com", de schéma ni de caractères de contrôle).
 */
export function safeNext(next: string | null | undefined, fallback: string = ROUTES.home): string {
  if (!next) return fallback
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback
  if ([...next].some((c) => c.charCodeAt(0) < 32 || c === '\\')) return fallback
  // Ne jamais renvoyer vers les pages d'authentification elles-mêmes
  if (/^\/(login|forgot-password|auth)(\/|$|\?)/.test(next)) return fallback
  return next
}
