/** Forme renvoyée par executive_dashboard() (0023). Un bloc vaut null lorsque l'utilisateur n'a pas le droit du module. */
export interface ExecutiveAlert { severity: 'critical' | 'warning' | 'info'; module: string; title: string; detail: string; link: string }

export interface ExecutiveSnapshot {
  generated_at: string
  period_months: number
  access: Record<string, boolean>
  ca: null | { current_month: number; previous_month: number; ytd: number; open_balance: number; series: { month: string; amount: number }[] }
  marge: null | { estimate: string; current_month_rate_pct: number | null; series: { month: string; revenue: number; cost: number; margin: number; rate_pct: number | null }[] }
  stocks: null | { finished_units: number; finished_reserved: number; finished_value: number; raw_materials_in_stock: number; raw_lots_open: number }
  production: null | { by_status: Record<string, number>; open: number; closed: number; late: number; yield_pct: number | null; productivity: number | null
    workload: { code: string; name: string; open_hours: number; load_days: number | null; overloaded: boolean }[] }
  achats: null | { open_orders: number; open_value: number; late_orders: number; received_this_month: number }
  mrp: null | { run: string; as_of: string; proposed: number; late: number }
  finance: null | { treasury: { balance: number }; receivables: number; receivables_overdue: number; dso_days: number | null; payables: number;
    payables_due_14d: number; payables_disputed: number; reminders_pending: number; forecast_4w_net: number;
    forecast: { week: number; start: string; balance: number; net: number }[] }
  qualite: null | { open_inspections: number; nc_open: number; nc_by_severity: Record<string, number>; actions_overdue: number; action_effectiveness_pct: number | null;
    pareto: { code: string; label: string | null; qty: number }[]; controls: { kind: string; first_pass_pct: number | null }[] }
  expeditions: null | { by_status: Record<string, number>; open: number; late_open: number; on_time_pct: number | null; fill_rate_pct: number | null;
    avg_lead_time_days: number | null; exceptions_open: number }
  alerts: ExecutiveAlert[]
}
