'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import type { FormState } from '@/features/auth/types'

/** Clôture d'une période comptable : la règle (brouillons, droits) est dans `gl_close_period` (0031). */

const MESSAGES: [string, string][] = [
  ['RBAC_FORBIDDEN', 'Droit insuffisant : seule la finance peut clôturer une période.'],
  ['GL_DRAFT_ENTRIES', 'Impossible : des écritures sont encore en brouillon sur cette période.'],
]

const schema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
})

export async function closeGlPeriodAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const parsed = schema.safeParse({ year: fd.get('year'), month: fd.get('month') })
  if (!parsed.success) return { ok: false, message: 'Période invalide.' }

  const supabase = await createClient()
  const { error } = await supabase.rpc('gl_close_period', { p_year: parsed.data.year, p_month: parsed.data.month })
  if (error) {
    const hit = MESSAGES.find(([code]) => error.message.includes(code))
    return { ok: false, message: hit?.[1] ?? 'Clôture impossible.' }
  }
  revalidatePath('/finance/comptabilite')
  return { ok: true, message: `Période ${String(parsed.data.month).padStart(2, '0')}/${parsed.data.year} clôturée.` }
}
