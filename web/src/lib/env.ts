/**
 * Variables d'environnement. Les NEXT_PUBLIC_* doivent être référencées
 * littéralement pour être injectées dans le bundle navigateur.
 */
export const publicEnv = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
  siteUrl: process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000',
}

const int = (v: string | undefined, d: number) => {
  const n = Number.parseInt(v ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : d
}

/** Politique de sécurité (lue côté serveur / middleware). */
export const securityPolicy = {
  idleTimeoutMs: int(process.env.AUTH_IDLE_TIMEOUT_MINUTES, 30) * 60_000,
  maxFailedAttempts: int(process.env.AUTH_MAX_FAILED_ATTEMPTS, 5),
  lockoutMinutes: int(process.env.AUTH_LOCKOUT_MINUTES, 15),
}

export function assertPublicEnv() {
  if (!publicEnv.supabaseUrl || !publicEnv.supabaseAnonKey) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL et NEXT_PUBLIC_SUPABASE_ANON_KEY doivent être définies (voir .env.example).',
    )
  }
}
