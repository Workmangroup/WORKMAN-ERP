'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'
import { getAuthContext } from '@/features/auth/services/access.service'
import { logAccessDenied } from '@/features/rbac/services/audit-write.service'

/** Les règles (séparation des tâches, transitions, délais, pouvoirs) sont appliquées par les fonctions SQL approval_* . */

export type ApprovalResult = { ok: true; state?: string; code?: string } | { ok: false; message: string }

const MESSAGES: Record<string, string> = {
  RBAC_FORBIDDEN: 'Vous n’avez pas le pouvoir de décider cette demande.',
  APPROVAL_REASON_REQUIRED: 'Le motif est obligatoire (10 caractères minimum pour un refus).',
  APPROVAL_NOT_FOUND: 'Demande introuvable.',
  APPROVAL_BAD_ACTION: 'Action inconnue.',
}
const TRANSITION_MESSAGES: Record<string, string> = {
  APPROVAL_BAD_TRANSITION: 'Cette demande n’est plus en attente : aucune action n’a été faite.',
  SOD_SELF_APPROVAL: 'Le demandeur ne peut pas décider sa propre demande. Tentative journalisée.',
  SOD_NOT_INDEPENDENT: 'Le second niveau doit être une autre personne que le premier. Tentative journalisée.',
  APPROVAL_NOT_OVERDUE: 'La demande n’est pas encore échue : pas d’escalade. Tentative journalisée.',
}

async function authorize(permissions: string[]): Promise<{ ok: true } | { ok: false; message: string }> {
  const ctx = await getAuthContext()
  if (!ctx) redirect('/login')
  if (!permissions.some((p) => ctx.permissions.includes(p))) {
    await logAccessDenied(ctx, permissions.join('|'), { via: 'server-action' })
    return { ok: false, message: MESSAGES.RBAC_FORBIDDEN }
  }
  return { ok: true }
}

const idSchema = z.uuid()
const reasonSchema = z.string().trim().min(1).max(500)

function fail(error: { message?: string }): { ok: false; message: string } {
  const code = error.message ?? ''
  return { ok: false, message: MESSAGES[code] ?? 'L’opération a échoué. Réessayez ou contactez un administrateur.' }
}

/** Résultat d'une décision : une tentative refusée par la règle (ok = false) est affichée avec son motif. */
function outcome(data: unknown): ApprovalResult {
  const d = (data ?? {}) as { ok?: boolean; state?: string; code?: string }
  if (d.ok === false) return { ok: false, message: TRANSITION_MESSAGES[d.code ?? ''] ?? 'Action refusée par la règle.' }
  return { ok: true, state: d.state }
}

export async function decideApprovalAction(requestId: string, action: 'approve' | 'refuse', reason: string): Promise<ApprovalResult> {
  const auth = await authorize([P.APPROVALS_DECIDE, P.APPROVALS_DECIDE_HIGH])
  if (!auth.ok) return auth
  if (!idSchema.safeParse(requestId).success) return { ok: false, message: 'Demande invalide.' }
  const r = reasonSchema.safeParse(reason)
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('approval_decide', { p_request: requestId, p_action: action, p_reason: r.success ? r.data : null })
  if (error) return fail(error)
  revalidatePath('/admin/approvals')
  return outcome(data)
}

export async function escalateApprovalAction(requestId: string, reason: string): Promise<ApprovalResult> {
  const auth = await authorize([P.APPROVALS_ESCALATE])
  if (!auth.ok) return auth
  if (!idSchema.safeParse(requestId).success) return { ok: false, message: 'Demande invalide.' }
  const r = reasonSchema.safeParse(reason)
  if (!r.success) return { ok: false, message: 'Le motif est obligatoire.' }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('approval_escalate', { p_request: requestId, p_reason: r.data })
  if (error) return fail(error)
  revalidatePath('/admin/approvals')
  return outcome(data)
}

export async function cancelApprovalAction(requestId: string, reason: string): Promise<ApprovalResult> {
  if (!idSchema.safeParse(requestId).success) return { ok: false, message: 'Demande invalide.' }
  const r = reasonSchema.safeParse(reason)
  if (!r.success) return { ok: false, message: 'Le motif est obligatoire.' }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('approval_cancel', { p_request: requestId, p_reason: r.data })
  if (error) return fail(error)
  revalidatePath('/admin/approvals')
  return outcome(data)
}
