import 'server-only'
import { createClient } from '@/lib/supabase/server'
import { recentAuditFor } from '@/features/rbac/services/audit-query.service'
import type { AuditRow } from '@/features/rbac/types'

export interface RequestRow {
  id: string; number: string; kind: string; status: string; engine_type: string; material_id: string; qty: number
  warehouse_id: string; location_id: string | null; to_warehouse_id: string | null; to_location_id: string | null
  unit_cost: number | null; value: number; reference: string | null; reason: string | null; approval_level: number
  requested_by: string; requested_at: string; level1_by: string | null; level1_at: string | null; level2_by: string | null; level2_at: string | null
  decided_by: string | null; decided_at: string | null; decision_note: string | null; movement_id: string | null; reversal_of: string | null
  requester: string; level1_name: string | null; level2_name: string | null
}
export interface JournalRow {
  id: string; number: string; created_at: string; kind: string; type: string; direction: string; qty: number; material_id: string
  material_code: string; material_name: string; warehouse_id: string; warehouse_code: string; location_id: string | null
  to_warehouse_id: string | null; to_location_id: string | null; reference: string | null; reason: string | null
  reversal_of: string | null; request_id: string | null; requested_by: string | null; approved_by: string | null
  reversed: boolean
}

const label = (u: { full_name?: string | null; email?: string | null } | undefined) => (u ? (u.full_name || u.email || '—') : '—')

async function namesOf(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const uniq = [...new Set(ids.filter(Boolean))]
  if (uniq.length === 0) return out
  const supabase = await createClient()
  const { data } = await supabase.from('company_directory').select('id,full_name,email').in('id', uniq)
  for (const u of data ?? []) out.set(u.id as string, label(u as { full_name: string; email: string }))
  return out
}

/** Demandes de mouvement visibles (RLS : stock.read et entrepôts affectés). */
export async function listRequests(status: string | null, limit = 150): Promise<RequestRow[]> {
  const supabase = await createClient()
  let query = supabase.from('stock_movement_requests').select('*').order('requested_at', { ascending: false }).limit(limit)
  if (status) query = query.eq('status', status)
  const { data } = await query
  const rows = (data ?? []) as Omit<RequestRow, 'requester' | 'level1_name' | 'level2_name'>[]
  const names = await namesOf(rows.flatMap((r) => [r.requested_by, r.level1_by, r.level2_by]).filter((x): x is string => Boolean(x)))
  return rows.map((r) => ({
    ...r, requester: names.get(r.requested_by) ?? '—',
    level1_name: r.level1_by ? names.get(r.level1_by) ?? '—' : null,
    level2_name: r.level2_by ? names.get(r.level2_by) ?? '—' : null,
  }))
}

/** Journal numéroté des mouvements (vue stock_journal) ; indique les mouvements déjà annulés. */
export async function listJournal(limit = 150): Promise<JournalRow[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('stock_journal').select('*').order('created_at', { ascending: false }).limit(limit)
  const rows = (data ?? []) as Omit<JournalRow, 'reversed'>[]
  const ids = rows.map((r) => r.id)
  const { data: rev } = ids.length ? await supabase.from('stock_movements').select('reversal_of').in('reversal_of', ids) : { data: [] }
  const reversed = new Set((rev ?? []).map((r) => r.reversal_of as string))
  return rows.map((r) => ({ ...r, reversed: reversed.has(r.id) }))
}

/** Emplacements actifs (pour les sélecteurs de demande). */
export async function listLocationOptions(): Promise<{ id: string; warehouse_id: string; code: string; name: string | null }[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('stock_locations').select('id,warehouse_id,code,name').is('archived_at', null).order('code').limit(1000)
  return (data ?? []) as { id: string; warehouse_id: string; code: string; name: string | null }[]
}

/** Traçabilité complète d'une demande (création, validations, refus, annulation). */
export async function requestHistory(id: string): Promise<AuditRow[]> {
  return recentAuditFor('stock_request', id, 100)
}
