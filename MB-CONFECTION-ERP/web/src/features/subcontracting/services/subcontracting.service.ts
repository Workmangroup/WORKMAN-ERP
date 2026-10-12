import 'server-only'
import { createClient } from '@/lib/supabase/server'
import { recentAuditFor } from '@/features/rbac/services/audit-query.service'
import type { AuditRow } from '@/features/rbac/types'

export interface SubRow { id: string; code: string; name: string; services: string[]; country: string | null; city: string | null; contact_name: string | null; email: string | null; phone: string | null; default_lead_days: number; active: boolean; notes: string | null }
export interface OrderRow {
  id: string; code: string; subcontractor_id: string; subcontractor: string; service: string; product_id: string | null; product_code: string | null; description: string; qty: number
  qty_shipped: number; qty_received: number; qty_accepted: number; qty_rejected: number; status: string; requested_on: string; sent_on: string | null; due_date: string | null
  closed_at: string | null; cancel_reason: string | null; notes: string | null; created_at: string
}
export interface ShipmentRow { id: string; number: number; qty: number; shipped_on: string; carrier: string | null; tracking: string | null }
export interface ReceiptRow { id: string; number: number; qty_received: number; received_on: string; shipment_id: string | null; qc_status: string; qty_accepted: number; qty_rejected: number; qc_notes: string | null; stock_posted: boolean; variant_sku: string | null; warehouse: string | null; qc_at: string | null }
export interface CostRow { id: string; kind: string; description: string; quantity: number; unit_cost: number; amount: number; incurred_on: string; shipment_id: string | null }

const dbNum = (v: unknown) => (v === null || v === undefined ? 0 : Number(v))

export async function listSubcontractors(): Promise<SubRow[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('subcontractors').select('*').order('active', { ascending: false }).order('name')
  return ((data ?? []) as SubRow[]).map((s) => ({ ...s, default_lead_days: Number(s.default_lead_days) }))
}

export async function subcontractorOptions(): Promise<{ id: string; name: string; services: string[] }[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('subcontractors').select('id,name,services').eq('active', true).order('name')
  return (data ?? []) as { id: string; name: string; services: string[] }[]
}

export async function productOptions(): Promise<{ id: string; label: string }[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('product_master').select('id,code,name').neq('status', 'archived').order('code').limit(500)
  return (data ?? []).map((p) => ({ id: p.id as string, label: `${p.code} — ${p.name}` }))
}

