export const ROUTES = {
  login: '/login',
  forgotPassword: '/forgot-password',
  resetPassword: '/reset-password',
  changePassword: '/change-password',
  home: '/command-center',
  security: '/account/security',
  unauthorized: '/unauthorized',
} as const

/** Pages accessibles sans session. */
export const PUBLIC_PATHS = [
  ROUTES.login,
  ROUTES.forgotPassword,
  ROUTES.resetPassword,
  ROUTES.unauthorized,
  '/auth/callback',
  '/auth/confirm',
  '/auth/refresh',
  // Désinscription publique (lien dans les messages) et webhooks de délivrabilité (signature HMAC vérifiée côté route)
  '/desinscription',
  '/api/webhooks/marketing',
]

/** Pages d'authentification dont un utilisateur connecté est redirigé vers l'accueil. */
export const GUEST_ONLY_PATHS = [ROUTES.login, ROUTES.forgotPassword]

export const COOKIE_ACTIVITY = 'mb_activity'
export const COOKIE_RECOVERY = 'mb_recovery'
export const ACTIVITY_REFRESH_MS = 60_000
export const RECOVERY_MAX_AGE_S = 15 * 60

export const matchesPath = (pathname: string, list: string[]) =>
  list.some((p) => pathname === p || pathname.startsWith(p + '/'))
