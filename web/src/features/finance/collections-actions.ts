'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import type { FormState } from '@/features/auth/types'

/** Recouvrement et trésorerie prévisionnelle (0091). Chaque action appelle une fonction SQL qui revérifie droits, état et séparation des tâches. */

const MESSAGES: [string, string][] = [
  ['RBAC_FORBIDDEN', 'Droit insuffisant pour cette action.'],
  ['SOD_SELF_APPROVAL', 'Action refusée : elle doit être faite par une autre personne que l’auteur.'],
  ['COLLECTION_NO_POLICY', 'Aucune politique de recouvrement validée à cette date : saisir et faire signer la politique d’abord.'],
  ['COLLECTION_NO_SCORE_MODEL', 'Modèle de score non signé ou non applicable à cette date.'],
  ['COLLECTION_HYPOTHESIS_NOT_VALID', 'Hypothèse de trésorerie non signée ou non applicable à cette date.'],
  ['COLLECTION_SEND_NOT_AUTHORIZED', 'La politique en vigueur n’autorise pas l’envoi externe : le brouillon reste interne.'],
  ['COLLECTION_PROMISE_AMOUNT', 'Montant de promesse invalide ou supérieur à l’exigible de la pièce (hors litige).'],
  ['COLLECTION_PROMISE_EXISTS', 'Cette pièce a déjà une promesse ouverte.'],
  ['COLLECTION_BAD_DATE', 'Date invalide : une promesse ne peut pas être antérieure à aujourd’hui.'],
  ['COLLECTION_PLAN_EXCEEDS_OVERDUE', 'Le plan dépasse le retard exigible du client (ou il n’y a pas de retard).'],
  ['COLLECTION_BAD_SCHEDULE', 'Échéancier invalide : montants positifs, dates futures et croissantes.'],
  ['COLLECTION_EMPTY', 'Échéancier vide.'],
  ['COLLECTION_REASON_REQUIRED', 'Motif obligatoire (5 caractères minimum).'],
  ['COLLECTION_BAD_STATUS', 'Statut incompatible avec cette action.'],
  ['COLLECTION_LOCKED', 'Élément figé : modification refusée.'],
  ['COLLECTION_APPEND_ONLY', 'Historique en ajout seul : suppression ou modification refusée.'],
  ['COLLECTION_BAD_HORIZON', 'Horizon de 1 à 53 semaines.'],
  ['COLLECTION_NOT_FOUND', 'Élément introuvable dans cette société.'],
  ['check constraint', 'Valeur hors des bornes autorisées.'],
  ['duplicate key', 'Valeur déjà utilisée.'],
]

async function run(fn: string, args: Record<string, unknown>, okMessage: string): Promise<FormState> {
  const supabase = await createClient()
  const { error } = await supabase.rpc(fn, args)
  if (error) {
    const hit = MESSAGES.find(([code]) => error.message.includes(code))
    return { ok: false, message: hit?.[1] ?? 'Action impossible.' }
  }
  revalidatePath('/finance/recouvrement')
  revalidatePath('/finance/tresorerie-previsionnelle')
  return { ok: true, message: okMessage }
}

const uuid = z.string().uuid()
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const code = z.string().regex(/^[A-Z0-9_]{3,40}$/)
const pct = z.coerce.number().min(0).max(100)
const bool = (v: FormDataEntryValue | null) => v === 'on'

export async function collectionPolicyCreateAction(_p: FormState, fd: FormData): Promise<FormState> {
  const c = code.safeParse(fd.get('code'))
  const eff = date.safeParse(fd.get('effective_from'))
  const n = [fd.get('contact_days'), fd.get('level2_days'), fd.get('level3_days'), fd.get('suspension_days')].map((x) => z.coerce.number().int().safeParse(x))
  if (!c.success || !eff.success || n.some((x) => !x.success)) return { ok: false, message: 'Code, date d’effet et seuils entiers obligatoires.' }
  return run('collection_policy_create', { p_code: c.data, p_effective_from: eff.data, p_contact_days: n[0].data, p_level2_days: n[1].data,
    p_level3_days: n[2].data, p_suspension_days: n[3].data, p_suspend_dispute: bool(fd.get('suspend_dispute')),
    p_suspend_commitment: bool(fd.get('suspend_commitment')), p_external_send: bool(fd.get('external_send')) }, 'Politique enregistrée : à faire signer par une autre personne.')
}

