export type AlertLevel = 'critical' | 'high' | 'low'

export interface RunSummary {
  materials: number
  critical: number
  high: number
  low: number
  suggestions: number
  late_suggestions: number
  orders_lines: number
  forecast_lines: number
  warnings: { article_id: string; ref: string; name: string; issue: 'no_bom' | 'incomplete'; qty: number }[]
}

export interface Run {
  id: string
  code: string
  name: string
  as_of: string
  params: { horizon_days: number; offset_days: number; include_forecasts: boolean; include_draft_orders: boolean; use_safety: boolean; default_lead_days: number }
  summary: RunSummary
  created_at: string
  created_by: string | null
}

export interface TimelinePoint { date: string; gross: number; receipts: number; planned: number; projected: number }

export interface RunMaterial {
  material_id: string
  code: string
  name: string
  unit: string
  category: string
  supplier_id: string | null
  supplier_name: string | null
  gross: number
  on_hand: number
  reserved: number
  safety: number
  receipts: number
  net: number
  suggested: number
  lead_time_days: number
  moq: number
  order_multiple: number
  first_need_date: string | null
  shortage_date: string | null
  alert: AlertLevel | null
  timeline: TimelinePoint[]
  unit_cost: number | null
}

export interface Suggestion {
  id: string
  run_id: string
  material_id: string
  material_code: string
  material_name: string
  unit: string
  supplier_id: string | null
  supplier_name: string | null
  qty: number
  need_date: string
  release_date: string
  late: boolean
  status: 'proposed' | 'accepted' | 'rejected'
  note: string | null
  unit_cost: number | null
}

export interface PeggingRow {
  need_date: string
  source_type: 'order' | 'forecast'
  source_label: string
  source_href: string | null
  article_ref: string
  article_name: string
  demand_qty: number
  qty: number
}

export interface Forecast {
  id: string
  article_id: string
  article_ref: string
  article_name: string
  client_name: string
  forecast_date: string
  qty: number
  note: string | null
}

export interface ParamRow {
  material_id: string
  code: string
  name: string
  unit: string
  supplier_name: string | null
  supplier_lead: number | null
  lead_time_days: number | null
  moq: number
  order_multiple: number
}

export interface Receipt {
  id: string
  material_id: string
  material_code: string
  material_name: string
  unit: string
  qty: number
  due_date: string
  reference: string | null
}
