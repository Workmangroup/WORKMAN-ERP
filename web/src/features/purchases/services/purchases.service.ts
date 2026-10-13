import 'server-only'
import { createClient } from '@/lib/supabase/server'
import { directoryByIds } from '@/features/clients/services/clients.service'

const num = (v: unknown) => Number(v ?? 0)
const clean = (v: string | undefined) => (v ?? '').replace(/[%,()*\\:"{}]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)

export interface MatLite { id: string; code: string; name: string; unit: string }
export interface Money { amount: number }

async function materials(ids: string[]): Promise<Map<string, MatLite>> {
  const out = new Map<string, MatLite>()
  const uniq = [...new Set(ids)]
  const supabase = await createClient()
  for (let i = 0; i < uniq.length; i += 200) {
    const { data } = await supabase.from('bom_materials').select('id,code,name,unit').in('id', uniq.slice(i, i + 200))
    for (const m of data ?? []) out.set(m.id as string, m as MatLite)
  }
  return out
}
async function supplierNames(ids: (string | null)[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const uniq = [...new Set(ids.filter((x): x is string => !!x))]
  if (!uniq.length) return out
  const supabase = await createClient()
  const { data } = await supabase.from('suppliers').select('id,name').in('id', uniq)
  for (const s of data ?? []) out.set(s.id as string, s.name as string)
  return out
}

// ---------------------------------------------------------------------
// Demandes d'achat
// ---------------------------------------------------------------------
export type RequestStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'ordered' | 'cancelled'
export interface RequestRow {
  id: string; code: string; status: RequestStatus; needed_date: string | null; reason: string | null; source: 'manual' | 'mrp'
  requested_by: string | null; requester: string | null; created_at: string; line_count: number
}
export interface RequestLine {
  id: string; material_id: string; material_code: string; material_name: string; unit: string; qty: number
  supplier_id: string | null; supplier_name: string | null; default_supplier: string | null; has_default_supplier: boolean; needed_date: string | null; note: string | null; ordered: boolean
}

export async function listRequests(f: { status?: string; q?: string }): Promise<RequestRow[]> {
  const supabase = await createClient()
  let q = supabase.from('purchase_requests').select('*').order('created_at', { ascending: false }).limit(300)
  if (f.status && ['draft', 'submitted', 'approved', 'rejected', 'ordered', 'cancelled'].includes(f.status)) q = q.eq('status', f.status)
  const term = clean(f.q)
  if (term) q = q.or(`code.ilike.%${term}%,reason.ilike.%${term}%`)
  const { data } = await q
  const rows = data ?? []
  const [users, { data: lines }] = await Promise.all([
    directoryByIds(rows.map((r) => r.requested_by as string | null)),
    rows.length ? supabase.from('purchase_request_lines').select('request_id').in('request_id', rows.map((r) => r.id as string)).limit(20000) : Promise.resolve({ data: [] }),
  ])
  const cnt = new Map<string, number>()
  for (const l of lines ?? []) cnt.set(l.request_id as string, (cnt.get(l.request_id as string) ?? 0) + 1)
  return rows.map((r) => ({
    id: r.id as string, code: r.code as string, status: r.status as RequestStatus, needed_date: (r.needed_date as string | null) ?? null, reason: (r.reason as string | null) ?? null,
    source: r.source as 'manual' | 'mrp', requested_by: (r.requested_by as string | null) ?? null, requester: r.requested_by ? (users.get(r.requested_by as string)?.full_name ?? null) : null,
    created_at: r.created_at as string, line_count: cnt.get(r.id as string) ?? 0,
  }))
}

export async function getRequest(id: string) {
  const supabase = await createClient()
  const { data: r } = await supabase.from('purchase_requests').select('*').eq('id', id).maybeSingle()
  if (!r) return null
  const { data: ls } = await supabase.from('purchase_request_lines').select('*').eq('request_id', id).order('created_at')
  const lines = ls ?? []
  const [mats, sups, users] = await Promise.all([
    materials(lines.map((l) => l.material_id as string)),
    supplierNames(lines.map((l) => l.supplier_id as string | null)),
    directoryByIds([r.requested_by as string | null, r.decided_by as string | null]),
  ])
  const { data: mm } = lines.length ? await supabase.from('bom_materials').select('id,supplier_id').in('id', lines.map((l) => l.material_id as string)) : { data: [] }
  const defSup = await supplierNames((mm ?? []).map((m) => m.supplier_id as string | null))
  const matSup = new Map((mm ?? []).map((m) => [m.id as string, m.supplier_id as string | null]))
  const poLineIds = lines.map((l) => l.po_line_id as string | null).filter((x): x is string => !!x)
  const { data: pol } = poLineIds.length ? await supabase.from('purchase_order_lines').select('id,po_id').in('id', poLineIds) : { data: [] }
  const poIds = [...new Set((pol ?? []).map((p) => p.po_id as string))]
  const { data: pos } = poIds.length ? await supabase.from('purchase_orders').select('id,po_no,status,supplier_id').in('id', poIds) : { data: [] }
  const psup = await supplierNames((pos ?? []).map((p) => p.supplier_id as string))
  return {
    request: {
      id: r.id as string, code: r.code as string, status: r.status as RequestStatus, needed_date: (r.needed_date as string | null) ?? null, reason: (r.reason as string | null) ?? null,
      source: r.source as 'manual' | 'mrp', mrp_run_id: (r.mrp_run_id as string | null) ?? null, requested_by: (r.requested_by as string | null) ?? null,
      requester: r.requested_by ? (users.get(r.requested_by as string)?.full_name ?? null) : null, decider: r.decided_by ? (users.get(r.decided_by as string)?.full_name ?? null) : null,
      submitted_at: (r.submitted_at as string | null) ?? null, decided_at: (r.decided_at as string | null) ?? null, decision_comment: (r.decision_comment as string | null) ?? null, created_at: r.created_at as string,
      cost_center_id: (r.cost_center_id as string | null) ?? null,
    },
    lines: lines.map((l) => {
      const m = mats.get(l.material_id as string)
      const ds = matSup.get(l.material_id as string)
      return {
        id: l.id as string, material_id: l.material_id as string, material_code: m?.code ?? '?', material_name: m?.name ?? '—', unit: m?.unit ?? 'pc', qty: num(l.qty),
        supplier_id: (l.supplier_id as string | null) ?? null, supplier_name: l.supplier_id ? (sups.get(l.supplier_id as string) ?? null) : null,
        default_supplier: ds ? (defSup.get(ds) ?? null) : null, has_default_supplier: Boolean(ds), needed_date: (l.needed_date as string | null) ?? null, note: (l.note as string | null) ?? null, ordered: Boolean(l.po_line_id),
      } satisfies RequestLine
    }),
    orders: (pos ?? []).map((p) => ({ id: p.id as string, po_no: p.po_no as string, status: p.status as string, supplier: psup.get(p.supplier_id as string) ?? '—' })),
  }
}

// ---------------------------------------------------------------------
// Commandes fournisseur
// ---------------------------------------------------------------------
export type PoStatus = 'draft' | 'sent' | 'partial' | 'received' | 'cancelled'
export interface OrderRow {
  id: string; po_no: string; status: PoStatus; supplier_id: string; supplier_name: string; order_date: string; expected_date: string | null; received_date: string | null
  total_amount: number; request_id: string | null; line_count: number; ordered: number; received: number
}

export async function listOrders(f: { status?: string; supplier?: string; request?: string; q?: string }): Promise<OrderRow[]> {
  const supabase = await createClient()
  let q = supabase.from('purchase_orders').select('*').order('created_at', { ascending: false }).limit(300)
  if (f.status && ['draft', 'sent', 'partial', 'received', 'cancelled'].includes(f.status)) q = q.eq('status', f.status)
  if (f.supplier && /^[0-9a-f-]{36}$/i.test(f.supplier)) q = q.eq('supplier_id', f.supplier)
  if (f.request && /^[0-9a-f-]{36}$/i.test(f.request)) q = q.eq('request_id', f.request)
  const term = clean(f.q)
  if (term) q = q.or(`po_no.ilike.%${term}%,notes.ilike.%${term}%`)
  const { data } = await q
  const rows = data ?? []
  const [sups, { data: lines }] = await Promise.all([
    supplierNames(rows.map((r) => r.supplier_id as string)),
    rows.length ? supabase.from('purchase_order_lines').select('po_id,qty_ordered,qty_received,qty_returned').in('po_id', rows.map((r) => r.id as string)).limit(20000) : Promise.resolve({ data: [] }),
  ])
  const agg = new Map<string, { n: number; o: number; r: number }>()
  for (const l of lines ?? []) {
    const a = agg.get(l.po_id as string) ?? { n: 0, o: 0, r: 0 }
    a.n++; a.o += num(l.qty_ordered); a.r += num(l.qty_received) - num(l.qty_returned)
    agg.set(l.po_id as string, a)
  }
  return rows.map((r) => ({
    id: r.id as string, po_no: r.po_no as string, status: r.status as PoStatus, supplier_id: r.supplier_id as string, supplier_name: sups.get(r.supplier_id as string) ?? '—',
    order_date: r.order_date as string, expected_date: (r.expected_date as string | null) ?? null, received_date: (r.received_date as string | null) ?? null,
    total_amount: num(r.total_amount), request_id: (r.request_id as string | null) ?? null, line_count: agg.get(r.id as string)?.n ?? 0, ordered: agg.get(r.id as string)?.o ?? 0, received: agg.get(r.id as string)?.r ?? 0,
  }))
}

export interface OrderLine {
  id: string; material_id: string; material_code: string; material_name: string; unit: string; qty_ordered: number; unit_price: number
  expected_date: string | null; qty_received: number; qty_returned: number; note: string | null
}
export async function getOrder(id: string) {
  const supabase = await createClient()
  const { data: o } = await supabase.from('purchase_orders').select('*').eq('id', id).maybeSingle()
  if (!o) return null
  const [{ data: ls }, { data: rcs }, { data: sup }, { data: req }] = await Promise.all([
    supabase.from('purchase_order_lines').select('*').eq('po_id', id).order('created_at'),
    supabase.from('purchase_receipts').select('id,code,received_at,delivery_note,received_by,warehouse_id').eq('po_id', id).order('received_at', { ascending: false }),
    supabase.from('suppliers').select('id,name,lead_time_days,archived_at').eq('id', o.supplier_id as string).maybeSingle(),
    o.request_id ? supabase.from('purchase_requests').select('id,code').eq('id', o.request_id as string).maybeSingle() : Promise.resolve({ data: null }),
  ])
  const lines = ls ?? []
  const mats = await materials(lines.map((l) => l.material_id as string))
  const users = await directoryByIds((rcs ?? []).map((r) => r.received_by as string | null))
  return {
    order: { id: o.id as string, po_no: o.po_no as string, status: o.status as PoStatus, supplier_id: o.supplier_id as string, order_date: o.order_date as string, expected_date: (o.expected_date as string | null) ?? null,
      received_date: (o.received_date as string | null) ?? null, total_amount: num(o.total_amount), notes: (o.notes as string | null) ?? null, sent_at: (o.sent_at as string | null) ?? null, request_id: (o.request_id as string | null) ?? null },
    supplier: sup ? { id: sup.id as string, name: sup.name as string, lead_time_days: (sup.lead_time_days as number | null) ?? null, archived: Boolean(sup.archived_at) } : null,
    request: req ? { id: req.id as string, code: req.code as string } : null,
    lines: lines.map((l) => {
      const m = mats.get(l.material_id as string)
      return { id: l.id as string, material_id: l.material_id as string, material_code: m?.code ?? '?', material_name: m?.name ?? '—', unit: m?.unit ?? 'pc', qty_ordered: num(l.qty_ordered),
        unit_price: num(l.unit_price), expected_date: (l.expected_date as string | null) ?? null, qty_received: num(l.qty_received), qty_returned: num(l.qty_returned), note: (l.note as string | null) ?? null } satisfies OrderLine
    }),
    receipts: (rcs ?? []).map((r) => ({ id: r.id as string, code: r.code as string, received_at: r.received_at as string, delivery_note: (r.delivery_note as string | null) ?? null, by: r.received_by ? (users.get(r.received_by as string)?.full_name ?? null) : null })),
  }
}

// ---------------------------------------------------------------------
// Réceptions et retours
// ---------------------------------------------------------------------
export interface ReceiptRow { id: string; code: string; po_id: string; po_no: string; supplier_name: string; warehouse_code: string; delivery_note: string | null; received_at: string; line_count: number; amount: number }

export async function listReceipts(): Promise<ReceiptRow[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('purchase_receipts').select('*').order('received_at', { ascending: false }).limit(300)
  const rows = data ?? []
  const ids = rows.map((r) => r.id as string)
  const [{ data: lines }, { data: pos }, { data: whs }, sups] = await Promise.all([
    ids.length ? supabase.from('purchase_receipt_lines').select('receipt_id,qty,unit_price').in('receipt_id', ids).limit(20000) : Promise.resolve({ data: [] }),
    rows.length ? supabase.from('purchase_orders').select('id,po_no').in('id', [...new Set(rows.map((r) => r.po_id as string))]) : Promise.resolve({ data: [] }),
    supabase.from('warehouses').select('id,code'), supplierNames(rows.map((r) => r.supplier_id as string)),
  ])
  const agg = new Map<string, { n: number; a: number }>()
  for (const l of lines ?? []) { const a = agg.get(l.receipt_id as string) ?? { n: 0, a: 0 }; a.n++; a.a += num(l.qty) * num(l.unit_price); agg.set(l.receipt_id as string, a) }
  const pm = new Map((pos ?? []).map((p) => [p.id as string, p.po_no as string]))
  const wm = new Map((whs ?? []).map((w) => [w.id as string, w.code as string]))
  return rows.map((r) => ({ id: r.id as string, code: r.code as string, po_id: r.po_id as string, po_no: pm.get(r.po_id as string) ?? '?', supplier_name: sups.get(r.supplier_id as string) ?? '—',
    warehouse_code: wm.get(r.warehouse_id as string) ?? '?', delivery_note: (r.delivery_note as string | null) ?? null, received_at: r.received_at as string, line_count: agg.get(r.id as string)?.n ?? 0, amount: agg.get(r.id as string)?.a ?? 0 }))
}

export async function getReceipt(id: string) {
  const supabase = await createClient()
  const { data: r } = await supabase.from('purchase_receipts').select('*').eq('id', id).maybeSingle()
  if (!r) return null
  const [{ data: ls }, { data: po }, { data: wh }, { data: rets }, sups, users] = await Promise.all([
    supabase.from('purchase_receipt_lines').select('*').eq('receipt_id', id),
    supabase.from('purchase_orders').select('id,po_no').eq('id', r.po_id as string).maybeSingle(),
    supabase.from('warehouses').select('code,name').eq('id', r.warehouse_id as string).maybeSingle(),
    supabase.from('purchase_returns').select('*').eq('receipt_id', id).order('returned_at', { ascending: false }),
    supplierNames([r.supplier_id as string]), directoryByIds([r.received_by as string | null]),
  ])
  const lines = ls ?? []
  const mats = await materials(lines.map((l) => l.material_id as string))
  const locIds = [...new Set(lines.map((l) => l.location_id as string))]
  const { data: locs } = locIds.length ? await supabase.from('stock_locations').select('id,code').in('id', locIds) : { data: [] }
  const lm = new Map((locs ?? []).map((l) => [l.id as string, l.code as string]))
  const retIds = (rets ?? []).map((x) => x.id as string)
  const { data: rls } = retIds.length ? await supabase.from('purchase_return_lines').select('return_id,qty,material_id,unit_price').in('return_id', retIds) : { data: [] }
  const retMats = await materials((rls ?? []).map((l) => l.material_id as string))
  return {
    receipt: { id: r.id as string, code: r.code as string, po_id: r.po_id as string, warehouse_id: r.warehouse_id as string, po_no: (po?.po_no as string) ?? '?', supplier: sups.get(r.supplier_id as string) ?? '—', warehouse: wh ? `${wh.code} — ${wh.name}` : '?',
      delivery_note: (r.delivery_note as string | null) ?? null, notes: (r.notes as string | null) ?? null, received_at: r.received_at as string, by: r.received_by ? (users.get(r.received_by as string)?.full_name ?? null) : null },
    lines: lines.map((l) => { const m = mats.get(l.material_id as string); return { id: l.id as string, material_code: m?.code ?? '?', material_name: m?.name ?? '—', unit: m?.unit ?? 'pc', location: lm.get(l.location_id as string) ?? '?', qty: num(l.qty), qty_returned: num(l.qty_returned), unit_price: num(l.unit_price) } }),
    returns: (rets ?? []).map((x) => ({ id: x.id as string, code: x.code as string, reason: x.reason as string, returned_at: x.returned_at as string,
      lines: (rls ?? []).filter((l) => l.return_id === x.id).map((l) => ({ name: retMats.get(l.material_id as string)?.name ?? '—', unit: retMats.get(l.material_id as string)?.unit ?? 'pc', qty: num(l.qty), unit_price: num(l.unit_price) })) })),
  }
}

export interface ReturnRow { id: string; code: string; receipt_id: string; receipt_code: string; po_no: string; supplier_name: string; reason: string; returned_at: string; amount: number }
export async function listReturns(): Promise<ReturnRow[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('purchase_returns').select('*').order('returned_at', { ascending: false }).limit(300)
  const rows = data ?? []
  const ids = rows.map((r) => r.id as string)
  const [{ data: lines }, { data: rcs }, { data: pos }, sups] = await Promise.all([
    ids.length ? supabase.from('purchase_return_lines').select('return_id,qty,unit_price').in('return_id', ids).limit(20000) : Promise.resolve({ data: [] }),
    rows.length ? supabase.from('purchase_receipts').select('id,code').in('id', [...new Set(rows.map((r) => r.receipt_id as string))]) : Promise.resolve({ data: [] }),
    rows.length ? supabase.from('purchase_orders').select('id,po_no').in('id', [...new Set(rows.map((r) => r.po_id as string))]) : Promise.resolve({ data: [] }),
    supplierNames(rows.map((r) => r.supplier_id as string)),
  ])
  const amt = new Map<string, number>()
  for (const l of lines ?? []) amt.set(l.return_id as string, (amt.get(l.return_id as string) ?? 0) + num(l.qty) * num(l.unit_price))
  const rm = new Map((rcs ?? []).map((x) => [x.id as string, x.code as string])); const pm = new Map((pos ?? []).map((x) => [x.id as string, x.po_no as string]))
  return rows.map((r) => ({ id: r.id as string, code: r.code as string, receipt_id: r.receipt_id as string, receipt_code: rm.get(r.receipt_id as string) ?? '?', po_no: pm.get(r.po_id as string) ?? '?',
    supplier_name: sups.get(r.supplier_id as string) ?? '—', reason: r.reason as string, returned_at: r.returned_at as string, amount: amt.get(r.id as string) ?? 0 }))
}

// ---------------------------------------------------------------------
// Statistiques et listes de choix
// ---------------------------------------------------------------------
export interface PurchaseStats {
  period: { from: string; to: string }
  orders: number; amount: number; avg_order: number; open_count: number; open_amount: number; late_open: number; received_count: number
  on_time_rate: number | null; avg_delay_days: number | null; avg_lead_days: number | null
  received_amount: number; returned_amount: number; return_rate: number | null
  by_month: { month: string; amount: number; count: number }[]
  by_supplier: { supplier_id: string; name: string; orders: number; amount: number; on_time_rate: number | null; avg_lead_days: number | null }[]
  top_materials: { material_id: string; code: string; name: string; unit: string; qty: number; amount: number }[]
  requests: { draft: number; submitted: number; approved: number; rejected: number; ordered: number; avg_approval_hours: number | null }
}
export async function getStats(from?: string, to?: string): Promise<PurchaseStats | null> {
  const supabase = await createClient()
  const ok = (d?: string) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null)
  const { data, error } = await supabase.rpc('purchase_stats', { p_from: ok(from), p_to: ok(to) })
  if (error) return null
  return data as PurchaseStats
}

export async function supplierOptions(): Promise<{ id: string; name: string }[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('suppliers').select('id,name').is('archived_at', null).order('name').limit(1000)
  return (data ?? []) as { id: string; name: string }[]
}
export async function materialOptions(): Promise<{ id: string; code: string; name: string; unit: string; price: number | null; supplier_id: string | null }[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('bom_materials').select('id,code,name,unit,supplier_id').is('archived_at', null).order('name').limit(3000)
  const ids = (data ?? []).map((m) => m.id as string)
  const prices = new Map<string, number>()
  for (let i = 0; i < ids.length; i += 200) {
    const { data: pr } = await supabase.from('bom_material_prices').select('material_id,unit_cost').in('material_id', ids.slice(i, i + 200))
    for (const p of pr ?? []) prices.set(p.material_id as string, num(p.unit_cost))
  }
  return (data ?? []).map((m) => ({ id: m.id as string, code: m.code as string, name: m.name as string, unit: m.unit as string, price: prices.has(m.id as string) ? prices.get(m.id as string)! : null, supplier_id: (m.supplier_id as string | null) ?? null }))
}

// ---------------------------------------------------------------------
// Budgets et approbation des demandes (P032, migration 0057)
// ---------------------------------------------------------------------
export interface CostCenterOption { id: string; code: string; label: string }
export async function costCenterOptions(): Promise<CostCenterOption[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('cost_centers').select('id,code,label').is('archived_at', null).order('code').limit(500)
  return (data ?? []).map((c) => ({ id: c.id as string, code: c.code as string, label: c.label as string }))
}

/** État budgétaire d'un centre à une date : budget, engagé, réalisé, disponible (calcul SQL, lecture seule). */
export interface BudgetState { budget_id: string; period_start: string; period_end: string; amount: number; engaged: number; realised: number; available: number }
export async function budgetState(costCenterId: string, date: string | null): Promise<BudgetState | null> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('purchase_budget_summary', { p_cost_center: costCenterId, p_date: date })
  if (error || !data) return null
  const d = data as Record<string, unknown>
  return { budget_id: d.budget_id as string, period_start: d.period_start as string, period_end: d.period_end as string, amount: num(d.amount), engaged: num(d.engaged), realised: num(d.realised), available: num(d.available) }
}

export interface BudgetRow { id: string; cost_center_id: string; code: string; label: string; period_start: string; period_end: string; amount: number }
export async function budgetRows(): Promise<BudgetRow[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('purchase_budgets').select('id,cost_center_id,period_start,period_end,amount').order('period_start', { ascending: false }).limit(500)
  const rows = data ?? []
  const ccs = new Map((await costCenterOptions()).map((c) => [c.id, c]))
  return rows.map((b) => {
    const cc = ccs.get(b.cost_center_id as string)
    return { id: b.id as string, cost_center_id: b.cost_center_id as string, code: cc?.code ?? '—', label: cc?.label ?? 'Centre archivé', period_start: b.period_start as string, period_end: b.period_end as string, amount: num(b.amount) }
  })
}

/** Demande d'approbation la plus récente d'une demande d'achat (visible selon approvals.read). */
export interface RequestApproval { id: string; state: string; amount: number; levels: number; refusal_reason: string | null; deadline_at: string; object_version: number }
export async function requestApproval(requestId: string): Promise<RequestApproval | null> {
  const supabase = await createClient()
  const { data } = await supabase.from('approval_requests').select('id,state,amount,levels,refusal_reason,deadline_at,object_version')
    .eq('object_type', 'purchase_request').eq('object_id', requestId).order('object_version', { ascending: false }).limit(1).maybeSingle()
  if (!data) return null
  return { id: data.id as string, state: data.state as string, amount: num(data.amount), levels: num(data.levels), refusal_reason: (data.refusal_reason as string | null) ?? null, deadline_at: data.deadline_at as string, object_version: num(data.object_version) }
}


// ---------------------------------------------------------------------
// Versions, accord et confirmation des commandes (P034, migration 0059)
// ---------------------------------------------------------------------
export interface OrderState {
  approval_pending: boolean; current_version: number; approved_version: number | null; sent_version: number | null
  confirmed_version: number | null; confirmed_at: string | null; confirmation_reference: string | null
}
export async function orderState(id: string): Promise<OrderState | null> {
  const supabase = await createClient()
  const { data } = await supabase.from('purchase_orders')
    .select('approval_pending,current_version,approved_version,sent_version,confirmed_version,confirmed_at,confirmation_reference').eq('id', id).maybeSingle()
  if (!data) return null
  return {
    approval_pending: Boolean(data.approval_pending), current_version: num(data.current_version),
    approved_version: data.approved_version == null ? null : num(data.approved_version), sent_version: data.sent_version == null ? null : num(data.sent_version),
    confirmed_version: data.confirmed_version == null ? null : num(data.confirmed_version), confirmed_at: (data.confirmed_at as string | null) ?? null,
    confirmation_reference: (data.confirmation_reference as string | null) ?? null,
  }
}

export interface OrderVersion { id: string; version: number; kind: 'initial' | 'amendment' | 'legacy'; status: 'proposed' | 'approved' | 'refused' | 'superseded' | 'cancelled'; total: number; reason: string | null; created_at: string; decided_at: string | null }
/** Historique complet des versions d'une commande (aucune version n'est supprimée). */
export async function orderVersions(id: string): Promise<OrderVersion[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('purchase_order_versions').select('id,version,kind,status,total_amount,reason,created_at,decided_at')
    .eq('po_id', id).order('version', { ascending: false }).limit(200)
  return (data ?? []).map((v) => ({
    id: v.id as string, version: num(v.version), kind: v.kind as OrderVersion['kind'], status: v.status as OrderVersion['status'], total: num(v.total_amount),
    reason: (v.reason as string | null) ?? null, created_at: v.created_at as string, decided_at: (v.decided_at as string | null) ?? null,
  }))
}

// ---------------------------------------------------------------------
// Contrôle à la réception et rapprochement (P035, migration 0060)
// ---------------------------------------------------------------------
export interface ReceiptInspection { receipt_line_id: string; qty_accepted: number; qty_rejected: number; reason: string | null; decided_at: string }
export async function receiptInspections(receiptId: string): Promise<Record<string, ReceiptInspection>> {
  const supabase = await createClient()
  const { data } = await supabase.from('purchase_receipt_inspections').select('receipt_line_id,qty_accepted,qty_rejected,reason,decided_at').eq('receipt_id', receiptId)
  return Object.fromEntries((data ?? []).map((x) => [x.receipt_line_id as string, {
    receipt_line_id: x.receipt_line_id as string, qty_accepted: num(x.qty_accepted), qty_rejected: num(x.qty_rejected),
    reason: (x.reason as string | null) ?? null, decided_at: x.decided_at as string,
  }]))
}
export async function storageLocations(warehouseId: string): Promise<{ id: string; code: string; name: string | null }[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('stock_locations').select('id,code,name').eq('warehouse_id', warehouseId).eq('kind', 'storage').is('archived_at', null).order('code')
  return (data ?? []).map((l) => ({ id: l.id as string, code: l.code as string, name: (l.name as string | null) ?? null }))
}
export interface AcceptanceLine { po_line_id: string; qty_ordered: number; qty_received: number; qty_rejected: number; qty_accepted: number; qty_uncontrolled: number; qty_billable: number }
export async function orderAcceptance(poId: string): Promise<AcceptanceLine[]> {
  const supabase = await createClient()
  const { data } = await supabase.rpc('purchase_order_acceptance', { p_po: poId })
  return ((data ?? []) as Record<string, unknown>[]).map((x) => ({
    po_line_id: x.po_line_id as string, qty_ordered: num(x.qty_ordered), qty_received: num(x.qty_received), qty_rejected: num(x.qty_rejected),
    qty_accepted: num(x.qty_accepted), qty_uncontrolled: num(x.qty_uncontrolled), qty_billable: num(x.qty_billable),
  }))
}
export interface LinkedInvoice { id: string; number: string; supplier_ref: string; total: number; status: string; dispute_reason: string | null; match_status: string | null; match_gap: number | null }
export async function invoicesOfOrder(poId: string): Promise<LinkedInvoice[]> {
  const supabase = await createClient()
  const { data: inv } = await supabase.from('supplier_invoices').select('id,number,supplier_ref,total,status,dispute_reason').eq('purchase_order_id', poId).order('invoice_date')
  const ids = (inv ?? []).map((i) => i.id as string)
  const { data: ms } = ids.length ? await supabase.from('purchase_invoice_matches').select('invoice_id,status,gap,seq').in('invoice_id', ids).order('seq', { ascending: false }) : { data: [] }
  const last = new Map<string, { status: string; gap: number }>()
  for (const m of ms ?? []) if (!last.has(m.invoice_id as string)) last.set(m.invoice_id as string, { status: m.status as string, gap: num(m.gap) })
  return (inv ?? []).map((i) => ({
    id: i.id as string, number: i.number as string, supplier_ref: i.supplier_ref as string, total: num(i.total), status: i.status as string,
    dispute_reason: (i.dispute_reason as string | null) ?? null, match_status: last.get(i.id as string)?.status ?? null, match_gap: last.get(i.id as string)?.gap ?? null,
  }))
}

// ---------------------------------------------------------------------
// Évaluation fournisseur et délais (P036, migration 0061)
// ---------------------------------------------------------------------
export interface SupplierEvaluation {
  data_points: Record<string, number>
  indicators: Record<string, { value: number | null; numerator?: number; denominator?: number; formula: string; [k: string]: unknown }>
  confirmed_late: { receipts_after_due_date: number; formula: string }
  forecast_late: { open_orders_past_due: number; open_qty: number; formula: string }
  composite: { score: number; weights_sum: number; weights: Record<string, number>; formula: string } | null
  composite_missing: string[] | null
  flags: string[]
}
/** Calcul sans enregistrement (purchases.read). Les indicateurs sont explicables : numérateur, dénominateur, formule. */
export async function supplierEvaluationPreview(supplierId: string, from: string, to: string): Promise<{ data: SupplierEvaluation | null; error: { message?: string; code?: string; details?: string | null } | null }> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('supplier_evaluate_preview', { p_supplier: supplierId, p_from: from, p_to: to })
  return { data: (data as SupplierEvaluation | null) ?? null, error: error ?? null }
}
