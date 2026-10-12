'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'
import { getAuthContext } from '@/features/auth/services/access.service'
import type { AuthContextValue, FormState } from '@/features/auth/types'
import { logAccessDenied } from '@/features/rbac/services/audit-write.service'
import { isPermissionError, mrpErrorMessage } from './errors'

/** Écritures via la session de l'utilisateur : RLS et RPC (mrp_*, sales_order_*) font autorité. */

const uuid = z.uuid()
const opt = (max: number) => z.string().trim().max(max).transform((v) => (v === '' ? null : v)).optional().transform((v) => v ?? null)
const decimal = (label: string, opts: { zero?: boolean } = {}) =>
  z.string().trim().min(1, `${label} requis`).transform((v) => Number(v.replace(',', '.').replace(/\s/g, '')))
    .refine((n) => Number.isFinite(n), `${label} invalide`)
    .refine((n) => (opts.zero ? n >= 0 : n > 0), opts.zero ? `${label} : minimum 0` : `${label} : supérieur à 0`)
    .refine((n) => n <= 100_000_000, `${label} trop grand`)
const intIn = (label: string, min: number, max: number) =>
  z.string().trim().min(1, `${label} requis`).transform((v) => Number(v)).refine((n) => Number.isInteger(n) && n >= min && n <= max, `${label} : entier entre ${min} et ${max}`)
const date = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date requise')

async function authorize(...permissions: string[]): Promise<{ ctx: AuthContextValue } | { error: FormState }> {
  const ctx = await getAuthContext()
  if (!ctx) redirect('/login')
  const missing = permissions.find((p) => !ctx.permissions.includes(p))
  if (missing) {
    await logAccessDenied(ctx, missing, { via: 'server-action' })
    return { error: { ok: false, message: 'Vous n’avez pas la permission d’effectuer cette action.' } }
  }
  return { ctx }
}
async function dbFail(ctx: AuthContextValue, permission: string, err: { message?: string; code?: string; details?: string | null }, values?: Record<string, string>): Promise<FormState> {
  if (isPermissionError(err)) await logAccessDenied(ctx, permission, { via: 'database' })
  return { ok: false, message: mrpErrorMessage(err), values }
}
const raw = (fd: FormData): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [k, v] of fd.entries()) if (typeof v === 'string' && !k.startsWith('$ACTION')) out[k] = v
  return out
}
const obj = (fd: FormData) => Object.fromEntries([...fd.entries()].filter(([k, v]) => typeof v === 'string' && !k.startsWith('$ACTION')))
const invalid = (error: z.ZodError, values: Record<string, string>): FormState => {
  const fe = z.flattenError(error).fieldErrors as Record<string, string[] | undefined>
  return { ok: false, message: Object.values(fe).flat().find(Boolean) ?? 'Veuillez corriger les champs en erreur.', fieldErrors: fe, values }
}
const rev = () => revalidatePath('/mrp', 'layout')

// ---------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------
export async function runMrpAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.MRP_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const parsed = z.object({
    name: opt(160), horizon_days: intIn('Horizon (jours)', 7, 365), offset_days: intIn('Délai de production (jours)', 0, 120), default_lead_days: intIn('Délai d’approvisionnement par défaut (jours)', 0, 365),
  }).safeParse(obj(fd))
  if (!parsed.success) return invalid(parsed.error, values)
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('mrp_run', {
    p_name: parsed.data.name,
    p_params: {
      horizon_days: parsed.data.horizon_days, offset_days: parsed.data.offset_days, default_lead_days: parsed.data.default_lead_days,
      include_forecasts: fd.get('include_forecasts') === 'on', include_draft_orders: fd.get('include_draft_orders') === 'on', use_safety: fd.get('use_safety') === 'on',
    },
  })
  if (error) return dbFail(auth.ctx, P.MRP_WRITE, error, values)
  rev()
  redirect(`/mrp/runs/${data}`)
}

