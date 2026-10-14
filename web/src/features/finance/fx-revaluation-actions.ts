'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import type { FormState } from '@/features/auth/types'

/** Taux de change (versions, signature), politique de réévaluation et réévaluations / reprises (0088). Aucune valeur n'est supposée. */

const MESSAGES: [string, string][] = [
  ['RBAC_FORBIDDEN', 'Droit insuffisant pour cette action.'],
  ['SOD_SELF_APPROVAL', 'Action refusée : elle doit être faite par une autre personne que l’auteur.'],
  ['FX_DATE_INVALID', 'Date de taux ou de réévaluation invalide.'],
  ['FX_CURRENCY_IS_BASE', 'La devise de base n’a pas de taux à saisir.'],
  ['FX_CURRENCY_UNKNOWN', 'Devise inconnue.'],
  ['FX_RATE_INVALID', 'Taux invalide.'],
  ['FX_BAD_STATUS', 'Cette version est déjà signée.'],
  ['FX_POLICY_MISSING', 'Politique de réévaluation absente : la saisir d’abord.'],
  ['FX_POLICY_NOT_VALIDATED', 'Politique non signée : réévaluation impossible.'],
  ['FX_POLICY_IMMUTABLE', 'Politique déjà signée : elle ne se modifie pas.'],
  ['FX_REVAL_ALREADY_RUN', 'Une réévaluation existe déjà à cette date.'],
  ['FX_REVAL_OPEN_RUN', 'Une réévaluation précédente n’est pas encore reprise.'],
  ['FX_RATE_NOT_VALIDATED', 'Taux du jour non signé pour une devise à réévaluer.'],
  ['FX_REVAL_ALREADY_REVERSED', 'Cette réévaluation est déjà reprise.'],
  ['FX_REVAL_NO_REVERSAL', 'La politique validée ne prévoit pas de reprise.'],
  ['FX_REVAL_REVERSAL_DATE', 'La reprise doit être datée après la réévaluation.'],
  ['FX_REVAL_NO_ENTRY', 'Réévaluation sans écriture : rien à reprendre.'],
  ['FX_REVAL_NOT_FOUND', 'Réévaluation introuvable.'],
  ['FX_IMMUTABLE', 'Élément figé : modification refusée.'],
  ['SOD_SELF_APPROVAL', 'Signature par une autre personne que la saisie.'],
]

async function run(fn: string, args: Record<string, unknown>, okMessage: string): Promise<FormState> {
  const supabase = await createClient()
  const { error } = await supabase.rpc(fn, args)
  if (error) {
    const hit = MESSAGES.find(([code]) => error.message.includes(code))
    return { ok: false, message: hit?.[1] ?? 'Action impossible.' }
  }
  revalidatePath('/finance/devises/reevaluation')
  return { ok: true, message: okMessage }
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const uuid = z.string().uuid()

export async function fxRateSetAction(_p: FormState, fd: FormData): Promise<FormState> {
  const d = date.safeParse(fd.get('rate_date'))
  const cur = z.string().regex(/^[A-Z]{3}$/).safeParse(String(fd.get('currency') ?? '').toUpperCase())
  const rate = z.coerce.number().positive().safeParse(fd.get('rate'))
  if (!d.success || !cur.success || !rate.success) return { ok: false, message: 'Date, devise (ISO) et taux obligatoires.' }
  return run('fx_rate_set', { p_date: d.data, p_currency: cur.data, p_rate: rate.data }, 'Version enregistrée : à signer par une autre personne.')
}

export async function fxRateValidateAction(_p: FormState, fd: FormData): Promise<FormState> {
  const id = uuid.safeParse(fd.get('id'))
  if (!id.success) return { ok: false, message: 'Taux invalide.' }
  return run('exchange_rate_validate', { p_rate: id.data, p_validate: true }, 'Taux signé.')
}

export async function fxPolicySetAction(_p: FormState, fd: FormData): Promise<FormState> {
  const method = z.enum(['reversal_next_period', 'no_reversal']).safeParse(fd.get('method'))
  if (!method.success) return { ok: false, message: 'Méthode de reprise obligatoire.' }
  return run('fx_policy_set', { p_method: method.data, p_rounding: 'per_document_base_minor' }, 'Politique enregistrée : à signer par une autre personne.')
}

export async function fxPolicyValidateAction(_p: FormState): Promise<FormState> {
  return run('fx_policy_validate', { p_validate: true }, 'Politique signée.')
}

export async function fxRevaluationRunAction(_p: FormState, fd: FormData): Promise<FormState> {
  const d = date.safeParse(fd.get('as_of'))
  if (!d.success) return { ok: false, message: 'Date de réévaluation obligatoire.' }
  return run('fx_revaluation_run', { p_as_of: d.data }, 'Réévaluation enregistrée (écriture OD équilibrée).')
}

export async function fxRevaluationReverseAction(_p: FormState, fd: FormData): Promise<FormState> {
  const id = uuid.safeParse(fd.get('id')); const d = date.safeParse(fd.get('reversal_date'))
  if (!id.success || !d.success) return { ok: false, message: 'Réévaluation et date de reprise obligatoires.' }
  return run('fx_revaluation_reverse', { p_run: id.data, p_date: d.data }, 'Reprise enregistrée.')
}
