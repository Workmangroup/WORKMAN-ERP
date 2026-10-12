'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'
import { getAuthContext } from '@/features/auth/services/access.service'
import type { AuthContextValue, FormState } from '@/features/auth/types'
import { logAccessDenied } from '@/features/rbac/services/audit-write.service'
import { isPermissionError } from '@/features/stock/errors'

/** Production : chaque transition et chaque saisie passe par une fonction SQL (0019), qui contrôle droits et statut. */

const num = (label: string, opts: { min?: number; max?: number; zero?: boolean } = {}) =>
  z.string().trim().min(1, `${label} requis`)
    .transform((v) => Number(v.replace(',', '.').replace(/\s/g, '')))
    .refine((n) => Number.isFinite(n), `${label} invalide`)
    .refine((n) => (opts.zero ? n >= 0 : n > 0), opts.zero ? `${label} : minimum 0` : `${label} : supérieur à 0`)
    .refine((n) => opts.max === undefined || n <= opts.max, `${label} : maximum ${opts.max}`)
const optText = (max: number) => z.string().trim().max(max).optional().transform((v) => (v ? v : null))
const uuid = (label: string) => z.uuid(`${label} invalide`)
const optUuid = z.string().trim().optional().transform((v) => (v ? v : null)).pipe(z.union([z.null(), z.uuid('Valeur invalide')]))
const date = (label: string) => z.string().trim().min(1, `${label} requis`).regex(/^\d{4}-\d{2}-\d{2}$/, `${label} invalide`)

const obj = (fd: FormData) => Object.fromEntries([...fd.entries()].filter(([k, v]) => typeof v === 'string' && !k.startsWith('$ACTION')))
const raw = (fd: FormData): Record<string, string> => Object.fromEntries(Object.entries(obj(fd)).map(([k, v]) => [k, String(v)]))
const invalid = (error: z.ZodError, values: Record<string, string>): FormState => {
  const fe = z.flattenError(error).fieldErrors as Record<string, string[] | undefined>
  return { ok: false, message: Object.values(fe).flat().find(Boolean) ?? 'Veuillez corriger les champs en erreur.', fieldErrors: fe, values }
}
async function requireCtx(): Promise<AuthContextValue> {
  const ctx = await getAuthContext()
  if (!ctx) redirect('/login')
  return ctx
}
const PRODUCTION_MESSAGES: [string, string][] = [
  ['PRODUCTION_BAD_STATUS', 'Cette action n’est pas possible dans l’état actuel de l’ordre.'],
  ['PRODUCTION_WORK_CENTER_REQUIRED', 'Affectez un poste de travail avant de lancer l’ordre.'],
  ['PRODUCTION_WORK_CENTER_NOT_FOUND', 'Poste de travail introuvable ou inactif.'],
  ['PRODUCTION_ARTICLE_NOT_FOUND', 'Article introuvable.'],
  ['PRODUCTION_ORDER_NOT_FOUND', 'Ordre de fabrication introuvable.'],
  ['PRODUCTION_BAD_QTY', 'La saisie doit contenir une quantité bonne ou rebutée.'],
  ['PRODUCTION_QTY_EXCEEDED', 'Le cumul des quantités saisies dépasse la quantité planifiée.'],
  ['PRODUCTION_BAD_DATE', 'La date de saisie doit être aujourd’hui ou passée (30 jours au plus avant le début).'],
  ['PRODUCTION_REASON_REQUIRED', 'Un motif de suspension est obligatoire (3 caractères minimum).'],
  ['PRODUCTION_NO_LOG', 'Terminez l’ordre après au moins une saisie de suivi.'],
  ['PRODUCTION_IMMUTABLE', 'Le suivi de production ne peut pas être modifié.'],
  ['RBAC_FORBIDDEN', 'Vous n’avez pas la permission d’effectuer cette action.'],
  ['check constraint', 'Une valeur ne respecte pas les règles de saisie (dates, plage ou code).'],
]
const messageOf = (err: { message?: string; code?: string; details?: string | null }) => {
  const text = `${err.message ?? ''} ${err.details ?? ''}`
  for (const [k, m] of PRODUCTION_MESSAGES) if (text.includes(k)) return m
  if (err.code === '42501' || text.includes('row-level security')) return 'Vous n’avez pas la permission d’effectuer cette action.'
  return 'Une erreur est survenue. Réessayez ou contactez un administrateur.'
}
async function dbFail(ctx: AuthContextValue, err: { message?: string; code?: string; details?: string | null }, values?: Record<string, string>): Promise<FormState> {
  if (isPermissionError(err)) await logAccessDenied(ctx, P.PRODUCTION_WRITE, { via: 'database' })
  return { ok: false, message: messageOf(err), values }
}
const rev = () => revalidatePath('/production', 'layout')

export async function createOrderAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await requireCtx()
  const values = raw(fd)
  const parsed = z.object({
    article_id: uuid('Article'), qty: num('Quantité', { max: 1_000_000 }), std_minutes: num('Temps standard (min par pièce)', { max: 100_000 }),
    work_center_id: optUuid, start: date('Date de début'), end: date('Date de fin'), notes: optText(1000),
  }).safeParse({ article_id: fd.get('article_id'), qty: fd.get('qty'), std_minutes: fd.get('std_minutes'), work_center_id: fd.get('work_center_id'),
    start: fd.get('start'), end: fd.get('end'), notes: fd.get('notes') })
  if (!parsed.success) return invalid(parsed.error, values)
  const d = parsed.data
  const supabase = await createClient()
  const { error } = await supabase.rpc('production_order_create', { p_article: d.article_id, p_qty: d.qty, p_std_minutes: d.std_minutes,
    p_work_center: d.work_center_id, p_start: d.start, p_end: d.end, p_sales_order: null, p_notes: d.notes })
  if (error) return dbFail(ctx, error, values)
  rev()
  return { ok: true, message: 'Ordre de fabrication planifié.' }
}

