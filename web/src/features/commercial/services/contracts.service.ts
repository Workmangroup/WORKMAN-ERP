import { createClient } from '@/lib/supabase/server'

export type ContractStatus = 'draft' | 'signed' | 'renewed' | 'terminated'

export interface ContractRow {
  id: string
  code: string
  client_id: string
  client: string
  kind: string
  status: ContractStatus
  start_on: string
  end_on: string
  auto_renew: boolean
  renew_notice_days: number
  currency: string | null
  payment_terms: string | null
  discount_pct: number | null
  price_conditions: string | null
  signed_document_id: string | null
  signed_by_name: string | null
  signed_at: string | null
  terminated_on: string | null
  terminated_reason: string | null
  renews_contract_id: string | null
}

export interface ConditionsAt {
  contract_id: string
  code: string
  status: ContractStatus
  start_on: string
  effective_end: string
  currency: string | null
  payment_terms: string | null
  discount_pct: number | null
  price_conditions: string | null
  signed_document_id: string | null
  signed_by_name: string | null
  signed_at: string | null
}

export async function listContracts(): Promise<ContractRow[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('client_contracts').select('*').order('start_on', { ascending: false }).limit(300)
  const rows = (data ?? []) as Record<string, unknown>[]
  const ids = [...new Set(rows.map((r) => String(r.client_id)))]
  const { data: cl } = ids.length ? await supabase.from('clients').select('id,name').in('id', ids) : { data: [] }
  const names = new Map((cl ?? []).map((c) => [String(c.id), String(c.name)]))
  return rows.map((r) => ({ ...(r as unknown as Omit<ContractRow, 'client'>), client: names.get(String(r.client_id)) ?? '—' }))
}

/** Pièces de la GED par client (pour choisir la pièce signée). Limité aux documents que la personne peut lire. */
export async function listClientDocuments(clientIds: string[]): Promise<Record<string, { id: string; title: string }[]>> {
  const ids = [...new Set(clientIds)]
  if (!ids.length) return {}
  const supabase = await createClient()
  const { data } = await supabase.from('ged_documents').select('id,client_id,title').in('client_id', ids).order('title').limit(1000)
  const out: Record<string, { id: string; title: string }[]> = {}
  for (const d of data ?? []) (out[String(d.client_id)] ??= []).push({ id: String(d.id), title: String(d.title) })
  return out
}

/** Conditions valides à une date pour un client : null si aucun contrat signé ne couvre cette date. */
export async function conditionsAt(clientId: string, on: string): Promise<{ ok: true; value: ConditionsAt | null } | { ok: false }> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('contract_conditions_at', { p_client: clientId, p_on: on })
  if (error) return { ok: false }
  return { ok: true, value: (data as ConditionsAt | null) ?? null }
}
