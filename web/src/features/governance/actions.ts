'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { getAuthContext } from '@/features/auth/services/access.service'
import type { AuthContextValue, FormState } from '@/features/auth/types'
import { logAccessDenied } from '@/features/rbac/services/audit-write.service'
import { governanceErrorMessage, isGovernancePermissionError } from './errors'

/**
 * Écritures via la session de l'utilisateur : les fonctions SQL (RPC) appliquent les droits, la délégation
 * (date, objet, montant) et la séparation des tâches. Ici, on exige seulement une session valide et des
 * saisies correctes : une permission absente côté écran ne doit pas court-circuiter une délégation valide.
 */

const uuid = z.uuid()
const optUuid = z.string().trim().transform((v) => (v === '' ? null : v)).pipe(z.union([z.null(), z.uuid('Identifiant invalide')]))
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date invalide')
const reason = (min: number, max: number, label: string) => z.string().trim().min(min, `${label} : ${min} caractères minimum`).max(max, `${label} : ${max} caractères maximum`)
const money = z.string().trim().transform((v) => Number(v.replace(',', '.').replace(/\s/g, ''))).pipe(z.number().positive('Montant supérieur à 0').max(100_000_000, 'Montant trop grand'))

const DELEGABLE = {
  'payments.approve': 'payment_order',
  'derogations.approve': 'derogation',
  'derogations.control': 'derogation',
  'quality.approve': 'quality_inspection',
} as const

const delegationSchema = z.object({
  delegate: uuid,
  permission: z.enum(['payments.approve', 'derogations.approve', 'derogations.control', 'quality.approve']),
  object_id: optUuid,
  amount_limit: z.string().trim().transform((v) => (v === '' ? null : Number(v.replace(',', '.')))).pipe(z.union([z.null(), z.number().positive('Limite de montant supérieure à 0')])),
  ends_on: dateStr,
  reason: reason(5, 300, 'Motif'),
})

const DERO_KINDS = ['credit_limit', 'discount', 'price', 'shipping_certification', 'other'] as const

async function session(): Promise<{ ctx: AuthContextValue } | { error: FormState }> {
  const ctx = await getAuthContext()
  if (!ctx) redirect('/login')
  return { ctx }
}

async function run(fn: string, args: Record<string, unknown>, okMessage: string, path = '/governance'): Promise<FormState> {
  const s = await session()
  if ('error' in s) return s.error
  const supabase = await createClient()
  const { error } = await supabase.rpc(fn, args)
  if (error) {
    if (isGovernancePermissionError(error)) await logAccessDenied(s.ctx, fn, { via: 'database' })
    return { ok: false, message: governanceErrorMessage(error) }
  }
  revalidatePath(path)
  return { ok: true, message: okMessage }
}

const raw = (fd: FormData) => Object.fromEntries([...fd.entries()].filter(([k, v]) => typeof v === 'string' && !k.startsWith('$ACTION'))) as Record<string, string>
const invalid = (issue: z.ZodError): FormState => ({ ok: false, message: issue.issues[0]?.message ?? 'Saisie invalide.' })

/** Décision sur un ordre de paiement (approbation ou refus). */
export async function paymentOrderDecideAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const v = z.object({ id: uuid, decision: z.enum(['approve', 'reject']), comment: z.string().trim().max(300).optional() }).safeParse(raw(fd))
  if (!v.success) return invalid(v.error)
  const approve = v.data.decision === 'approve'
  return run('payment_order_decide', { p_order: v.data.id, p_approve: approve, p_comment: v.data.comment || null },
    approve ? 'Ordre de paiement approuvé.' : 'Ordre de paiement refusé.')
}

/** Préparation d'un ordre de paiement (sans l'approuver). */
export async function paymentOrderPrepareAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const v = z.object({ supplier: uuid, amount: money, reason: reason(5, 300, 'Motif') }).safeParse(raw(fd))
  if (!v.success) return invalid(v.error)
  return run('payment_order_prepare', { p_supplier: v.data.supplier, p_amount: v.data.amount, p_reason: v.data.reason }, 'Ordre de paiement préparé : en attente d’approbation par une autre personne.')
}

