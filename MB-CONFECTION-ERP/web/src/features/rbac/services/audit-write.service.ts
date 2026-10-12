import 'server-only'
import { createAdminClient, hasServiceRole } from '@/lib/supabase/admin'
import { requestInfo } from '@/features/auth/services/audit.service'
import type { AuthContextValue } from '@/features/auth/types'

/**
 * Journalise un refus d'accès (guard serveur ou action refusée par la base).
 * Best-effort : n'interrompt jamais le flux. Écrit via service_role (audit_logs est fermé aux clients).
 */
export async function logAccessDenied(ctx: AuthContextValue, permission: string, context?: Record<string, unknown>) {
  if (!hasServiceRole()) return
  try {
    const { ip, userAgent } = await requestInfo()
    const { error } = await createAdminClient()
      .from('audit_logs')
      .insert({
        company_id: ctx.profile.company_id,
        actor_id: ctx.user.id,
        actor_email: ctx.user.email,
        action: 'access.denied',
        entity_type: 'access',
        entity_id: permission,
        entity_label: permission,
        metadata: { permission, ...context },
        source: 'app',
        ip,
        user_agent: userAgent,
      })
    if (error) console.error('[audit access.denied]', error.message)
  } catch (err) {
    console.error('[audit access.denied]', err)
  }
}
