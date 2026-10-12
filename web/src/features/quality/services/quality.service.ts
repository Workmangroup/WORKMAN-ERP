import 'server-only'
import { createClient } from '@/lib/supabase/server'
import { recentAuditFor } from '@/features/rbac/services/audit-query.service'
import type { AuditRow } from '@/features/rbac/types'

export interface Inspection {
  id: string; number: string; kind: string; status: string; decision: string | null; material_id: string | null; article_id: string | null
  production_order_id: string | null; receipt_ref: string | null; sample_size: number; qty_accepted: number; qty_rejected: number
  note: string | null; opened_at: string; closed_at: string | null
}
export interface Defect { id: string; defect_code: string; category: string; severity: string; qty: number; note: string | null; created_at: string; inspection_id: string }
export interface DefectCode { id: string; code: string; label: string; category: string; default_severity: string }
export interface Nc {
  id: string; number: string; title: string; description: string | null; severity: string; status: string; inspection_id: string | null
  containment: string | null; root_cause: string | null; due_date: string | null; created_at: string; closed_at: string | null; close_note: string | null
}
export interface Action {
  id: string; number: string; nc_id: string; plan_id: string | null; kind: string; action: string; due_date: string; status: string
  done_at: string | null; verified_at: string | null; effective: boolean | null; cancel_reason: string | null
}
export interface Plan { id: string; number: string; title: string; objective: string | null; start_date: string; target_date: string; status: string; closed_at: string | null }
export interface HistoryRow {
  id: string; occurred_at: string; inspection_number: string; kind: string; decision: string | null; defect_code: string; defect_label: string | null
  category: string; severity: string; qty: number; note: string | null; inspection_id: string
}

export async function getDashboard() {
  const supabase = await createClient()
  const { data } = await supabase.rpc('quality_dashboard')
  return (data ?? {}) as {
    controls: { kind: string; closed: number; accepted: number; conditional: number; rejected: number; first_pass_pct: number | null; defects_per_unit: number | null }[]
    pareto: { code: string; label: string | null; category: string; qty: number }[]
    open_inspections: number; nc_open: number; nc_by_severity: Record<string, number>; actions_overdue: number
    action_effectiveness_pct: number | null; plans: Record<string, number>
  }
}

export async function listInspections(kind: string | null, status: string | null): Promise<Inspection[]> {
  const supabase = await createClient()
  let q = supabase.from('quality_inspections').select('*').order('opened_at', { ascending: false }).limit(200)
  if (kind) q = q.eq('kind', kind)
  if (status) q = q.eq('status', status)
  const { data } = await q
  return (data ?? []) as Inspection[]
}

export async function getInspection(id: string): Promise<Inspection | null> {
  const supabase = await createClient()
  const { data } = await supabase.from('quality_inspections').select('*').eq('id', id).maybeSingle()
  return (data as Inspection | null) ?? null
}

export async function listDefects(inspectionId: string): Promise<Defect[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('quality_defects').select('id,defect_code,category,severity,qty,note,created_at,inspection_id')
    .eq('inspection_id', inspectionId).order('created_at')
  return (data ?? []) as Defect[]
}

export async function listDefectCodes(): Promise<DefectCode[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('quality_defect_codes').select('id,code,label,category,default_severity').eq('active', true).order('code')
  return (data ?? []) as DefectCode[]
}

export async function listNcs(status: string | null): Promise<Nc[]> {
  const supabase = await createClient()
  let q = supabase.from('quality_nonconformities').select('*').order('created_at', { ascending: false }).limit(200)
  if (status === 'open') q = q.neq('status', 'closed')
  else if (status) q = q.eq('status', status)
  const { data } = await q
  return (data ?? []) as Nc[]
}

export async function getNc(id: string): Promise<Nc | null> {
  const supabase = await createClient()
  const { data } = await supabase.from('quality_nonconformities').select('*').eq('id', id).maybeSingle()
  return (data as Nc | null) ?? null
}

export async function listActions(filter: { ncId?: string; planId?: string }): Promise<Action[]> {
  const supabase = await createClient()
  let q = supabase.from('quality_corrective_actions').select('*').order('created_at')
  if (filter.ncId) q = q.eq('nc_id', filter.ncId)
  if (filter.planId) q = q.eq('plan_id', filter.planId)
  const { data } = await q
  return (data ?? []) as Action[]
}

export async function listPlans(): Promise<Plan[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('quality_action_plans').select('*').order('created_at', { ascending: false })
  return (data ?? []) as Plan[]
}

export async function listHistory(limit = 200): Promise<HistoryRow[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('quality_defect_history').select('*').order('occurred_at', { ascending: false }).limit(limit)
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    id: r.id as string, occurred_at: r.occurred_at as string, inspection_number: r.inspection_number as string, kind: r.kind as string,
    decision: (r.decision as string | null) ?? null, defect_code: r.defect_code as string, defect_label: (r.defect_label as string | null) ?? null,
    category: r.category as string, severity: r.severity as string, qty: Number(r.qty), note: (r.note as string | null) ?? null, inspection_id: r.inspection_id as string,
  }))
}

export async function sourceOptions() {
  const supabase = await createClient()
  const [mats, arts, orders] = await Promise.all([
    supabase.from('bom_materials').select('id,code,name').is('archived_at', null).order('name').limit(1000),
    supabase.from('articles').select('id,internal_ref,name').neq('status', 'discontinued').order('internal_ref').limit(1000),
    supabase.from('production_order_metrics').select('id,number,article_name').is('closed_at', null).order('number').limit(500),
  ])
  return {
    materials: (mats.data ?? []) as { id: string; code: string; name: string }[],
    articles: (arts.data ?? []) as { id: string; internal_ref: string; name: string }[],
    orders: (orders.data ?? []) as { id: string; number: string; article_name: string }[],
  }
}

export async function ncHistory(id: string): Promise<AuditRow[]> {
  return recentAuditFor('quality_nonconformity', id, 100)
}
