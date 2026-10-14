import 'server-only'
import { createClient } from '@/lib/supabase/server'

export interface NotificationRow { id: string; kind: string; title: string; body: string | null; link: string | null; created_at: string; read_at: string | null }
export interface EventFailureRow { event_id: string; event_type: string; consumer: string; status: 'failed' | 'dead'; attempts: number; last_error: string | null; occurred_at: string }

/** Mes notifications (la base ne renvoie que celles du destinataire). */
export async function myNotifications(limit = 50): Promise<NotificationRow[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('notifications').select('id,kind,title,body,link,created_at,read_at').order('created_at', { ascending: false }).limit(limit)
  return (data ?? []) as NotificationRow[]
}

/** Échecs visibles de la file d'événements (droit events.read ; sans droit, liste vide). */
export async function eventFailures(limit = 100): Promise<EventFailureRow[]> {
  const supabase = await createClient()
  const { data } = await supabase.rpc('event_failures', { p_limit: limit })
  return (data ?? []) as EventFailureRow[]
}