export async function collectionPolicyValidateAction(_p: FormState, fd: FormData): Promise<FormState> {
  const id = uuid.safeParse(fd.get('id'))
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  return run('collection_policy_validate', { p_id: id.data, p_validate: fd.get('validate') !== 'false' }, 'Politique traitée.')
}

export async function collectionScoreModelCreateAction(_p: FormState, fd: FormData): Promise<FormState> {
  const c = code.safeParse(fd.get('code'))
  const eff = date.safeParse(fd.get('effective_from'))
  const w = ['w_days', 'w_broken_promises', 'w_open_disputes', 'w_broken_plans', 'band_high_from'].map((k) => z.coerce.number().min(0).safeParse(fd.get(k)))
  if (!c.success || !eff.success || w.some((x) => !x.success)) return { ok: false, message: 'Code, date et pondérations positives obligatoires.' }
  return run('collection_score_model_create', { p_code: c.data, p_effective_from: eff.data, p_w_days: w[0].data, p_w_broken_promises: w[1].data,
    p_w_open_disputes: w[2].data, p_w_broken_plans: w[3].data, p_band_high_from: w[4].data }, 'Modèle de score enregistré : à faire signer.')
}

export async function collectionScoreModelValidateAction(_p: FormState, fd: FormData): Promise<FormState> {
  const id = uuid.safeParse(fd.get('id'))
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  return run('collection_score_model_validate', { p_id: id.data, p_validate: fd.get('validate') !== 'false' }, 'Modèle traité.')
}

export async function collectionScoresRunAction(_p: FormState, fd: FormData): Promise<FormState> {
  const model = uuid.safeParse(fd.get('model'))
  const asOf = date.safeParse(fd.get('as_of'))
  if (!model.success || !asOf.success) return { ok: false, message: 'Modèle et date obligatoires.' }
  return run('collection_scores_run', { p_model: model.data, p_as_of: asOf.data }, 'Scores calculés (les lignes existantes sont conservées).')
}

export async function cashHypothesisCreateAction(_p: FormState, fd: FormData): Promise<FormState> {
  const c = code.safeParse(fd.get('code'))
  const eff = date.safeParse(fd.get('effective_from'))
  const p = ['pct_not_due', 'pct_overdue', 'promise_pct', 'supplier_pay_pct', 'supplier_disputed_pct'].map((k) => pct.safeParse(fd.get(k)))
  const delay = z.coerce.number().int().min(0).max(365).safeParse(fd.get('delay_days'))
  if (!c.success || !eff.success || p.some((x) => !x.success) || !delay.success) return { ok: false, message: 'Code, date, pourcentages (0 à 100) et délai obligatoires.' }
  return run('cash_forecast_hypothesis_create', { p_code: c.data, p_effective_from: eff.data, p_pct_not_due: p[0].data, p_pct_overdue: p[1].data,
    p_delay_days: delay.data, p_promise_pct: p[2].data, p_supplier_pay_pct: p[3].data, p_supplier_disputed_pct: p[4].data }, 'Hypothèse enregistrée : à faire signer.')
}

export async function cashHypothesisValidateAction(_p: FormState, fd: FormData): Promise<FormState> {
  const id = uuid.safeParse(fd.get('id'))
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  return run('cash_forecast_hypothesis_validate', { p_id: id.data, p_validate: fd.get('validate') !== 'false' }, 'Hypothèse traitée.')
}

export async function cashForecastRunAction(_p: FormState, fd: FormData): Promise<FormState> {
  const h = uuid.safeParse(fd.get('hypothesis'))
  const asOf = date.safeParse(fd.get('as_of'))
  const weeks = z.coerce.number().int().min(1).max(53).safeParse(fd.get('weeks'))
  if (!h.success || !asOf.success || !weeks.success) return { ok: false, message: 'Hypothèse, date et horizon (1 à 53 semaines) obligatoires.' }
  return run('cash_forecast_run', { p_as_of: asOf.data, p_hypothesis: h.data, p_weeks: weeks.data }, 'Prévision figée : lignes sourcées enregistrées.')
}

