import { createClient } from '@/lib/supabase/server'

export interface ObjectiveProgress {
  objective_id: string
  label: string
  scope: 'company' | 'client'
  client_id: string | null
  client_name: string | null
  period_start: string
  period_end: string
  currency: string
  target: number
  realised_net_ht: number | null
  percent: number | null
  invoices_counted: number | null
  excluded_no_rate: number | null
}

/** Objectifs avec leur progression : même périmètre et même période pour le CA (fonction SQL objective_progress). */
export async function listObjectives(): Promise<ObjectiveProgress[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('sales_objectives').select('id').order('period_start', { ascending: false }).limit(200)
  const ids = (data ?? []).map((o) => String(o.id))
  const results = await Promise.all(ids.map((id) => supabase.rpc('objective_progress', { p_objective: id })))
  return results.flatMap(({ data: p, error }) => (error || !p ? [] : [p as ObjectiveProgress]))
}

export async function clientsForObjectives(): Promise<{ id: string; name: string }[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('clients').select('id,name').is('archived_at', null).order('name').limit(2000)
  return (data ?? []) as { id: string; name: string }[]
}
