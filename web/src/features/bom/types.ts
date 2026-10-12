import type { BomVersionStatus } from '@/lib/bom/options'

export interface Material {
  id: string
  company_id: string
  code: string
  name: string
  category: string
  unit: string
  color: string | null
  supplier_id: string | null
  description: string | null
  archived_at: string | null
  created_at: string
  updated_at: string
}

/** Composant + prix (le prix n'est présent qu'avec costs.read). */
export interface MaterialRow extends Material {
  unit_cost: number | null
  supplier_name: string | null
  usage_count: number
}

export interface Bom {
  id: string
  company_id: string
  code: string
  name: string
  kind: 'product' | 'subassembly'
  article_id: string | null
  description: string | null
  current_version_id: string | null
  active_version_id: string | null
  archived_at: string | null
  archived_by: string | null
  archive_reason: string | null
  created_at: string
  updated_at: string
}

export interface BomListRow extends Bom {
  article_ref: string | null
  article_client_ref: string | null
  client_name: string | null
  active_version_no: number | null
  /** Coût de revient figé de la version validée (costs.read uniquement). */
  cost_price: number | null
  line_count: number
}

export interface BomVersion {
  id: string
  bom_id: string
  version_no: number
  status: BomVersionStatus
  change_note: string | null
  validated_by: string | null
  validated_at: string | null
  validation_comment: string | null
  created_at: string
  created_by: string | null
}

export interface VersionCosting {
  version_id: string
  hourly_rate: number
  overhead_pct: number
  snap_total: number | null
  frozen_at: string | null
}

export interface BomFilters {
  q?: string
  kind?: string
  state?: string
  page?: number
}

// ---- Arbre renvoyé par la RPC bom_tree --------------------------------------------------------------
export interface TreeMaterialLine {
  id: string
  type: 'material'
  pos: number
  qty: number
  waste_pct: number
  note: string | null
  total_qty: number
  unit: string
  material: { id: string; code: string; name: string; category: string; unit: string; color: string | null; archived: boolean }
  unit_cost?: number | null
  cost?: number | null
}
export interface TreeBomLine {
  id: string
  type: 'bom'
  pos: number
  qty: number
  waste_pct: 0
  note: string | null
  total_qty: number
  unit: string
  child: { id: string; code: string; name: string; archived: boolean; validated: boolean }
  node: TreeNode | null
  cost?: number | null
}
export type TreeLine = TreeMaterialLine | TreeBomLine
export interface TreeOperation {
  id: string
  pos: number
  name: string
  minutes: number
  note: string | null
  total_minutes: number
  cost?: number
}
export interface TreeTotals {
  material: number
  labor: number
  overhead: number
  total: number
  minutes: number
  missing: string[]
}
export interface TreeNode {
  bom: { id: string; code: string; name: string; kind: 'product' | 'subassembly'; archived: boolean }
  version: { id: string; no: number; status: BomVersionStatus }
  lines: TreeLine[]
  operations: TreeOperation[]
  hourly_rate?: number
  overhead_pct?: number
  totals?: TreeTotals
}

export interface CostResult {
  live: TreeTotals
  frozen: { material: number; labor: number; overhead: number; total: number; frozen_at: string } | null
}
