import 'server-only'
import { createClient } from '@/lib/supabase/server'
import type { Forecast, ParamRow, PeggingRow, Receipt, Run, RunMaterial, Suggestion, TimelinePoint } from '../types'

const num = (v: unknown) => Number(v ?? 0)

async function materialsMap(ids: string[]) {
  const out = new Map<string, { id: string; code: string; name: string; unit: string; category: string; supplier_id: string | null }>()
  const uniq = [...new Set(ids)]
  const supabase = await createClient()
  for (let i = 0; i < uniq.length; i += 200) {
    const { data } = await supabase.from('bom_materials').select('id,code,name,unit,category,supplier_id').in('id', uniq.slice(i, i + 200))
    for (const m of data ?? []) out.set(m.id as string, m as never)
  }
  return out
}
async function suppliersMap(ids: (string | null)[]) {
  const out = new Map<string, { name: string; lead_time_days: number | null }>()
  const uniq = [...new Set(ids.filter((x): x is string => !!x))]
  if (!uniq.length) return out
  const supabase = await createClient()
  const { data } = await supabase.from('suppliers').select('id,name,lead_time_days').in('id', uniq)
  for (const s of data ?? []) out.set(s.id as string, { name: s.name as string, lead_time_days: (s.lead_time_days as number | null) ?? null })
  return out
}
/** Prix unitaires des composants (vide sans costs.read : la RLS masque la table). */
async function pricesMap(ids: string[]) {
  const out = new Map<string, number>()
  const uniq = [...new Set(ids)]
  const supabase = await createClient()
  for (let i = 0; i < uniq.length; i += 200) {
    const { data } = await supabase.from('bom_material_prices').select('material_id,unit_cost').in('material_id', uniq.slice(i, i + 200))
    for (const p of data ?? []) out.set(p.material_id as string, num(p.unit_cost))
  }
  return out
}

export async function listRuns(): Promise<Run[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('mrp_runs').select('*').order('created_at', { ascending: false }).limit(100)
  return (data ?? []) as Run[]
}
export async function latestRun(): Promise<Run | null> {
  const supabase = await createClient()
  const { data } = await supabase.from('mrp_runs').select('*').order('created_at', { ascending: false }).limit(1).maybeSingle()
  return (data as Run | null) ?? null
}
export async function getRun(id: string): Promise<Run | null> {
  const supabase = await createClient()
  const { data } = await supabase.from('mrp_runs').select('*').eq('id', id).maybeSingle()
  return (data as Run | null) ?? null
}

export async function runMaterials(runId: string): Promise<RunMaterial[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('mrp_run_materials').select('*').eq('run_id', runId).limit(5000)
  const rows = data ?? []
  const [mats, prices] = await Promise.all([materialsMap(rows.map((r) => r.material_id as string)), pricesMap(rows.map((r) => r.material_id as string))])
  const sups = await suppliersMap(rows.map((r) => r.supplier_id as string | null))
  const order = { critical: 0, high: 1, low: 2 } as const
  return rows.map((r) => {
    const m = mats.get(r.material_id as string)
    return {
      material_id: r.material_id as string, code: m?.code ?? '?', name: m?.name ?? '—', unit: m?.unit ?? 'pc', category: m?.category ?? 'other',
      supplier_id: (r.supplier_id as string | null) ?? null, supplier_name: r.supplier_id ? (sups.get(r.supplier_id as string)?.name ?? null) : null,
      gross: num(r.gross), on_hand: num(r.on_hand), reserved: num(r.reserved), safety: num(r.safety), receipts: num(r.receipts), net: num(r.net), suggested: num(r.suggested),
      lead_time_days: num(r.lead_time_days), moq: num(r.moq), order_multiple: num(r.order_multiple),
      first_need_date: (r.first_need_date as string | null) ?? null, shortage_date: (r.shortage_date as string | null) ?? null,
      alert: (r.alert as RunMaterial['alert']) ?? null, timeline: ((r.timeline as TimelinePoint[]) ?? []).map((t) => ({ ...t, gross: num(t.gross), receipts: num(t.receipts), planned: num(t.planned), projected: num(t.projected) })),
      unit_cost: prices.has(r.material_id as string) ? prices.get(r.material_id as string)! : null,
    } satisfies RunMaterial
  }).sort((a, b) => (a.alert ? order[a.alert] : 3) - (b.alert ? order[b.alert] : 3) || (a.shortage_date ?? '9').localeCompare(b.shortage_date ?? '9') || a.name.localeCompare(b.name))
}