export async function listOrders(f: { status?: string; sub?: string; q?: string; late?: boolean }): Promise<OrderRow[]> {
  const supabase = await createClient()
  let q = supabase.from('subcontract_orders').select('*').order('created_at', { ascending: false }).limit(300)
  if (f.status) q = q.eq('status', f.status)
  if (f.sub) q = q.eq('subcontractor_id', f.sub)
  if (f.late) q = q.in('status', ['sent', 'partially_received']).lt('due_date', new Date().toISOString().slice(0, 10))
  const term = (f.q ?? '').replace(/[%,()*\\:"{}]/g, ' ').trim().slice(0, 60)
  if (term) q = q.or(`code.ilike.%${term}%,description.ilike.%${term}%`)
  const { data } = await q
  const rows = data ?? []
  const subIds = [...new Set(rows.map((r) => r.subcontractor_id as string))]
  const prodIds = [...new Set(rows.map((r) => r.product_id as string | null).filter(Boolean) as string[])]
  const [{ data: subs }, { data: prods }] = await Promise.all([
    subIds.length ? supabase.from('subcontractors').select('id,name').in('id', subIds) : Promise.resolve({ data: [] }),
    prodIds.length ? supabase.from('product_master').select('id,code').in('id', prodIds) : Promise.resolve({ data: [] }),
  ])
  const sm = new Map((subs ?? []).map((s) => [s.id as string, s.name as string]))
  const pm = new Map((prods ?? []).map((p) => [p.id as string, p.code as string]))
  return rows.map((r) => ({
    id: r.id as string, code: r.code as string, subcontractor_id: r.subcontractor_id as string, subcontractor: sm.get(r.subcontractor_id as string) ?? '—',
    service: r.service as string, product_id: (r.product_id as string | null) ?? null, product_code: r.product_id ? pm.get(r.product_id as string) ?? null : null,
    description: r.description as string, qty: dbNum(r.qty), qty_shipped: dbNum(r.qty_shipped), qty_received: dbNum(r.qty_received), qty_accepted: dbNum(r.qty_accepted), qty_rejected: dbNum(r.qty_rejected),
    status: r.status as string, requested_on: r.requested_on as string, sent_on: (r.sent_on as string | null) ?? null, due_date: (r.due_date as string | null) ?? null,
    closed_at: (r.closed_at as string | null) ?? null, cancel_reason: (r.cancel_reason as string | null) ?? null, notes: (r.notes as string | null) ?? null, created_at: r.created_at as string,
  }))
}

export async function getOrder(id: string) {
  const supabase = await createClient()
  const { data: o } = await supabase.from('subcontract_orders').select('*').eq('id', id).maybeSingle()
  if (!o) return null
  const [{ data: sub }, { data: shipments }, { data: receipts }, { data: costs }, { data: prod }] = await Promise.all([
    supabase.from('subcontractors').select('*').eq('id', o.subcontractor_id as string).maybeSingle(),
    supabase.from('subcontract_shipments').select('*').eq('order_id', id).order('number'),
    supabase.from('subcontract_receipts').select('*').eq('order_id', id).order('number'),
    supabase.from('subcontract_costs').select('*').eq('order_id', id).order('incurred_on', { ascending: false }),
    o.product_id ? supabase.from('product_master').select('id,code,name').eq('id', o.product_id as string).maybeSingle() : Promise.resolve({ data: null }),
  ])
  const variantIds = [...new Set((receipts ?? []).map((r) => r.variant_id as string | null).filter(Boolean) as string[])]
  const whIds = [...new Set((receipts ?? []).map((r) => r.warehouse_id as string | null).filter(Boolean) as string[])]
  const [{ data: vars }, { data: whs }] = await Promise.all([
    variantIds.length ? supabase.from('product_variants').select('id,sku').in('id', variantIds) : Promise.resolve({ data: [] }),
    whIds.length ? supabase.from('warehouses').select('id,name').in('id', whIds) : Promise.resolve({ data: [] }),
  ])
  const vm = new Map((vars ?? []).map((v) => [v.id as string, v.sku as string]))
  const wm = new Map((whs ?? []).map((w) => [w.id as string, w.name as string]))
  const { data: variants } = o.product_id
    ? await supabase.from('product_variants').select('id,sku,color_id,size_id,active').eq('product_id', o.product_id as string).order('sku')
    : { data: [] }
  const { data: warehouses } = await supabase.from('warehouses').select('id,code,name').is('archived_at', null).order('name')
  const { data: subsAll } = await supabase.from('subcontractors').select('id,name,services').eq('active', true).order('name')
  return {
    order: {
      id: o.id as string, code: o.code as string, subcontractor_id: o.subcontractor_id as string, subcontractor: (sub?.name as string) ?? '—', service: o.service as string,
      product_id: (o.product_id as string | null) ?? null, product_code: (prod?.code as string | null) ?? null, description: o.description as string, qty: dbNum(o.qty),
      qty_shipped: dbNum(o.qty_shipped), qty_received: dbNum(o.qty_received), qty_accepted: dbNum(o.qty_accepted), qty_rejected: dbNum(o.qty_rejected), status: o.status as string,
      requested_on: o.requested_on as string, sent_on: (o.sent_on as string | null) ?? null, due_date: (o.due_date as string | null) ?? null, closed_at: (o.closed_at as string | null) ?? null,
      cancel_reason: (o.cancel_reason as string | null) ?? null, notes: (o.notes as string | null) ?? null, created_at: o.created_at as string,
    },
    subcontractor: sub ? { id: sub.id as string, name: sub.name as string, services: sub.services as string[], default_lead_days: dbNum(sub.default_lead_days) } : null,
    product: prod ? { id: prod.id as string, code: prod.code as string, name: prod.name as string } : null,
    shipments: ((shipments ?? []) as Record<string, unknown>[]).map((s) => ({ id: s.id as string, number: dbNum(s.number), qty: dbNum(s.qty), shipped_on: s.shipped_on as string, carrier: (s.carrier as string | null) ?? null, tracking: (s.tracking as string | null) ?? null })) as ShipmentRow[],
    receipts: ((receipts ?? []) as Record<string, unknown>[]).map((r) => ({
      id: r.id as string, number: dbNum(r.number), qty_received: dbNum(r.qty_received), received_on: r.received_on as string, shipment_id: (r.shipment_id as string | null) ?? null,
      qc_status: r.qc_status as string, qty_accepted: dbNum(r.qty_accepted), qty_rejected: dbNum(r.qty_rejected), qc_notes: (r.qc_notes as string | null) ?? null, stock_posted: Boolean(r.stock_posted),
      variant_sku: r.variant_id ? vm.get(r.variant_id as string) ?? null : null, warehouse: r.warehouse_id ? wm.get(r.warehouse_id as string) ?? null : null, qc_at: (r.qc_at as string | null) ?? null,
    })) as ReceiptRow[],
    costs: ((costs ?? []) as Record<string, unknown>[]).map((c) => ({ id: c.id as string, kind: c.kind as string, description: c.description as string, quantity: dbNum(c.quantity), unit_cost: dbNum(c.unit_cost), amount: dbNum(c.amount), incurred_on: c.incurred_on as string, shipment_id: (c.shipment_id as string | null) ?? null })) as CostRow[],
    variants: (variants ?? []) as { id: string; sku: string; color_id: string; size_id: string; active: boolean }[],
    warehouses: (warehouses ?? []) as { id: string; code: string; name: string }[],
    subcontractors: (subsAll ?? []) as { id: string; name: string; services: string[] }[],
    history: (await recentAuditFor('subcontract', id, 150)) as AuditRow[],
  }
}

export async function getDashboard(): Promise<Record<string, unknown> | null> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('subcontract_dashboard')
  if (error) return null
  return data as Record<string, unknown>
}

export interface PerfRow {
  id: string; code: string; name: string; services: string[]; default_lead_days: number; active: boolean; orders: number; qty_received: number; on_time: number; delivered: number
  avg_lead_days: number | null; avg_delay_days: number | null; rejection_rate: number | null; cost_total: number | null; cost_per_piece: number | null
}
export async function getPerformance(): Promise<PerfRow[]> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('subcontractor_performance')
  if (error || !data) return []
  return (data as Record<string, unknown>[]).map((r) => ({
    id: r.id as string, code: r.code as string, name: r.name as string, services: (r.services as string[]) ?? [], default_lead_days: dbNum(r.default_lead_days), active: Boolean(r.active),
    orders: dbNum(r.orders), qty_received: dbNum(r.qty_received), on_time: dbNum(r.on_time), delivered: dbNum(r.delivered),
    avg_lead_days: r.avg_lead_days === null || r.avg_lead_days === undefined ? null : Number(r.avg_lead_days),
    avg_delay_days: r.avg_delay_days === null || r.avg_delay_days === undefined ? null : Number(r.avg_delay_days),
    rejection_rate: r.rejection_rate === null || r.rejection_rate === undefined ? null : Number(r.rejection_rate),
    cost_total: r.cost_total === null || r.cost_total === undefined ? null : Number(r.cost_total),
    cost_per_piece: r.cost_per_piece === null || r.cost_per_piece === undefined ? null : Number(r.cost_per_piece),
  }))
}
