import 'server-only'
import { createClient } from '@/lib/supabase/server'

export interface ShipmentRow {
  id: string; number: string; status: string; sales_order_id: string; client_id: string; warehouse_id: string; incoterm: string | null
  destination_country: string | null; currency: string; carrier: string | null; tracking_number: string | null; packages: number | null
  gross_weight_kg: number | null; net_weight_kg: number | null; bl_number: string | null; bl_issued_at: string | null
  export_invoice_number: string | null; export_invoice_at: string | null; export_total: number | null; cancel_reason: string | null
  created_at: string; packed_at: string | null; shipped_at: string | null; delivered_at: string | null
}
export interface LineRow { id: string; shipment_id: string; variant_id: string; qty_requested: number; qty_picked: number; qty_shipped: number; unit_price: number; sku: string; product: string; color: string | null; size: string | null }
export interface EventRow { id: string; event_type: string; location: string | null; note: string | null; occurred_at: string }
export interface OrderToPrepare { id: string; code: string; client: string; ordered: number; allocated: number; due: string | null }

const EVENTS_LABEL: Record<string, string> = {
  created: 'Préparation créée', picked: 'Prélèvement', packed: 'Colisage', shipped: 'Expédition', in_transit: 'En transit',
  exception: 'Incident', delivered: 'Livrée', cancelled: 'Annulée',
}
export const eventLabel = (t: string) => EVENTS_LABEL[t] ?? t

export async function listShipments(status: string | null, limit = 200): Promise<ShipmentRow[]> {
  const supabase = await createClient()
  let q = supabase.from('shipments').select('*').order('created_at', { ascending: false }).limit(limit)
  if (status) q = q.eq('status', status)
  const { data } = await q
  return (data ?? []) as ShipmentRow[]
}

export async function getShipment(id: string): Promise<ShipmentRow | null> {
  const supabase = await createClient()
  const { data } = await supabase.from('shipments').select('*').eq('id', id).maybeSingle()
  return (data as ShipmentRow | null) ?? null
}

export async function listLines(shipmentId: string): Promise<LineRow[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('shipment_lines')
    .select('id,shipment_id,variant_id,qty_requested,qty_picked,qty_shipped,unit_price').eq('shipment_id', shipmentId).order('created_at')
  const rows = (data ?? []) as Omit<LineRow, 'sku' | 'product' | 'color' | 'size'>[]
  if (rows.length === 0) return []
  const { data: vars } = await supabase.from('product_variants').select('id,sku,product_id,color_id,size_id').in('id', rows.map((r) => r.variant_id))
  const vs = (vars ?? []) as { id: string; sku: string; product_id: string; color_id: string; size_id: string }[]
  const [prods, cols, sizes] = await Promise.all([
    supabase.from('product_master').select('id,name').in('id', [...new Set(vs.map((v) => v.product_id))]),
    supabase.from('colors').select('id,name'), supabase.from('sizes').select('id,code'),
  ])
  const pn = new Map((prods.data ?? []).map((p) => [p.id as string, p.name as string]))
  const cn = new Map((cols.data ?? []).map((c) => [c.id as string, c.name as string]))
  const sn = new Map((sizes.data ?? []).map((s) => [s.id as string, s.code as string]))
  const vm = new Map(vs.map((v) => [v.id, v]))
  return rows.map((r) => {
    const v = vm.get(r.variant_id)
    return { ...r, unit_price: Number(r.unit_price), sku: v?.sku ?? '—', product: v ? pn.get(v.product_id) ?? '—' : '—',
      color: v ? cn.get(v.color_id) ?? null : null, size: v ? sn.get(v.size_id) ?? null : null }
  })
}

export async function listEvents(shipmentId: string): Promise<EventRow[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('shipment_events').select('id,event_type,location,note,occurred_at').eq('shipment_id', shipmentId).order('occurred_at')
  return (data ?? []) as EventRow[]
}

/** Commandes confirmées avec leur taux d'affectation (pièces expédiables restantes). */
export async function ordersToPrepare(): Promise<OrderToPrepare[]> {
  const supabase = await createClient()
  const { data: orders } = await supabase.from('sales_orders').select('id,code,client_id').eq('status', 'confirmed').order('code').limit(200)
  const list = (orders ?? []) as { id: string; code: string; client_id: string }[]
  if (list.length === 0) return []
  const [lines, shipments, clients] = await Promise.all([
    supabase.from('sales_order_lines').select('order_id,qty,due_date').in('order_id', list.map((o) => o.id)),
    supabase.from('shipments').select('id,sales_order_id,status').in('sales_order_id', list.map((o) => o.id)).neq('status', 'cancelled'),
    supabase.from('clients').select('id,name').in('id', [...new Set(list.map((o) => o.client_id))]),
  ])
  const shipIds = (shipments.data ?? []).map((s) => s.id as string)
  const { data: sl } = shipIds.length ? await supabase.from('shipment_lines').select('shipment_id,qty_requested').in('shipment_id', shipIds) : { data: [] }
  const byShipment = new Map((shipments.data ?? []).map((s) => [s.id as string, s.sales_order_id as string]))
  const allocated = new Map<string, number>()
  for (const l of sl ?? []) {
    const o = byShipment.get(l.shipment_id as string)
    if (o) allocated.set(o, (allocated.get(o) ?? 0) + Number(l.qty_requested))
  }
  const cname = new Map((clients.data ?? []).map((c) => [c.id as string, c.name as string]))
  return list.map((o) => {
    const ls = (lines.data ?? []).filter((l) => l.order_id === o.id)
    const due = ls.map((l) => l.due_date as string).sort()[0] ?? null
    return { id: o.id, code: o.code, client: cname.get(o.client_id) ?? '—', ordered: ls.reduce((s, l) => s + Number(l.qty), 0),
      allocated: allocated.get(o.id) ?? 0, due }
  }).filter((o) => o.allocated < o.ordered)
}

export async function warehouseOptions(): Promise<{ id: string; code: string; name: string }[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('warehouses').select('id,code,name').is('archived_at', null).order('name')
  return (data ?? []) as { id: string; code: string; name: string }[]
}

export async function confirmedOrderOptions(): Promise<{ id: string; code: string }[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('sales_orders').select('id,code').eq('status', 'confirmed').order('code').limit(300)
  return (data ?? []) as { id: string; code: string }[]
}

export async function variantOptions(): Promise<{ id: string; sku: string; label: string; price: number }[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('product_variants').select('id,sku,price,product_id').order('sku').limit(1000)
  const vs = (data ?? []) as { id: string; sku: string; price: number | null; product_id: string }[]
  const { data: prods } = await supabase.from('product_master').select('id,name').in('id', [...new Set(vs.map((v) => v.product_id))])
  const pn = new Map((prods ?? []).map((p) => [p.id as string, p.name as string]))
  return vs.map((v) => ({ id: v.id, sku: v.sku, label: `${v.sku} — ${pn.get(v.product_id) ?? ''}`, price: Number(v.price ?? 0) }))
}

export async function getDashboard() {
  const supabase = await createClient()
  const { data } = await supabase.rpc('shipping_dashboard')
  return (data ?? {}) as {
    by_status: Record<string, number>; open: number; late_open: number; on_time_pct: number | null; avg_lead_time_days: number | null
    fill_rate_pct: number | null; packages_total: number; avg_gross_kg_per_shipment: number | null; exports_invoiced: number; export_total: number; exceptions_open: number
  }
}