export async function promiseCreateAction(_p: FormState, fd: FormData): Promise<FormState> {
  const inv = uuid.safeParse(fd.get('invoice'))
  const amount = z.coerce.number().positive().safeParse(fd.get('amount'))
  const on = date.safeParse(fd.get('promised_on'))
  const note = z.string().max(300).optional().safeParse(fd.get('note') ?? undefined)
  if (!inv.success || !amount.success || !on.success) return { ok: false, message: 'Pièce, montant et date de promesse obligatoires.' }
  return run('collection_promise_create', { p_invoice: inv.data, p_amount: amount.data, p_promised_on: on.data, p_note: note.success ? note.data || null : null },
    'Promesse enregistrée.')
}

export async function promiseFollowUpAction(_p: FormState, fd: FormData): Promise<FormState> {
  const asOf = date.safeParse(fd.get('as_of'))
  if (!asOf.success) return { ok: false, message: 'Date de suivi invalide.' }
  return run('collection_promise_follow_up', { p_as_of: asOf.data }, 'Suivi des promesses effectué.')
}

export async function promiseCancelAction(_p: FormState, fd: FormData): Promise<FormState> {
  const id = uuid.safeParse(fd.get('id'))
  const reason = z.string().trim().min(5).max(300).safeParse(fd.get('reason'))
  if (!id.success || !reason.success) return { ok: false, message: 'Motif obligatoire (5 caractères minimum).' }
  return run('collection_promise_cancel', { p_id: id.data, p_reason: reason.data }, 'Promesse annulée.')
}

export async function planCreateAction(_p: FormState, fd: FormData): Promise<FormState> {
  const client = uuid.safeParse(fd.get('client'))
  let lines: unknown
  try { lines = JSON.parse(String(fd.get('lines') ?? '')) } catch { return { ok: false, message: 'Échéancier : JSON invalide.' } }
  const parsed = z.array(z.object({ due_on: date, amount: z.coerce.number().positive() })).min(1).safeParse(lines)
  if (!client.success || !parsed.success) return { ok: false, message: 'Client et échéancier [{due_on, amount}] obligatoires.' }
  return run('payment_plan_create', { p_client: client.data, p_lines: parsed.data }, 'Plan créé : à faire signer par une autre personne.')
}

export async function planValidateAction(_p: FormState, fd: FormData): Promise<FormState> {
  const id = uuid.safeParse(fd.get('id'))
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  return run('payment_plan_validate', { p_id: id.data, p_validate: fd.get('validate') !== 'false' }, 'Plan traité.')
}

export async function planFollowUpAction(_p: FormState, fd: FormData): Promise<FormState> {
  const asOf = date.safeParse(fd.get('as_of'))
  if (!asOf.success) return { ok: false, message: 'Date de suivi invalide.' }
  return run('payment_plan_follow_up', { p_as_of: asOf.data }, 'Suivi des plans effectué.')
}

export async function remindersGenerateAction(_p: FormState, fd: FormData): Promise<FormState> {
  const asOf = date.safeParse(fd.get('as_of'))
  if (!asOf.success) return { ok: false, message: 'Date obligatoire.' }
  return run('collection_reminders_generate', { p_as_of: asOf.data }, 'Brouillons générés : aucun message n’est envoyé.')
}

export async function draftApproveAction(_p: FormState, fd: FormData): Promise<FormState> {
  const id = uuid.safeParse(fd.get('id'))
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  return run('collection_draft_approve', { p_id: id.data, p_approve: fd.get('approve') !== 'false' }, 'Brouillon traité.')
}

export async function draftAuthorizeSendAction(_p: FormState, fd: FormData): Promise<FormState> {
  const id = uuid.safeParse(fd.get('id'))
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  return run('collection_draft_authorize_send', { p_id: id.data }, 'Envoi autorisé et enregistré (l’envoi réel se fait hors de l’application).')
}

export async function escalationsRunAction(_p: FormState, fd: FormData): Promise<FormState> {
  const asOf = date.safeParse(fd.get('as_of'))
  if (!asOf.success) return { ok: false, message: 'Date obligatoire.' }
  return run('collection_escalations_run', { p_as_of: asOf.data }, 'Escalades calculées.')
}

export async function escalationCloseAction(_p: FormState, fd: FormData): Promise<FormState> {
  const id = uuid.safeParse(fd.get('id'))
  const res = z.string().trim().min(5).max(300).safeParse(fd.get('resolution'))
  if (!id.success || !res.success) return { ok: false, message: 'Motif de clôture obligatoire (5 caractères minimum).' }
  return run('collection_escalation_close', { p_id: id.data, p_resolution: res.data }, 'Escalade clôturée.')
}
