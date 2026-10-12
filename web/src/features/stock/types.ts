import type { MovementType } from '@/lib/stock/options'

export interface Warehouse {
  id: string
  code: string
  name: string
  city: string | null
  address: string | null
  archived_at: string | null
}
export interface Location {
  id: string
  warehouse_id: string
  code: string
  name: string | null
  kind: string
  archived_at: string | null
}
export interface WarehouseWithLocations extends Warehouse {
  locations: (Location & { on_hand_lots: number })[]
}

export interface OverviewRow {
  material_id: string
  material_code: string
  material_name: string
  material_unit: string
  category: string
  warehouse_id: string
  warehouse_code: string
  warehouse_name: string
  on_hand: number
  reserved: number
  available: number
  safety_qty: number
  below_safety: boolean
}

export interface MovementRow {
  id: string
  seq: number
  type: MovementType
  direction: 'in' | 'out' | 'move'
  material_id: string
  material_code: string
  material_name: string
  unit: string
  qty: number
  warehouse_code: string
  location_code: string | null
  to_warehouse_code: string | null
  to_location_code: string | null
  reference: string | null
  reason: string | null
  created_at: string
  actor: string | null
  total_cost: number | null
  allocations: { lot_ref: string | null; received_at: string; qty: number }[]
}

export interface MovementFilters {
  type?: string
  q?: string
  warehouse?: string
  from?: string
  to?: string
  page?: number
}

export interface LotRow {
  id: string
  material_id: string
  material_code: string
  material_name: string
  unit: string
  warehouse_code: string
  location_code: string
  received_at: string
  reference: string | null
  qty_in: number
  qty_remaining: number
  unit_cost: number | null
}

export interface ReservationRow {
  id: string
  material_id: string
  material_code: string
  material_name: string
  unit: string
  warehouse_id: string
  warehouse_code: string
  qty: number
  qty_consumed: number
  status: 'active' | 'released' | 'consumed'
  reference: string
  note: string | null
  created_at: string
}

export interface InventoryRow {
  id: string
  code: string
  warehouse_id: string
  warehouse_code: string
  location_code: string | null
  status: 'draft' | 'validated' | 'cancelled'
  note: string | null
  created_at: string
  closed_at: string | null
  line_count: number
}
export interface InventoryLine {
  id: string
  material_id: string
  material_code: string
  material_name: string
  unit: string
  location_id: string
  location_code: string
  system_qty: number
  counted_qty: number | null
  applied_delta: number | null
}
