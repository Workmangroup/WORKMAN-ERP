import 'server-only'
import { createClient } from '@/lib/supabase/server'

/** Unités physiques (rouleaux, pièces) visibles selon l'accès aux entrepôts (RLS + private.wh_can). */
export interface UnitRow { id: string; code: string; material_name: string; warehouse: string; location: string; qty: number; length_m: number | null; width_cm: number | null; dye_bath: string | null; owner: string; status: string; received_at: string }
export async function listUnits(): Promise<UnitRow[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('material_units')
    .select('id,unit_code,qty,length_m,width_cm,dye_bath,owner_client_id,status,received_at,material_id,warehouse_id,location_id')
    .order('received_at', { ascending: false }).limit(300)
  const rows = data ?? []
  const mats = new Map<string, string>()
  const whs = new Map<string, string>()
  const locs = new Map<string, string>()
  const ids = (k: 'material_id' | 'warehouse_id' | 'location_id') => [...new Set(rows.map((r) => r[k] as string))]
  const [m, w, l] = await Promise.all([
    supabase.from('bom_materials').select('id,name').in('id', ids('material_id')),
    supabase.from('warehouses').select('id,code,name').in('id', ids('warehouse_id')),
    supabase.from('stock_locations').select('id,code').in('id', ids('location_id')),
  ])
  for (const x of m.data ?? []) mats.set(x.id as string, x.name as string)
  for (const x of w.data ?? []) whs.set(x.id as string, `${x.code} — ${x.name}`)
  for (const x of l.data ?? []) locs.set(x.id as string, x.code as string)
  return rows.map((r) => ({
    id: r.id as string, code: r.unit_code as string, material_name: mats.get(r.material_id as string) ?? '—', warehouse: whs.get(r.warehouse_id as string) ?? '—',
    location: locs.get(r.location_id as string) ?? '—', qty: Number(r.qty), length_m: r.length_m == null ? null : Number(r.length_m),
    width_cm: r.width_cm == null ? null : Number(r.width_cm), dye_bath: (r.dye_bath as string | null) ?? null,
    owner: r.owner_client_id ? 'Client' : 'Société', status: r.status as string, received_at: r.received_at as string,
  }))
}

/** Traçabilité complète d'une unité (historique et défauts). Refusée hors périmètre. */
export async function unitTrace(id: string) {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('material_unit_trace', { p_unit: id })
  return { data: (data as Record<string, unknown> | null) ?? null, error: error ?? null }
}
