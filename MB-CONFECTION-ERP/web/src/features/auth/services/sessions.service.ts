import 'server-only'
import { createClient } from '@/lib/supabase/server'
import type { AuthEventRow, SessionRow } from '../types'

export async function listMySessions(): Promise<SessionRow[]> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('list_my_sessions')
  if (error) {
    console.error('[sessions]', error.message)
    return []
  }
  return (data ?? []) as SessionRow[]
}

export async function listMyAuthEvents(limit = 12): Promise<AuthEventRow[]> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('auth_events')
    .select('id,event_type,success,ip,user_agent,created_at')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) return []
  return (data ?? []) as AuthEventRow[]
}
