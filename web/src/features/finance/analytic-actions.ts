'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import type { FormState } from '@/features/auth/types'

/** Analytique, clés d'allocation, budgets versionnés, engagements (0090). Les marges et écarts ont leur propre droit (costs.read). */

const MESSAGES: [string, string][] = [
  ['RBAC_FORBIDDEN', 'Droit insuffisant pour cette action.'],
  ['SOD_SELF_APPROVAL', 'Action refusée : elle doit être faite par une autre personne que l’auteur.'],
  ['ANALYTIC_WEIGHTS_NOT_100', 'Les pourcentages de la clé doivent totaliser exactement 100.'],
  ['ANALYTIC_OVER_TAGGED', 'Les rattachements dépassent le montant de la ligne comptable.'],
  ['ANALYTIC_ALREADY_ALLOCATED', 'Cette ligne est déjà allouée.'],
  ['ANALYTIC_BAD_LINE', 'Ligne non allouable : seules les charges et produits comptabilisés le sont.'],
  ['ANALYTIC_KEY_MISSING', 'Aucune version de clé applicable à cette date.'],
  ['ANALYTIC_KEY_NOT_VALIDATED', 'Clé non signée à cette date.'],
  ['ANALYTIC_NO_BUDGET', 'Aucun budget initial validé : révision impossible ou lecture sans budget.'],
  ['ANALYTIC_REASON_REQUIRED', 'Motif obligatoire (5 caractères min.).'],
  ['ANALYTIC_BAD_MEMBER', 'Membre inconnu ou incompatible avec la ligne (produit sur un centre, etc.).'],
  ['ANALYTIC_BAD_STATUS', 'Statut incompatible avec cette action.'],
  ['ANALYTIC_IMMUTABLE', 'Élément figé : modification refusée.'],
  ['ANALYTIC_EMPTY', 'Données manquantes.'],
  ['duplicate key', 'Valeur déjà utilisée.'],
]

async function run(fn: string, args: Record<string, unknown>, okMessage: string): Promise<FormState> {
  const supabase = await createClient()
  const { error } = await supabase.rpc(fn, args)
  if (error) {
    const hit = MESSAGES.find(([code]) => error.message.includes(code))
    return { ok: false, message: hit?.[1] ?? 'Action impossible.' }
  }
  revalidatePath('/finance/analytique')
  return { ok: true, message: okMessage }
}

const uuid = z.string().uuid()
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

export async function analyticMemberCreateAction(_p: FormState, fd: FormData): Promise<FormState> {
  const axis = z.enum(['center', 'product', 'order', 'workshop', 'channel']).safeParse(fd.get('axis'))
  const code = z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,29}$/).safeParse(fd.get('code'))
  const label = z.string().trim().min(2).max(120).safeParse(fd.get('label'))
  const kind = fd.get('kind') ? z.enum(['cost', 'profit']).safeParse(fd.get('kind')) : null
  const article = fd.get('article') ? uuid.safeParse(fd.get('article')) : null
  if (!axis.success || !code.success || !label.success || (kind && !kind.success) || (article && !article.success)) {
    return { ok: false, message: 'Axe, code, libellé ; genre (centre) et article (produit) selon l’axe.' }
  }
  return run('analytic_member_create', { p_axis: axis.data, p_code: code.data, p_label: label.data,
    p_kind: kind?.success ? kind.data : null, p_article: article?.success ? article.data : null }, 'Membre analytique créé.')
}

export async function analyticKeyCreateAction(_p: FormState, fd: FormData): Promise<FormState> {
  const code = z.string().regex(/^[A-Z0-9_]{2,30}$/).safeParse(fd.get('code'))
  const label = z.string().trim().min(2).max(120).safeParse(fd.get('label'))
  if (!code.success || !label.success) return { ok: false, message: 'Code et libellé obligatoires.' }
  return run('analytic_key_create', { p_code: code.data, p_label: label.data }, 'Clé créée.')
}