export async function runSuggestions(runId: string): Promise<Suggestion[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('mrp_run_suggestions').select('*').eq('run_id', runId).order('release_date').limit(5000)
  const rows = data ?? []
  const [mats, prices] = await Promise.all([materialsMap(rows.map((r) => r.material_id as string)), pricesMap(rows.map((r) => r.material_id as string))])
  const sups = await suppliersMap(rows.map((r) => r.supplier_id as string | null))
  return rows.map((r) => {
    const m = mats.get(r.material_id as string)
    return {
      id: r.id as string, run_id: r.run_id as string, material_id: r.material_id as string, material_code: m?.code ?? '?', material_name: m?.name ?? '—', unit: m?.unit ?? 'pc',
      supplier_id: (r.supplier_id as string | null) ?? null, supplier_name: r.supplier_id ? (sups.get(r.supplier_id as string)?.name ?? null) : null,
      qty: num(r.qty), need_date: r.need_date as string, release_date: r.release_date as string, late: Boolean(r.late), status: r.status as Suggestion['status'],
      note: (r.note as string | null) ?? null, unit_cost: prices.has(r.material_id as string) ? prices.get(r.material_id as string)! : null,
    } satisfies Suggestion
  })
}

/** Origine d'un besoin : commandes / prévisions qui le génèrent. */
export async function runPegging(runId: string, materialId: string): Promise<PeggingRow[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('mrp_run_pegging').select('need_date,source_type,source_id,article_id,demand_qty,qty').eq('run_id', runId).eq('material_id', materialId).order('need_date').limit(2000)
  const rows = data ?? []
  const artIds = [...new Set(rows.map((r) => r.article_id as string))]
  const { data: arts } = artIds.length ? await supabase.from('articles').select('id,internal_ref,name').in('id', artIds) : { data: [] }
  const art = new Map((arts ?? []).map((a) => [a.id as string, a as { internal_ref: string; name: string }]))
  const lineIds = rows.filter((r) => r.source_type === 'order').map((r) => r.source_id as string)
  const { data: lines } = lineIds.length ? await supabase.from('sales_order_lines').select('id,order_id').in('id', lineIds) : { data: [] }
  const orderIds = [...new Set((lines ?? []).map((l) => l.order_id as string))]
  const { data: orders } = orderIds.length ? await supabase.from('sales_orders').select('id,code,client_ref').in('id', orderIds) : { data: [] }
  const ord = new Map((orders ?? []).map((o) => [o.id as string, o as { code: string; client_ref: string | null }]))
  const lineOrder = new Map((lines ?? []).map((l) => [l.id as string, l.order_id as string]))
  return rows.map((r) => {
    const oid = r.source_type === 'order' ? lineOrder.get(r.source_id as string) : undefined
    const o = oid ? ord.get(oid) : undefined
    return {
      need_date: r.need_date as string, source_type: r.source_type as PeggingRow['source_type'],
      source_label: r.source_type === 'order' ? (o ? `${o.code}${o.client_ref ? ` (${o.client_ref})` : ''}` : 'Commande supprimée') : 'Prévision',
      source_href: oid ? `/orders/${oid}` : null,
      article_ref: art.get(r.article_id as string)?.internal_ref ?? '?', article_name: art.get(r.article_id as string)?.name ?? '—', demand_qty: num(r.demand_qty), qty: num(r.qty),
    }
  })
}

