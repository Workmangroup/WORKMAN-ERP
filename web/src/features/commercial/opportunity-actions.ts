'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'
import { getAuthContext } from '@/features/auth/services/access.service'
import type { FormState } from '@/features/auth/types'
import { logAccessDenied } from '@/features/rbac/services/audit-write.service'
import { commercialErrorMessage } from './errors'

/** Écritures via les fonctions SQL opportunity_* / pipeline_* : droits, périmètre, étapes autorisées et audit y sont appliqués. */

const amount = z.string().trim().min(1, 'Montant requis').transform((v) => Number(v.replace(',', '.').replace(/\s/g, '')))
  .refine((n) => Number.isFinite(n) && n >= 0, 'Montant invalide')
const opt = (max: number) => z.string().trim().max(max).transform((v) => (v === '' ? null : v))

async function authorize(permission: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const ctx = await getAuthContext()
  if (!ctx) redirect('/login')
  if (!ctx.permissions.includes(permission)) {
    await logAccessDenied(ctx, permission, { via: 'server-action' })
    return { ok: false, message: 'Vous n’avez pas la permission d’effectuer cette action.' }
  }
  return { ok: true }
}

export async function createOpportunityAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.OPPORTUNITIES_WRITE)
  if (!auth.ok) return { ok: false, message: auth.message }
  const values = Object.fromEntries([...fd.entries()].filter(([k, v]) => typeof v === 'string' && !k.startsWith('$'))) as Record<string, string>
  const client = z.uuid().safeParse(String(fd.get('client') ?? ''))
  const name = z.string().trim().min(2, 'Nom requis (2 caractères)').max(120).safeParse(fd.get('name'))
  const amt = amount.safeParse(fd.get('amount'))
  const currency = z.string().regex(/^[A-Z]{3}$/, 'Devise requise (code ISO sur 3 lettres)').safeParse(String(fd.get('currency') ?? '').toUpperCase())
  const close = z.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]).safeParse(String(fd.get('expected_close') ?? ''))
  const next = opt(200).safeParse(fd.get('next_action'))
  const nextDate = z.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]).safeParse(String(fd.get('next_date') ?? ''))
  const errs = [client, name, amt, currency, close, next, nextDate].find((r) => !r.success)
  if (errs && !errs.success) return { ok: false, message: 'Données invalides : ' + errs.error.issues[0]?.message, values }
  const supabase = await createClient()
  const { error } = await supabase.rpc('opportunity_create', {
    p_client: client.success ? client.data : null, p_name: name.success ? name.data : '', p_amount: amt.success ? amt.data : 0,
    p_currency: currency.success ? currency.data : null, p_expected_close: close.success && close.data ? close.data : null,
    p_owner: null, p_next_action: next.success ? next.data : null, p_next_date: nextDate.success && nextDate.data ? nextDate.data : null,
  })
  if (error) return { ok: false, message: commercialErrorMessage(error), values }
  revalidatePath('/commercial/pipeline')
  return { ok: true, message: 'Opportunité créée.' }
}

export async function setOpportunityStageAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.OPPORTUNITIES_WRITE)
  if (!auth.ok) return { ok: false, message: auth.message }
  const id = z.uuid().safeParse(String(fd.get('id') ?? ''))
  const stage = z.string().regex(/^[a-z_]{2,30}$/).safeParse(String(fd.get('stage') ?? ''))
  const reason = opt(300).safeParse(fd.get('reason'))
  if (!id.success || !stage.success) return { ok: false, message: 'Données invalides.' }
  const supabase = await createClient()
  const { error } = await supabase.rpc('opportunity_set_stage', { p_opp: id.data, p_stage: stage.data, p_reason: reason.success ? reason.data : null })
  if (error) return { ok: false, message: commercialErrorMessage(error) }
  revalidatePath('/commercial/pipeline')
  return { ok: true, message: 'Étape mise à jour.' }
}
