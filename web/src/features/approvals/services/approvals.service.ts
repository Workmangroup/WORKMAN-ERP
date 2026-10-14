import 'server-only'
import { createClient } from '@/lib/supabase/server'

export interface ApprovalRequestRow {
  id: string
  object_type: string
  object_id: string
  object_version: number
  object_hash: string
  state: 'pending_l1' | 'pending_l2' | 'approved' | 'refused' | 'cancelled' | 'invalidated'
  levels: number
  amount: number | null
  requested_by: string
  requested_at: string
  deadline_at: string
  escalated_at: string | null
  refusal_reason: string | null
  decided_at: string | null
}

export interface ApprovalDecisionRow {
  id: number
  request_id: string
  level: number
  action: string
  actor_id: string
  on_behalf_of: string | null
  from_state: string | null
  to_state: string | null
  reason: string | null
  created_at: string
}

/** Demandes visibles par la politique RLS (société active et approvals.read). Les plus anciennes ouvertes d'abord. */
export async function listApprovalRequests(limit = 100): Promise<ApprovalRequestRow[]> {
  const supabase = await createClient()
  const { data } = await supabase
    .from('approval_requests')
    .select('id,object_type,object_id,object_version,object_hash,state,levels,amount,requested_by,requested_at,deadline_at,escalated_at,refusal_reason,decided_at')
    .order('requested_at', { ascending: false })
    .limit(limit)
  return (data ?? []) as ApprovalRequestRow[]
}

/** Journal des décisions d'une demande (ajout seul côté base). */
export async function decisionsOf(requestIds: string[]): Promise<Map<string, ApprovalDecisionRow[]>> {
  const out = new Map<string, ApprovalDecisionRow[]>()
  if (requestIds.length === 0) return out
  const supabase = await createClient()
  const { data } = await supabase
    .from('approval_decisions')
    .select('id,request_id,level,action,actor_id,on_behalf_of,from_state,to_state,reason,created_at')
    .in('request_id', requestIds)
    .order('id', { ascending: true })
  for (const d of (data ?? []) as ApprovalDecisionRow[]) out.set(d.request_id, [...(out.get(d.request_id) ?? []), d])
  return out
}