/** Pourcentages saisis « membre-uuid:pourcentage ; … » */
export async function analyticKeyVersionCreateAction(_p: FormState, fd: FormData): Promise<FormState> {
  const key = uuid.safeParse(fd.get('key'))
  const from = date.safeParse(fd.get('effective_from'))
  const parts = String(fd.get('weights') ?? '').split(';').map((x) => x.trim()).filter(Boolean)
  const weights = parts.map((p) => { const [m, pct] = p.split(':').map((x) => x.trim()); return { member: m, pct: Number(pct) } })
  if (!key.success || !from.success || weights.length === 0 || weights.some((w) => !uuid.safeParse(w.member).success || !(w.pct > 0))) {
    return { ok: false, message: 'Clé, date d’effet et pourcentages « membre:pourcentage ; … » obligatoires.' }
  }
  return run('analytic_key_version_create', { p_key: key.data, p_effective_from: from.data, p_weights: weights }, 'Version de clé enregistrée : à signer par une autre personne.')
}

export async function analyticKeyVersionValidateAction(_p: FormState, fd: FormData): Promise<FormState> {
  const id = uuid.safeParse(fd.get('id')); if (!id.success) return { ok: false, message: 'Version invalide.' }
  return run('analytic_key_version_validate', { p_version: id.data, p_validate: true }, 'Clé signée.')
}

export async function analyticAllocateAction(_p: FormState, fd: FormData): Promise<FormState> {
  const line = uuid.safeParse(fd.get('line')); const key = uuid.safeParse(fd.get('key'))
  if (!line.success || !key.success) return { ok: false, message: 'Ligne comptable et clé obligatoires.' }
  return run('analytic_allocate_line', { p_line: line.data, p_key: key.data }, 'Ligne allouée (formule enregistrée).')
}

export async function analyticBudgetVersionCreateAction(_p: FormState, fd: FormData): Promise<FormState> {
  const kind = z.enum(['initial', 'revised', 'forecast']).safeParse(fd.get('kind'))
  const year = z.coerce.number().int().min(2000).max(2100).safeParse(fd.get('year'))
  const reason = String(fd.get('reason') ?? '').trim() || null
  if (!kind.success || !year.success) return { ok: false, message: 'Nature et année obligatoires.' }
  return run('analytic_budget_version_create', { p_kind: kind.data, p_year: year.data, p_reason: reason }, 'Version de budget créée.')
}

/** Lignes JSON : [{kind:'product'|'center_expense', member, month, qty?, unit_price?, unit_cost?, amount?}] */
export async function analyticBudgetLinesSetAction(_p: FormState, fd: FormData): Promise<FormState> {
  const v = uuid.safeParse(fd.get('version'))
  let lines: unknown
  try { lines = JSON.parse(String(fd.get('lines') ?? '')) } catch { return { ok: false, message: 'Lignes : JSON invalide.' } }
  if (!v.success || !Array.isArray(lines)) return { ok: false, message: 'Version et lignes (JSON) obligatoires.' }
  return run('analytic_budget_lines_set', { p_version: v.data, p_lines: lines }, 'Lignes enregistrées.')
}

export async function analyticBudgetValidateAction(_p: FormState, fd: FormData): Promise<FormState> {
  const v = uuid.safeParse(fd.get('version')); if (!v.success) return { ok: false, message: 'Version invalide.' }
  return run('analytic_budget_version_validate', { p_version: v.data, p_validate: true }, 'Budget validé et figé.')
}

export async function analyticCommitmentAddAction(_p: FormState, fd: FormData): Promise<FormState> {
  const member = uuid.safeParse(fd.get('member'))
  const amount = z.coerce.number().positive().safeParse(fd.get('amount'))
  const ref = z.string().trim().min(3).max(80).safeParse(fd.get('reference'))
  const d = date.safeParse(fd.get('commitment_date'))
  if (!member.success || !amount.success || !ref.success || !d.success) return { ok: false, message: 'Centre, montant, référence et date obligatoires.' }
  return run('analytic_commitment_add', { p_member: member.data, p_amount: amount.data, p_reference: ref.data, p_date: d.data }, 'Engagement enregistré.')
}

export async function analyticCommitmentCloseAction(_p: FormState, fd: FormData): Promise<FormState> {
  const id = uuid.safeParse(fd.get('id'))
  const reason = z.string().trim().min(5).max(300).safeParse(fd.get('reason'))
  if (!id.success || !reason.success) return { ok: false, message: 'Motif d’au moins 5 caractères obligatoire.' }
  return run('analytic_commitment_close', { p_commitment: id.data, p_reason: reason.data }, 'Engagement clôturé.')
}
