'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'
import { getAuthContext } from '@/features/auth/services/access.service'
import { logAccessDenied } from '@/features/rbac/services/audit-write.service'

export type EventResult = { ok: true; result?: string } | { ok: false; message: string }

const MESSAGES: Record<string, string> = {
  RBAC_FORBIDDEN: 'Vous n’avez pas le droit de relancer cet événement.',
  EVENT_NOT_FAILED: 'Cet événement n’a pas d’échec à relancer.',
  EVENT_CONSUMER_UNKNOWN: 'Consommateur inconnu.',
  EVENT_NOT_FOUND: 'Événement introuvable.',
}
const messageOf = (err: { message?: string }) => MESSAGES[err.message ?? ''] ?? 'L’opération a échoué. Réessayez ou contactez un administrateur.'

/** Marque une notification comme lue (la base refuse celles d'autrui). */
export async function markNotificationReadAction(id: string): Promise<EventResult> {
  if (!z.uuid().safeParse(id).success) return { ok: false, message: 'Notification invalide.' }
  const supabase = await createClient()
  const { error } = await supabase.rpc('notification_mark_read', { p_id: id })
  if (error) return { ok: false, message: messageOf(error) }
  revalidatePath('/notifications')
  return { ok: true }
}

/** Relance un consommateur en échec (replay). Droit events.replay appliqué par la base. */
export async function replayEventAction(eventId: string, consumer: string): Promise<EventResult> {
  const ctx = await getAuthContext()
  if (!ctx || !ctx.permissions.includes(P.EVENTS_REPLAY)) {
    if (ctx) await logAccessDenied(ctx, P.EVENTS_REPLAY, { via: 'server-action' })
    return { ok: false, message: MESSAGES.RBAC_FORBIDDEN }
  }
  if (!z.uuid().safeParse(eventId).success) return { ok: false, message: 'Événement invalide.' }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('event_replay', { p_event: eventId, p_consumer: consumer })
  if (error) return { ok: false, message: messageOf(error) }
  revalidatePath('/admin/events')
  return { ok: true, result: String(data) }
}

/** Traitement de la file (dispatch). Sans effet double : les événements déjà traités sont ignorés. */
export async function dispatchEventsAction(): Promise<EventResult> {
  const ctx = await getAuthContext()
  if (!ctx || !ctx.permissions.includes(P.EVENTS_REPLAY)) return { ok: false, message: MESSAGES.RBAC_FORBIDDEN }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('event_dispatch', { p_limit: 500 })
  if (error) return { ok: false, message: messageOf(error) }
  revalidatePath('/admin/events')
  return { ok: true, result: JSON.stringify(data) }
}