/** Exécution d'un ordre approuvé (règlement fournisseur). Le préparateur et les droits sont revérifiés en base. */
export async function paymentOrderExecuteAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const v = z.object({ id: uuid }).safeParse(raw(fd))
  if (!v.success) return invalid(v.error)
  return run('payment_order_execute', { p_order: v.data.id, p_paid_on: null }, 'Règlement enregistré à partir de l’ordre approuvé.')
}

/** Marquage d'un contrôle qualité comme lot critique (responsable qualité). */
export async function qualityMarkCriticalAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const v = z.object({ id: uuid, reason: reason(5, 300, 'Motif') }).safeParse(raw(fd))
  if (!v.success) return invalid(v.error)
  return run('quality_inspection_mark_critical', { p_inspection: v.data.id, p_reason: v.data.reason }, 'Contrôle marqué comme lot critique : sa libération sera soumise à un second contrôleur.')
}

/** Demande de dérogation. */
export async function derogationRequestAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const v = z.object({
    kind: z.enum(DERO_KINDS),
    object_type: z.string().trim().min(2, 'Objet concerné requis').max(40),
    object_id: optUuid,
    motive: reason(10, 500, 'Motif'),
    valid_until: dateStr,
  }).safeParse(raw(fd))
  if (!v.success) return invalid(v.error)
  return run('derogation_request', { p_kind: v.data.kind, p_object_type: v.data.object_type, p_object_id: v.data.object_id, p_motive: v.data.motive, p_valid_until: v.data.valid_until },
    'Dérogation demandée : en attente d’approbation.')
}

/** Approbation de premier niveau d'une dérogation (approve / reject). */
export async function derogationApproveAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const v = z.object({ id: uuid, decision: z.enum(['approve', 'reject']), comment: z.string().trim().max(300).optional() }).safeParse(raw(fd))
  if (!v.success) return invalid(v.error)
  const approve = v.data.decision === 'approve'
  return run('derogation_approve', { p_derogation: v.data.id, p_approve: approve, p_comment: v.data.comment || null },
    approve ? 'Dérogation approuvée : en attente du second contrôle.' : 'Dérogation refusée.')
}

/** Second contrôle indépendant (valider / rejeter). */
export async function derogationControlAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const v = z.object({ id: uuid, decision: z.enum(['approve', 'reject']), comment: z.string().trim().max(300).optional() }).safeParse(raw(fd))
  if (!v.success) return invalid(v.error)
  const ok = v.data.decision === 'approve'
  return run('derogation_control', { p_derogation: v.data.id, p_ok: ok, p_comment: v.data.comment || null },
    ok ? 'Dérogation contrôlée : effective pendant sa période de validité.' : 'Contrôle négatif : dérogation rejetée.')
}

/** Accorder une délégation datée et bornée (objet et/ou montant). */
export async function delegationGrantAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const v = delegationSchema.safeParse(raw(fd))
  if (!v.success) return invalid(v.error)
  const d = v.data
  const endsAt = new Date(`${d.ends_on}T23:59:59.000Z`)
  if (Number.isNaN(endsAt.getTime())) return { ok: false, message: 'Date de fin invalide.' }
  return run('delegation_grant', {
    p_delegate: d.delegate, p_permission: d.permission, p_object_type: DELEGABLE[d.permission], p_object_id: d.object_id,
    p_amount_limit: d.amount_limit, p_ends_at: endsAt.toISOString(), p_reason: d.reason, p_starts_at: null,
  }, 'Délégation accordée.')
}

/** Révoquer une délégation (par le délégant, ou avec delegations.manage). */
export async function delegationRevokeAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const v = z.object({ id: uuid, reason: z.string().trim().max(300) }).safeParse(raw(fd))
  if (!v.success) return invalid(v.error)
  return run('delegation_revoke', { p_delegation: v.data.id, p_reason: v.data.reason }, 'Délégation révoquée.')
}
