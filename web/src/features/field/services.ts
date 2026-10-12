import 'server-only'
import { createClient } from '@/lib/supabase/server'

/** Lectures terrain : listes courtes, champs utiles seulement (réseau lent). Toutes passent par la session (RLS). */

export interface OrderCard { id: string; number: string; article_name: string; qty_good: number; qty_planned: number; status: string; late_days: number; work_center_code: string | null }
export interface InspectionCard { id: string; number: string; kind: string; sample_size: number }
export interface ShipmentCard { id: string; number: string; status: string }
export interface PickLine { id: string; sku: string; product: string; qty_requested: number; qty_picked: number }
export interface DefectCodeLite { code: string; label: string }

export async function openOrders(): Promise<OrderCard[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('production_order_metrics')
    .select('id,number,article_name,qty_good,qty_planned,status,late_days,work_center_code')
    .is('closed_at', null).neq('status', 'done').order('late_days', { ascending: false }).limit(40)
  return (data ?? []) as OrderCard[]
}

export async function orderDetail(id: string): Promise<OrderCard | null> {
  const supabase = await createClient()
  const { data } = await supabase.from('production_order_metrics')
    .select('id,number,article_name,qty_good,qty_planned,status,late_days,work_center_code').eq('id', id).maybeSingle()
  return (data as OrderCard | null) ?? null
}

export async function openInspections(): Promise<InspectionCard[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('quality_inspections').select('id,number,kind,sample_size').eq('status', 'open').order('opened_at', { ascending: false }).limit(40)
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({ id: r.id as string, number: r.number as string, kind: r.kind as string, sample_size: Number(r.sample_size) }))
}

export async function inspectionDetail(id: string) {
  const supabase = await createClient()
  const { data } = await supabase.from('quality_inspections').select('id,number,kind,status,sample_size').eq('id', id).maybeSingle()
  if (!data) return null
  const { data: codes } = await supabase.from('quality_defect_codes').select('code,label').eq('active', true).order('code').limit(60)
  return { ...(data as { id: string; number: string; kind: string; status: string; sample_size: number }), codes: (codes ?? []) as DefectCodeLite[] }
}

export async function shipmentsToPick(): Promise<ShipmentCard[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('shipments').select('id,number,status').in('status', ['preparing', 'picking']).order('created_at').limit(40)
  return (data ?? []) as ShipmentCard[]
}

export async function pickLines(shipmentId: string): Promise<{ number: string; lines: PickLine[] } | null> {
  const supabase = await createClient()
  const { data: sh } = await supabase.from('shipments').select('number').eq('id', shipmentId).maybeSingle()
  if (!sh) return null
  const { data: rows } = await supabase.from('shipment_lines').select('id,variant_id,qty_requested,qty_picked').eq('shipment_id', shipmentId).order('created_at')
  const list = (rows ?? []) as { id: string; variant_id: string; qty_requested: number; qty_picked: number }[]
  if (list.length === 0) return { number: sh.number as string, lines: [] }
  const { data: vars } = await supabase.from('product_variants').select('id,sku,product_id').in('id', list.map((l) => l.variant_id))
  const vm = new Map(((vars ?? []) as { id: string; sku: string; product_id: string }[]).map((v) => [v.id, v]))
  const { data: prods } = await supabase.from('product_master').select('id,name').in('id', [...new Set([...vm.values()].map((v) => v.product_id))])
  const pn = new Map(((prods ?? []) as { id: string; name: string }[]).map((p) => [p.id, p.name]))
  return {
    number: sh.number as string,
    lines: list.map((l) => {
      const v = vm.get(l.variant_id)
      return { id: l.id, sku: v?.sku ?? '—', product: v ? pn.get(v.product_id) ?? '' : '', qty_requested: l.qty_requested, qty_picked: l.qty_picked }
    }),
  }
}

/** Matières à commander pour les tissus et fils (suggestions d'achat restreintes à ces catégories). */
export async function fabricNeeds(): Promise<{ code: string; name: string; unit: string; qty: number; due: string | null; late: boolean }[]> {
  const supabase = await createClient()
  const { data: mats } = await supabase.from('bom_materials').select('id,code,name,unit').in('category', ['fabric', 'thread'])
  const fabric = new Map(((mats ?? []) as { id: string; code: string; name: string; unit: string }[]).map((m) => [m.id, m]))
  const { data } = await supabase.rpc('copilot_purchase_suggestions')
  return ((data ?? []) as Record<string, string | number | null>[])
    .filter((r) => fabric.has(String(r.material_id)))
    .map((r) => {
      const m = fabric.get(String(r.material_id))!
      return { code: m.code, name: m.name, unit: m.unit, qty: Number(r.qty), due: (r.due_date as string | null) ?? null, late: r.severity === 'critical' }
    })
}
