'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import type { FormState } from '@/features/auth/types'

/** Saisie d'un taux de change : la règle (une valeur par jour et par devise, droits, devise de base) est dans `fx_rate_set` (0027). */

const MESSAGES: [string, string][] = [
  ['RBAC_FORBIDDEN', 'Droit insuffisant : seule la finance peut saisir les taux.'],
  ['FX_RATE_INVALID', 'Taux invalide : il doit être supérieur à 0.'],
  ['FX_DATE_INVALID', 'Date invalide : pas plus d’un jour dans le futur.'],
  ['FX_CURRENCY_IS_BASE', 'Cette devise est la devise de base : aucun taux à saisir.'],
  ['FX_CURRENCY_UNKNOWN', 'Devise inconnue.'],
]

const schema = z.object({
  rate_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date invalide'),
  currency: z.string().regex(/^[A-Z]{3}$/, 'Devise invalide'),
  rate: z.string().trim().min(1, 'Taux requis')
    .transform((v) => Number(v.replace(',', '.')))
    .refine((n) => Number.isFinite(n) && n > 0, 'Taux supérieur à 0'),
})

export async function saveFxRateAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const parsed = schema.safeParse({
    rate_date: String(fd.get('rate_date') ?? ''),
    currency: String(fd.get('currency') ?? '').toUpperCase(),
    rate: String(fd.get('rate') ?? ''),
  })
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'Champs invalides.' }

  const supabase = await createClient()
  const { error } = await supabase.rpc('fx_rate_set', { p_date: parsed.data.rate_date, p_currency: parsed.data.currency, p_rate: parsed.data.rate })
  if (error) {
    const hit = MESSAGES.find(([code]) => error.message.includes(code))
    return { ok: false, message: hit?.[1] ?? 'Enregistrement impossible.' }
  }
  revalidatePath('/finance/devises')
  return { ok: true, message: 'Taux enregistré.' }
}