export async function rescheduleOrderAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await requireCtx()
  const values = raw(fd)
  const parsed = z.object({
    order_id: uuid('Ordre'), work_center_id: optUuid, start: date('Date de début'), end: date('Date de fin'),
    qty: num('Quantité', { max: 1_000_000 }), std_minutes: num('Temps standard', { max: 100_000 }),
  }).safeParse({ order_id: fd.get('order_id'), work_center_id: fd.get('work_center_id'), start: fd.get('start'), end: fd.get('end'),
    qty: fd.get('qty'), std_minutes: fd.get('std_minutes') })
  if (!parsed.success) return invalid(parsed.error, values)
  const d = parsed.data
  const supabase = await createClient()
  const { error } = await supabase.rpc('production_order_reschedule', { p_order: d.order_id, p_work_center: d.work_center_id, p_start: d.start,
    p_end: d.end, p_qty: d.qty, p_std_minutes: d.std_minutes })
  if (error) return dbFail(ctx, error, values)
  rev()
  return { ok: true, message: 'Ordre replanifié.' }
}

export async function logProductionAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await requireCtx()
  const values = raw(fd)
  const parsed = z.object({
    order_id: uuid('Ordre'), date: date('Date'), hours: num('Heures', { max: 24 }), good: num('Quantité bonne', { zero: true, max: 1_000_000 }),
    scrap: num('Rebut', { zero: true, max: 1_000_000 }), note: optText(300),
  }).safeParse({ order_id: fd.get('order_id'), date: fd.get('date'), hours: fd.get('hours'), good: fd.get('good'), scrap: fd.get('scrap'), note: fd.get('note') })
  if (!parsed.success) return invalid(parsed.error, values)
  const d = parsed.data
  const supabase = await createClient()
  const { error } = await supabase.rpc('production_order_log', { p_order: d.order_id, p_date: d.date, p_hours: d.hours, p_good: d.good, p_scrap: d.scrap, p_note: d.note })
  if (error) return dbFail(ctx, error, values)
  rev()
  return { ok: true, message: 'Saisie enregistrée.' }
}

export async function suspendOrderAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await requireCtx()
  const values = raw(fd)
  const parsed = z.object({ order_id: uuid('Ordre'), reason: z.string().trim().min(3, 'Motif : 3 caractères minimum').max(300) })
    .safeParse({ order_id: fd.get('order_id'), reason: fd.get('reason') })
  if (!parsed.success) return invalid(parsed.error, values)
  const supabase = await createClient()
  const { error } = await supabase.rpc('production_order_suspend', { p_order: parsed.data.order_id, p_reason: parsed.data.reason })
  if (error) return dbFail(ctx, error, values)
  rev()
  return { ok: true, message: 'Ordre suspendu.' }
}

/** Actions sans saisie : lancer, reprendre, terminer, clôturer. */
async function simpleAction(fn: string, message: string, fd: FormData): Promise<FormState> {
  const ctx = await requireCtx()
  const parsed = z.object({ order_id: uuid('Ordre') }).safeParse({ order_id: fd.get('order_id') })
  if (!parsed.success) return { ok: false, message: 'Ordre invalide.' }
  const supabase = await createClient()
  const { error } = await supabase.rpc(fn, { p_order: parsed.data.order_id })
  if (error) return dbFail(ctx, error)
  rev()
  return { ok: true, message }
}
export async function launchOrderAction(_p: FormState, fd: FormData): Promise<FormState> {
  return simpleAction('production_order_launch', 'Ordre lancé.', fd)
}
export async function resumeOrderAction(_p: FormState, fd: FormData): Promise<FormState> {
  return simpleAction('production_order_resume', 'Ordre repris.', fd)
}
export async function finishOrderAction(_p: FormState, fd: FormData): Promise<FormState> {
  return simpleAction('production_order_finish', 'Ordre terminé.', fd)
}
export async function closeOrderAction(_p: FormState, fd: FormData): Promise<FormState> {
  return simpleAction('production_order_close', 'Ordre clôturé.', fd)
}

export async function saveWorkCenterAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await requireCtx()
  const values = raw(fd)
  const parsed = z.object({
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9._-]{0,19}$/, 'Code : lettres et chiffres (20 max)'),
    name: z.string().trim().min(2, 'Nom : 2 caractères minimum').max(120),
    kind: z.enum(['coupe', 'couture', 'finition', 'repassage', 'controle', 'other'], { message: 'Type inconnu' }),
    hours_per_day: num('Heures par jour', { max: 24 }),
    efficiency_pct: num('Rendement de référence (%)', { max: 150 }),
  }).safeParse({ code: fd.get('code'), name: fd.get('name'), kind: fd.get('kind'), hours_per_day: fd.get('hours_per_day'), efficiency_pct: fd.get('efficiency_pct') })
  if (!parsed.success) return invalid(parsed.error, values)
  const supabase = await createClient()
  const { error } = await supabase.from('work_centers').insert(parsed.data)
  if (error) return dbFail(ctx, error, values)
  rev()
  return { ok: true, message: `Poste ${parsed.data.code} créé.` }
}
