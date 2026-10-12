import 'server-only'
import { createClient } from '@/lib/supabase/server'

/** Lectures des écrans « Délégations et contrôles ». La RLS de la base limite chaque ligne à ce que l'utilisateur peut voir. */

export type DelegationRow = {
  id: string
  delegator_id: string
  delegate_id: string
  permission: string
  object_type: string
  object_id: string | null
  amount_limit: number | null
  starts_at: string
  ends_at: string
  reason: string
  revoked_at: string | null
}

export type PaymentOrderRow = {
  id: string
  number: string
  supplier_id: string
  amount: number
  reason: string
  status: 'prepared' | 'approved' | 'rejected' | 'executed'
  prepared_by: string
  prepared_at: string
  decided_by: string | null
  decided_at: string | null
  decision_comment: string | null
  suppliers: { name: string } | null
}

export type DerogationRow = {
  id: string
  number: string
  kind: string
  object_type: string
  object_id: string | null
  motive: string
  valid_until: string
  status: 'requested' | 'approved' | 'controlled' | 'rejected'
  requested_by: string
  approved_by: string | null
  control_by: string | null
  decision_comment: string | null
}

export type Person = { id: string; full_name: string }
export type SupplierOption = { id: string; name: string }

export type OpenInspection = { id: string; number: string; kind: string; critical: boolean }

/** Contrôles qualité ouverts non marqués critiques (liste pour le responsable qualité). */
export async function getOpenInspections(): Promise<OpenInspection[]> {
  const supabase = await createClient()
  const { data, error } = await supabase.from('quality_inspections').select('id, number, kind, critical')
    .eq('status', 'open').eq('critical', false).order('opened_at', { ascending: false }).limit(50)
  if (error) throw new Error(error.message)
  return (data ?? []) as OpenInspection[]
}

/** Accès à l'écran : droit de gouvernance ou délégation active (vérifié en base). */
export async function hasGovernanceAccess(): Promise<boolean> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('governance_access')
  if (error) throw new Error(error.message)
  return data === true
}

export async function getGovernanceData() {
  const supabase = await createClient()
  const [delegations, payments, derogations, suppliers, people] = await Promise.all([
    supabase.from('delegations').select('id, delegator_id, delegate_id, permission, object_type, object_id, amount_limit, starts_at, ends_at, reason, revoked_at')
      .order('created_at', { ascending: false }).limit(100),
    supabase.from('payment_orders').select('id, number, supplier_id, amount, reason, status, prepared_by, prepared_at, decided_by, decided_at, decision_comment, suppliers(name)')
      .order('prepared_at', { ascending: false }).limit(100),
    supabase.from('derogations').select('id, number, kind, object_type, object_id, motive, valid_until, status, requested_by, approved_by, control_by, decision_comment')
      .order('requested_at', { ascending: false }).limit(100),
    supabase.from('suppliers').select('id, name').order('name').limit(500),
    supabase.rpc('company_people'),
  ])
  const failed = [delegations, payments, derogations, suppliers, people].find((r) => r.error)
  if (failed?.error) throw new Error(failed.error.message)
  return {
    delegations: (delegations.data ?? []) as DelegationRow[],
    payments: (payments.data ?? []) as unknown as PaymentOrderRow[],
    derogations: (derogations.data ?? []) as DerogationRow[],
    suppliers: (suppliers.data ?? []) as SupplierOption[],
    people: (people.data ?? []) as Person[],
  }
}
