import type { ChecklistItem, ProjectStatus, StageId } from '@/lib/development/options'

export interface DevProject {
  id: string; client_id: string; code: string; name: string; family: string; description: string | null; stage: StageId; status: ProjectStatus
  priority: 'low' | 'normal' | 'high' | 'urgent'; owner_id: string | null; requested_on: string; due_date: string | null; target_qty: number | null; product_id: string | null
  stage_changed_at: string; hold_reason: string | null; closed_at: string | null; created_at: string; updated_at: string
}
export interface DevProjectRow extends DevProject { client_name: string; owner_name: string | null; pending_validations: number; open_alerts: number }
export interface Prototype {
  id: string; project_id: string; version_no: number; name: string | null; description: string | null; status: 'planned' | 'in_progress' | 'ready' | 'approved' | 'rejected'
  owner_id: string | null; due_date: string | null; started_on: string | null; completed_on: string | null; feedback: string | null; created_at: string
}
export interface ProtoCost { id: string; prototype_id: string; kind: string; description: string; quantity: number; unit_cost: number; amount: number; incurred_on: string }
export interface Sample {
  id: string; project_id: string; version_no: number; prototype_id: string | null; status: 'planned' | 'in_progress' | 'sent' | 'approved' | 'rejected' | 'revision'
  qty: number; size_label: string | null; color: string | null; due_date: string | null; sent_on: string | null; tracking: string | null; notes: string | null
}
export interface Validation {
  id: string; project_id: string; kind: 'sample' | 'bat'; sample_id: string | null; version_no: number; status: 'pending' | 'approved' | 'rejected' | 'changes_requested'
  submitted_on: string; due_date: string | null; decided_on: string | null; decided_by_name: string | null; comment: string | null; reminder_count: number; last_reminder_on: string | null
}
export interface Industrialization {
  id: string; project_id: string; status: 'not_started' | 'in_progress' | 'ready' | 'released'; checklist: ChecklistItem[]; target_date: string | null
  pilot_qty: number | null; lead_time_days: number | null; bom_id: string | null; notes: string | null; ready_at: string | null; released_at: string | null
}
export interface Exchange { id: string; project_id: string; direction: string; channel: string; subject: string; body: string | null; contact_name: string | null; exchanged_on: string; created_at: string; created_by: string | null }
export interface DevDocument {
  id: string; project_id: string; ged_document_id: string; kind: string; note: string | null; created_at: string
  title: string; file_name: string | null; mime_type: string | null; size_bytes: number | null; status: string; valid_until: string | null; version_count: number; client_id: string
}
export interface DevAlert {
  type: string; severity: 'high' | 'medium' | 'low'; project_id: string; code: string; name: string; client_name: string; ref_id: string | null; ref: string
  due_date: string | null; since: string | null; days: number; reminders: number
}
export interface DevDashboard {
  by_stage: { stage: StageId; count: number }[]
  projects: { active: number; on_hold: number; completed: number; cancelled: number; overdue: number; in_production: number; avg_cycle_days: number | null; success_rate: number | null }
  validations: { pending: number; overdue: number; approved_90d: number; refused_90d: number; avg_response_days: number | null }
  work: { prototypes_open: number; samples_open: number; samples_at_client: number }
  by_priority: Record<string, number>
  by_client: { client: string; count: number }[]
  by_month: { month: string; count: number }[]
  costs?: { total: number; last_30d: number; by_project: { code: string; name: string; amount: number }[] }
}
export interface DevFilters { q?: string; stage?: string; status?: string; client?: string; priority?: string; page?: number }