export async function listForecasts(): Promise<Forecast[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('mrp_forecasts').select('*').order('forecast_date').limit(1000)
  const rows = data ?? []
  const ids = [...new Set(rows.map((r) => r.article_id as string))]
  const { data: arts } = ids.length ? await supabase.from('articles').select('id,internal_ref,name,client_id').in('id', ids) : { data: [] }
  const cids = [...new Set((arts ?? []).map((a) => a.client_id as string))]
  const { data: cl } = cids.length ? await supabase.from('clients').select('id,name').in('id', cids) : { data: [] }
  const cm = new Map((cl ?? []).map((c) => [c.id as string, c.name as string]))
  const am = new Map((arts ?? []).map((a) => [a.id as string, a]))
  return rows.map((r) => {
    const a = am.get(r.article_id as string)
    return { id: r.id as string, article_id: r.article_id as string, article_ref: (a?.internal_ref as string) ?? '?', article_name: (a?.name as string) ?? '—', client_name: a ? (cm.get(a.client_id as string) ?? '') : '',
      forecast_date: r.forecast_date as string, qty: num(r.qty), note: (r.note as string | null) ?? null }
  })
}

export async function articleOptions(): Promise<{ id: string; ref: string; name: string; client: string; has_bom: boolean }[]> {
  const supabase = await createClient()
  const [{ data: arts }, { data: clients }, { data: boms }] = await Promise.all([
    supabase.from('articles').select('id,internal_ref,name,client_id').neq('status', 'discontinued').order('internal_ref').limit(2000),
    supabase.from('clients').select('id,name').limit(2000),
    supabase.from('boms').select('article_id').not('article_id', 'is', null).not('active_version_id', 'is', null).is('archived_at', null),
  ])
  const cm = new Map((clients ?? []).map((c) => [c.id as string, c.name as string]))
  const hb = new Set((boms ?? []).map((b) => b.article_id as string))
  return (arts ?? []).map((a) => ({ id: a.id as string, ref: a.internal_ref as string, name: a.name as string, client: cm.get(a.client_id as string) ?? '', has_bom: hb.has(a.id as string) }))
}

export async function listParams(): Promise<ParamRow[]> {
  const supabase = await createClient()
  const [{ data: mats }, { data: prm }] = await Promise.all([
    supabase.from('bom_materials').select('id,code,name,unit,supplier_id').is('archived_at', null).order('name').limit(3000),
    supabase.from('mrp_params').select('material_id,lead_time_days,moq,order_multiple').limit(5000),
  ])
  const sups = await suppliersMap((mats ?? []).map((m) => m.supplier_id as string | null))
  const pm = new Map((prm ?? []).map((p) => [p.material_id as string, p]))
  return (mats ?? []).map((m) => {
    const p = pm.get(m.id as string)
    const s = m.supplier_id ? sups.get(m.supplier_id as string) : undefined
    return { material_id: m.id as string, code: m.code as string, name: m.name as string, unit: m.unit as string, supplier_name: s?.name ?? null, supplier_lead: s?.lead_time_days ?? null,
      lead_time_days: p ? ((p.lead_time_days as number | null) ?? null) : null, moq: p ? num(p.moq) : 0, order_multiple: p ? num(p.order_multiple) : 0 }
  })
}

export async function listReceipts(): Promise<Receipt[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('mrp_scheduled_receipts').select('*').order('due_date').limit(1000)
  const rows = data ?? []
  const mats = await materialsMap(rows.map((r) => r.material_id as string))
  return rows.map((r) => ({ id: r.id as string, material_id: r.material_id as string, material_code: mats.get(r.material_id as string)?.code ?? '?', material_name: mats.get(r.material_id as string)?.name ?? '—',
    unit: mats.get(r.material_id as string)?.unit ?? 'pc', qty: num(r.qty), due_date: r.due_date as string, reference: (r.reference as string | null) ?? null }))
}
