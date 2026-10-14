import 'server-only'
import { createClient } from '@/lib/supabase/server'
import type { InventoryLine, InventoryRow, Location, LotRow, MovementFilters, MovementRow, OverviewRow, ReservationRow, Warehouse, WarehouseWithLocations } from '../types'

export const PAGE_SIZE = 40
const clean = (v: string | undefined) => (v ?? '').replace(/[%,()*\\:"{}]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
const num = (v: unknown) => Number(v ?? 0)

interface MatLite { id: string; code: string; name: string; unit: string; category: string }

async function materialsMap(ids: string[]): Promise<Map<string, MatLite>> {
  const out = new Map<string, MatLite>()
  const uniq = [...new Set(ids)]
  if (!uniq.length) return out
  const supabase = await createClient()
  for (let i = 0; i < uniq.length; i += 200) {
    const { data } = await supabase.from('bom_materials').select('id,code,name,unit,category').in('id', uniq.slice(i, i + 200))
    for (const m of data ?? []) out.set(m.id as string, m as MatLite)
  }
  return out
}

export async function listWarehouses(): Promise<WarehouseWithLocations[]> {
  const supabase = await createClient()
  const [{ data: wh }, { data: locs }, { data: lots }] = await Promise.all([
    supabase.from('warehouses').select('id,code,name,city,address,archived_at').order('code'),
    supabase.from('stock_locations').select('id,warehouse_id,code,name,kind,archived_at').order('code'),
    supabase.from('stock_lots').select('location_id').gt('qty_remaining', 0).limit(20000),
  ])
  const used = new Map<string, number>()
  for (const l of lots ?? []) used.set(l.location_id as string, (used.get(l.location_id as string) ?? 0) + 1)
  return ((wh ?? []) as Warehouse[]).map((w) => ({
    ...w,
    locations: ((locs ?? []) as Location[]).filter((l) => l.warehouse_id === w.id).map((l) => ({ ...l, on_hand_lots: used.get(l.id) ?? 0 })),
  }))
}

export async function listOverview(f: { q?: string; warehouse?: string; alerts?: boolean; category?: string }): Promise<OverviewRow[]> {
  const supabase = await createClient()
  let q = supabase.from('stock_overview').select('*').limit(3000)
  if (f.warehouse) q = q.eq('warehouse_id', f.warehouse)
  const [{ data }, { data: wh }] = await Promise.all([q, supabase.from('warehouses').select('id,code,name')])
  const rows = data ?? []
  const mats = await materialsMap(rows.map((r) => r.material_id as string))
  const whs = new Map((wh ?? []).map((w) => [w.id as string, w as { code: string; name: string }]))
  const term = clean(f.q).toLowerCase()
  return rows
    .map((r) => {
      const m = mats.get(r.material_id as string)
      const w = whs.get(r.warehouse_id as string)
      return {
        material_id: r.material_id as string, material_code: m?.code ?? '?', material_name: m?.name ?? '—', material_unit: m?.unit ?? 'pc', category: m?.category ?? 'other',
        warehouse_id: r.warehouse_id as string, warehouse_code: w?.code ?? '?', warehouse_name: w?.name ?? '—',
        on_hand: num(r.on_hand), reserved: num(r.reserved), available: num(r.available), safety_qty: num(r.safety_qty), below_safety: Boolean(r.below_safety),
      } satisfies OverviewRow
    })
    .filter((r) => (!term || `${r.material_code} ${r.material_name}`.toLowerCase().includes(term)) && (!f.alerts || r.below_safety) && (!f.category || r.category === f.category))
    .sort((a, b) => Number(b.below_safety) - Number(a.below_safety) || a.material_name.localeCompare(b.material_name) || a.warehouse_code.localeCompare(b.warehouse_code))
}

/** Valorisation FIFO = Σ quantité restante × coût du lot (vide sans costs.read). */
export async function stockValue(): Promise<number | null> {
  const supabase = await createClient()
  const { data: costs } = await supabase.from('stock_lot_costs').select('lot_id,unit_cost').limit(50000)
  if (!costs?.length) return null
  const unit = new Map(costs.map((c) => [c.lot_id as string, num(c.unit_cost)]))
  const { data: lots } = await supabase.from('stock_lots').select('id,qty_remaining').gt('qty_remaining', 0).limit(50000)
  return (lots ?? []).reduce((a, l) => a + num(l.qty_remaining) * (unit.get(l.id as string) ?? 0), 0)
}

export async function listMovements(f: MovementFilters): Promise<{ rows: MovementRow[]; total: number }> {
  const supabase = await createClient()
  const page = Math.max(1, f.page ?? 1)
  let matIds: string[] | null = null
  const term = clean(f.q)
  if (term) {
    const { data } = await supabase.from('bom_materials').select('id').or(`code.ilike.%${term}%,name.ilike.%${term}%`).limit(300)
    matIds = (data ?? []).map((m) => m.id as string)
  }
  let q = supabase.from('stock_movements').select('*', { count: 'exact' })
  if (f.type && ['in', 'out', 'transfer', 'adjustment', 'inventory'].includes(f.type)) q = q.eq('type', f.type)
  if (f.warehouse) q = q.or(`warehouse_id.eq.${f.warehouse},to_warehouse_id.eq.${f.warehouse}`)
  if (f.from && /^\d{4}-\d{2}-\d{2}$/.test(f.from)) q = q.gte('created_at', `${f.from}T00:00:00Z`)
  if (f.to && /^\d{4}-\d{2}-\d{2}$/.test(f.to)) q = q.lte('created_at', `${f.to}T23:59:59.999Z`)
  if (matIds) q = matIds.length ? q.in('material_id', matIds) : q.eq('material_id', '00000000-0000-0000-0000-000000000000')
  q = q.order('created_at', { ascending: false }).order('seq', { ascending: false }).range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1)
  const { data, count, error } = await q
  if (error) throw new Error(error.message)
  const mv = data ?? []
  const ids = mv.map((m) => m.id as string)
  const [mats, whRes, locRes, costRes, allocRes, users] = await Promise.all([
    materialsMap(mv.map((m) => m.material_id as string)),
    supabase.from('warehouses').select('id,code'),
    supabase.from('stock_locations').select('id,code'),
    ids.length ? supabase.from('stock_movement_costs').select('movement_id,total_cost').in('movement_id', ids) : Promise.resolve({ data: [] as { movement_id: string; total_cost: number }[] }),
    ids.length ? supabase.from('stock_movement_allocations').select('movement_id,lot_id,qty').in('movement_id', ids) : Promise.resolve({ data: [] as { movement_id: string; lot_id: string; qty: number }[] }),
    supabase.from('company_directory').select('id,full_name').in('id', [...new Set(mv.map((m) => m.created_by as string).filter(Boolean))]),
  ])
  const lotIds = [...new Set((allocRes.data ?? []).map((a) => a.lot_id as string))]
  const lotInfo = new Map<string, { reference: string | null; received_at: string }>()
  for (let i = 0; i < lotIds.length; i += 200) {
    const { data: ls } = await supabase.from('stock_lots').select('id,reference,received_at').in('id', lotIds.slice(i, i + 200))
    for (const l of ls ?? []) lotInfo.set(l.id as string, { reference: l.reference as string | null, received_at: l.received_at as string })
  }
  const wh = new Map((whRes.data ?? []).map((w) => [w.id as string, w.code as string]))
  const lc = new Map((locRes.data ?? []).map((l) => [l.id as string, l.code as string]))
  const cost = new Map((costRes.data ?? []).map((c) => [c.movement_id as string, num(c.total_cost)]))
  const actor = new Map((users.data ?? []).map((u) => [u.id as string, u.full_name as string]))
  return {
    total: count ?? 0,
    rows: mv.map((m) => {
      const mat = mats.get(m.material_id as string)
      return {
        id: m.id as string, seq: num(m.seq), type: m.type as MovementRow['type'], direction: m.direction as MovementRow['direction'],
        material_id: m.material_id as string, material_code: mat?.code ?? '?', material_name: mat?.name ?? '—', unit: mat?.unit ?? 'pc', qty: num(m.qty),
        warehouse_code: wh.get(m.warehouse_id as string) ?? '?', location_code: m.location_id ? (lc.get(m.location_id as string) ?? null) : null,
        to_warehouse_code: m.to_warehouse_id ? (wh.get(m.to_warehouse_id as string) ?? null) : null, to_location_code: m.to_location_id ? (lc.get(m.to_location_id as string) ?? null) : null,
        reference: (m.reference as string | null) ?? null, reason: (m.reason as string | null) ?? null, created_at: m.created_at as string,
        actor: m.created_by ? (actor.get(m.created_by as string) ?? null) : null, total_cost: cost.has(m.id as string) ? cost.get(m.id as string)! : null,
        allocations: (allocRes.data ?? []).filter((a) => a.movement_id === m.id).map((a) => ({
          lot_ref: lotInfo.get(a.lot_id as string)?.reference ?? null, received_at: lotInfo.get(a.lot_id as string)?.received_at ?? '', qty: num(a.qty),
        })).sort((a, b) => a.received_at.localeCompare(b.received_at)),
      }
    }),
  }
}

/** Couches FIFO : lots avec du stock restant, du plus ancien au plus récent. */
export async function listLots(f: { q?: string; warehouse?: string }): Promise<LotRow[]> {
  const supabase = await createClient()
  let q = supabase.from('stock_lots').select('id,material_id,warehouse_id,location_id,received_at,reference,qty_in,qty_remaining').gt('qty_remaining', 0).order('received_at').order('id').limit(2000)
  if (f.warehouse) q = q.eq('warehouse_id', f.warehouse)
  const [{ data }, { data: costs }, { data: wh }, { data: locs }] = await Promise.all([
    q, supabase.from('stock_lot_costs').select('lot_id,unit_cost').limit(50000),
    supabase.from('warehouses').select('id,code'), supabase.from('stock_locations').select('id,code'),
  ])
  const lots = data ?? []
  const mats = await materialsMap(lots.map((l) => l.material_id as string))
  const cost = new Map((costs ?? []).map((c) => [c.lot_id as string, num(c.unit_cost)]))
  const whm = new Map((wh ?? []).map((w) => [w.id as string, w.code as string]))
  const lm = new Map((locs ?? []).map((l) => [l.id as string, l.code as string]))
  const term = clean(f.q).toLowerCase()
  return lots.map((l) => {
    const m = mats.get(l.material_id as string)
    return {
      id: l.id as string, material_id: l.material_id as string, material_code: m?.code ?? '?', material_name: m?.name ?? '—', unit: m?.unit ?? 'pc',
      warehouse_code: whm.get(l.warehouse_id as string) ?? '?', location_code: lm.get(l.location_id as string) ?? '?', received_at: l.received_at as string,
      reference: (l.reference as string | null) ?? null, qty_in: num(l.qty_in), qty_remaining: num(l.qty_remaining), unit_cost: cost.has(l.id as string) ? cost.get(l.id as string)! : null,
    } satisfies LotRow
  }).filter((l) => !term || `${l.material_code} ${l.material_name} ${l.reference ?? ''}`.toLowerCase().includes(term))
}

export async function listReservations(f: { state?: string }): Promise<ReservationRow[]> {
  const supabase = await createClient()
  let q = supabase.from('stock_reservations').select('*').order('created_at', { ascending: false }).limit(500)
  if (f.state !== 'all') q = q.eq('status', 'active')
  const [{ data }, { data: wh }] = await Promise.all([q, supabase.from('warehouses').select('id,code')])
  const rows = data ?? []
  const mats = await materialsMap(rows.map((r) => r.material_id as string))
  const whm = new Map((wh ?? []).map((w) => [w.id as string, w.code as string]))
  return rows.map((r) => {
    const m = mats.get(r.material_id as string)
    return {
      id: r.id as string, material_id: r.material_id as string, material_code: m?.code ?? '?', material_name: m?.name ?? '—', unit: m?.unit ?? 'pc',
      warehouse_id: r.warehouse_id as string, warehouse_code: whm.get(r.warehouse_id as string) ?? '?', qty: num(r.qty), qty_consumed: num(r.qty_consumed),
      status: r.status as ReservationRow['status'], reference: r.reference as string, note: (r.note as string | null) ?? null, created_at: r.created_at as string,
    }
  })
}

export async function listInventories(): Promise<InventoryRow[]> {
  const supabase = await createClient()
  const [{ data }, { data: wh }, { data: locs }, { data: lines }] = await Promise.all([
    supabase.from('stock_inventories').select('*').order('created_at', { ascending: false }).limit(200),
    supabase.from('warehouses').select('id,code'), supabase.from('stock_locations').select('id,code'),
    supabase.from('stock_inventory_lines').select('inventory_id').limit(50000),
  ])
  const whm = new Map((wh ?? []).map((w) => [w.id as string, w.code as string]))
  const lm = new Map((locs ?? []).map((l) => [l.id as string, l.code as string]))
  const cnt = new Map<string, number>()
  for (const l of lines ?? []) cnt.set(l.inventory_id as string, (cnt.get(l.inventory_id as string) ?? 0) + 1)
  return (data ?? []).map((i) => ({
    id: i.id as string, code: i.code as string, warehouse_id: i.warehouse_id as string, warehouse_code: whm.get(i.warehouse_id as string) ?? '?',
    location_code: i.location_id ? (lm.get(i.location_id as string) ?? null) : null, status: i.status as InventoryRow['status'],
    phase: i.phase as InventoryRow['phase'],
    note: (i.note as string | null) ?? null, created_at: i.created_at as string, closed_at: (i.closed_at as string | null) ?? null, line_count: cnt.get(i.id as string) ?? 0,
  }))
}

export async function getInventory(id: string, canAdjust = false): Promise<{ inv: InventoryRow; lines: InventoryLine[]; locations: Location[] } | null> {
  const supabase = await createClient()
  const { data: i } = await supabase.from('stock_inventories').select('*').eq('id', id).maybeSingle()
  if (!i) return null
  // Lignes sans quantités : la table ne donne ni théorique ni comptage (comptage aveugle, 0066).
  const [{ data: wh }, { data: locs }, { data: lines }, { data: detail }] = await Promise.all([
    supabase.from('warehouses').select('code').eq('id', i.warehouse_id as string).maybeSingle(),
    supabase.from('stock_locations').select('id,warehouse_id,code,name,kind,archived_at').eq('warehouse_id', i.warehouse_id as string).order('code'),
    supabase.from('stock_inventory_lines').select('id,material_id,location_id,recount_needed').eq('inventory_id', id).limit(5000),
    canAdjust ? supabase.rpc('stock_inventory_reconcile', { p_inventory: id }) : supabase.rpc('stock_inventory_lines_for_count', { p_inventory: id }),
  ])
  const detailLines = new Map(((detail as { lines?: Record<string, unknown>[] } | null)?.lines ?? []).map((d) => [d.line_id as string, d]))
  const mats = await materialsMap((lines ?? []).map((l) => l.material_id as string))
  const lm = new Map((locs ?? []).map((l) => [l.id as string, l.code as string]))
  const rows: InventoryLine[] = (lines ?? []).map((l) => {
    const m = mats.get(l.material_id as string)
    const d = detailLines.get(l.id as string)
    return {
      id: l.id as string, material_id: l.material_id as string, material_code: m?.code ?? '?', material_name: m?.name ?? '—', unit: m?.unit ?? 'pc',
      location_id: l.location_id as string, location_code: lm.get(l.location_id as string) ?? '?',
      system_qty: canAdjust && d ? num(d.system_qty) : null,
      counted_qty: canAdjust && d && d.final_qty != null ? num(d.final_qty) : null,
      applied_delta: canAdjust && d && d.applied_delta != null ? num(d.applied_delta) : null,
      recount_needed: Boolean(l.recount_needed),
      my_rounds: !canAdjust && d && Array.isArray(d.my_rounds) ? (d.my_rounds as number[]) : [],
    }
  }).sort((a, b) => a.location_code.localeCompare(b.location_code) || a.material_name.localeCompare(b.material_name))
  return {
    inv: {
      id: i.id as string, code: i.code as string, warehouse_id: i.warehouse_id as string, warehouse_code: (wh?.code as string) ?? '?',
      location_code: i.location_id ? (lm.get(i.location_id as string) ?? null) : null, status: i.status as InventoryRow['status'],
      phase: i.phase as InventoryRow['phase'],
      note: (i.note as string | null) ?? null, created_at: i.created_at as string, closed_at: (i.closed_at as string | null) ?? null, line_count: rows.length,
    },
    lines: rows,
    locations: (locs ?? []) as Location[],
  }
}

/** Contexte des boîtes de dialogue de mouvement (composants, entrepôts, niveaux de stock, réservations actives). */
export async function stockContext(perms: string[]) {
  const [warehouses, overview, reservations, supabase] = await Promise.all([listWarehouses(), listOverview({}), listReservations({}), createClient()])
  const { data } = await supabase.from('bom_materials').select('id,code,name,unit').is('archived_at', null).order('name').limit(3000)
  const levels: Record<string, { on_hand: number; available: number }> = {}
  for (const r of overview) levels[`${r.material_id}|${r.warehouse_id}`] = { on_hand: r.on_hand, available: r.available }
  return {
    materials: (data ?? []) as { id: string; code: string; name: string; unit: string }[],
    warehouses, levels, reservations,
    canWrite: perms.includes('stock.write'), canAdjust: perms.includes('stock.adjust'), costs: perms.includes('costs.read'),
  }
}