export async function decideSuggestionAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.MRP_WRITE)
  if ('error' in auth) return auth.error
  const id = uuid.safeParse(fd.get('id'))
  const status = z.enum(['proposed', 'accepted', 'rejected']).safeParse(fd.get('status'))
  if (!id.success || !status.success) return { ok: false, message: 'Données invalides.' }
  const supabase = await createClient()
  const { error } = await supabase.rpc('mrp_suggestion_decide', { p_suggestion: id.data, p_status: status.data, p_note: String(fd.get('note') ?? '').trim().slice(0, 300) || null })
  if (error) return dbFail(auth.ctx, P.MRP_WRITE, error)
  rev()
  return { ok: true, message: status.data === 'accepted' ? 'Suggestion acceptée.' : status.data === 'rejected' ? 'Suggestion rejetée.' : 'Suggestion remise à l’étude.' }
}

export async function deleteRunAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.MRP_WRITE)
  if ('error' in auth) return auth.error
  const id = uuid.safeParse(fd.get('id'))
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  const supabase = await createClient()
  const { error } = await supabase.rpc('mrp_run_delete', { p_run: id.data })
  if (error) return dbFail(auth.ctx, P.MRP_WRITE, error)
  rev()
  if (fd.get('redirect') === '1') redirect('/mrp/runs')
  return { ok: true, message: 'Simulation supprimée.' }
}

// ---------------------------------------------------------------------
// Prévisions, paramètres, réceptions planifiées
// ---------------------------------------------------------------------
export async function addForecastAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.MRP_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const parsed = z.object({ article_id: z.uuid('Choisissez un article'), forecast_date: date, qty: decimal('Quantité'), note: opt(300) }).safeParse(obj(fd))
  if (!parsed.success) return invalid(parsed.error, values)
  const supabase = await createClient()
  const { error } = await supabase.from('mrp_forecasts').insert(parsed.data)
  if (error) return dbFail(auth.ctx, P.MRP_WRITE, error, values)
  rev()
  return { ok: true, message: 'Prévision ajoutée.' }
}

export async function deleteRowAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.MRP_WRITE)
  if ('error' in auth) return auth.error
  const id = uuid.safeParse(fd.get('id'))
  const table = z.enum(['mrp_forecasts', 'mrp_scheduled_receipts']).safeParse(fd.get('table'))
  if (!id.success || !table.success) return { ok: false, message: 'Données invalides.' }
  const supabase = await createClient()
  const { error } = await supabase.from(table.data).delete().eq('id', id.data)
  if (error) return dbFail(auth.ctx, P.MRP_WRITE, error)
  rev()
  return { ok: true, message: 'Supprimé.' }
}

export async function saveParamsAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.MRP_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const parsed = z.object({
    material_id: z.uuid(),
    lead_time_days: z.string().trim().transform((v) => (v === '' ? null : Number(v))).refine((n) => n === null || (Number.isInteger(n) && n >= 0 && n <= 365), 'Délai : entier entre 0 et 365'),
    moq: decimal('MOQ', { zero: true }), order_multiple: decimal('Multiple', { zero: true }),
  }).safeParse({ material_id: fd.get('material_id'), lead_time_days: String(fd.get('lead_time_days') ?? ''), moq: String(fd.get('moq') ?? '0') || '0', order_multiple: String(fd.get('order_multiple') ?? '0') || '0' })
  if (!parsed.success) return invalid(parsed.error, values)
  const supabase = await createClient()
  const { error } = await supabase.from('mrp_params').upsert(parsed.data, { onConflict: 'material_id' })
  if (error) return dbFail(auth.ctx, P.MRP_WRITE, error, values)
  rev()
  return { ok: true, message: 'Enregistré.' }
}

export async function addReceiptAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.MRP_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const parsed = z.object({ material_id: z.uuid('Choisissez un composant'), qty: decimal('Quantité'), due_date: date, reference: opt(120) }).safeParse(obj(fd))
  if (!parsed.success) return invalid(parsed.error, values)
  const supabase = await createClient()
  const { error } = await supabase.from('mrp_scheduled_receipts').insert(parsed.data)
  if (error) return dbFail(auth.ctx, P.MRP_WRITE, error, values)
  rev()
  return { ok: true, message: 'Réception planifiée ajoutée.' }
}
