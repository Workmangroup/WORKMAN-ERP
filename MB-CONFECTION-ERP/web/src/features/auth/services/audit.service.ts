import 'server-only'
import { headers } from 'next/headers'
import { createAdminClient, hasServiceRole } from '@/lib/supabase/admin'
import { securityPolicy } from '@/lib/env'

export type AuthEventType =
  | 'login_success' | 'login_failed' | 'login_locked' | 'logout' | 'logout_all'
  | 'password_reset_requested' | 'password_reset_completed'
  | 'password_changed' | 'password_change_failed'
  | 'session_revoked' | 'sessions_revoked_others' | 'session_idle_timeout'

export async function requestInfo() {
  const h = await headers()
  const ip = h.get('x-forwarded-for')?.split(',')[0]?.trim() || h.get('x-real-ip') || null
  return { ip, userAgent: h.get('user-agent')?.slice(0, 300) ?? null }
}

/** Écrit un événement d'authentification. Best-effort : n'interrompt jamais le flux. */
export async function logAuthEvent(e: {
  type: AuthEventType
  email?: string | null
  userId?: string | null
  companyId?: string | null
  success?: boolean
  metadata?: Record<string, unknown>
}) {
  if (!hasServiceRole()) return
  try {
    const { ip, userAgent } = await requestInfo()
    const { error } = await createAdminClient()
      .from('auth_events')
      .insert({
        event_type: e.type,
        email: e.email?.toLowerCase() ?? null,
        user_id: e.userId ?? null,
        company_id: e.companyId ?? null,
        success: e.success ?? true,
        ip,
        user_agent: userAgent,
        metadata: e.metadata ?? {},
      })
    if (error) console.error('[auth_events]', error.message)
  } catch (err) {
    console.error('[auth_events]', err)
  }
}

/**
 * Verrouillage temporaire : N échecs de connexion CONSÉCUTIFS (sans succès ni
 * réinitialisation de mot de passe entre-temps) dans la fenêtre de verrouillage.
 */
export async function getLockout(email: string): Promise<{ locked: boolean; retryAfterMin: number }> {
  if (!hasServiceRole()) return { locked: false, retryAfterMin: 0 }
  const windowMs = securityPolicy.lockoutMinutes * 60_000
  const since = new Date(Date.now() - windowMs).toISOString()
  try {
    const { data, error } = await createAdminClient()
      .from('auth_events')
      .select('event_type,created_at')
      .eq('email', email.toLowerCase())
      .in('event_type', ['login_failed', 'login_success', 'password_reset_completed'])
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(securityPolicy.maxFailedAttempts)
    if (error || !data) return { locked: false, retryAfterMin: 0 }
    const consecutive = data.findIndex((r) => r.event_type !== 'login_failed')
    const failures = consecutive === -1 ? data.length : consecutive
    if (failures < securityPolicy.maxFailedAttempts) return { locked: false, retryAfterMin: 0 }
    const latest = new Date(data[0].created_at).getTime()
    const retry = Math.max(1, Math.ceil((latest + windowMs - Date.now()) / 60_000))
    return { locked: true, retryAfterMin: retry }
  } catch {
    return { locked: false, retryAfterMin: 0 }
  }
}
