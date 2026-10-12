import 'server-only'
import { createClient } from '@/lib/supabase/server'
import { recentAuditFor } from '@/features/rbac/services/audit-query.service'
import type { AuditRow } from '@/features/rbac/types'

export interface OrderMetric {
  id: string; number: string; status: string; article_id: string; article_ref: string; article_name: string
  work_center_id: string | null; work_center_code: string | null; work_center_name: string | null; hours_per_day: number | null; efficiency_pct: number | null
  qty_planned: number; std_minutes_per_unit: number; planned_start: string; planned_end: string
  launched_at: string | null; finished_at: string | null; closed_at: string | null
  planned_hours: number; hours_worked: number; created_by: string | null; qty_good: number; qty_scrap: number; yield_pct: number | null; productivity: number | null; late_days: number
}
export interface WorkCenter { id: string; code: string; name: string; kind: string; hours_per_day: number; efficiency_pct: number; active: boolean }
export interface LogRow { id: string; log_date: string; hours: number; qty_good: number; qty_scrap: number; note: string | null; work_center_id: string; created_at: string }
export interface Dashboard {
  by_status: Record<string, number>; open: number; closed: number; late: number; yield_pct: number | null; productivity: number | null
  workload: { work_center_id: string; code: string; name: string; open_hours: number; capacity_hours_per_day: number; load_days: number | null; overloaded: boolean; yield_pct: number | null; productivity: number | null }[]
  late_orders: { id: string; number: string; article: string; planned_end: string; late_days: number; status: string; work_center: string | null }[]
}

export async function listOrders(status: string | null, closed: boolean, limit = 200): Promise<OrderMetric[]> {
  const supabase = await createClient()
  let q = supabase.from('production_order_metrics').select('*').order('planned_start', { ascending: false }).limit(limit)
  if (status) q = q.eq('status', status)
  q = closed ? q.not('closed_at', 'is', null) : q.is('closed_at', null)
  const { data } = await q
  return (data ?? []) as OrderMetric[]
}

export async function getOrder(id: string): Promise<OrderMetric | null> {
  const supabase = await createClient()
  const { data } = await supabase.from('production_order_metrics').select('*').eq('id', id).maybeSingle()
  return (data as OrderMetric | null) ?? null
}

export async function listLogs(orderId: string): Promise<LogRow[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('production_logs').select('id,log_date,hours,qty_good,qty_scrap,note,work_center_id,created_at')
    .eq('order_id', orderId).order('log_date').order('created_at')
  return (data ?? []) as LogRow[]
}

export async function listWorkCenters(): Promise<WorkCenter[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('work_centers').select('id,code,name,kind,hours_per_day,efficiency_pct,active').order('code')
  return (data ?? []) as WorkCenter[]
}

export async function listArticleOptions(): Promise<{ id: string; internal_ref: string; name: string }[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('articles').select('id,internal_ref,name').neq('status', 'discontinued').order('internal_ref').limit(1000)
  return (data ?? []) as { id: string; internal_ref: string; name: string }[]
}

export async function getDashboard(): Promise<Dashboard> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('production_dashboard')
  if (error || !data) return { by_status: {}, open: 0, closed: 0, late: 0, yield_pct: null, productivity: null, workload: [], late_orders: [] }
  return data as Dashboard
}

export async function orderHistory(id: string): Promise<AuditRow[]> {
  return recentAuditFor('production_order', id, 100)
}
