'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'
import { REQUEST_KINDS } from '@/lib/stock/movement-kinds'
import { getAuthContext } from '@/features/auth/services/access.service'
import type { AuthContextValue, FormState } from '@/features/auth/types'
import { logAccessDenied } from '@/features/rbac/services/audit-write.service'
import { isPermissionError, stockErrorMessage } from './errors'

/** Demandes de mouvement et validation hiérarchique (0018) : toute règle est appliquée par les fonctions SQL. */

const optUuid = z.string().trim().transform((v) => (v === '' ? null : v)).pipe(z.union([z.null(), z.uuid('Valeur invalide')])).optional().transform((v) => v ?? null)
const text = (max: number) => z.string().trim().max(max).optional().transform((v) => (v ? v : null))

const requestSchema = z.object({
  kind: z.enum(REQUEST_KINDS.map((k) => k.value) as [string, ...string[]], { message: 'Choisissez un type de mouvement' }),
  material_id: z.uuid('Choisissez un composant'),
  qty: z.string().trim().min(1, 'Quantité requise')
    .transform((v) => Number(v.replace(',', '.').replace(/\s/g, '')))
    .refine((n) => Number.isFinite(n) && n !== 0, 'Quantité invalide (non nulle)')
    .refine((n) => Math.abs(n) <= 100_000_000, 'Quantité trop grande'),
  warehouse_id: z.uuid('Choisissez un entrepôt'),
  location_id: optUuid,
  to_warehouse_id: optUuid,
  to_location_id: optUuid,
  unit_cost: z.string().trim().optional().transform((v) => (v ? Number(v.replace(',', '.')) : null))
    .refine((n) => n === null || (Number.isFinite(n) && n >= 0), 'Coût unitaire invalide'),
  reference: text(120),
  reason: text(300),
}).refine((d) => d.kind === 'ajustement' || d.qty > 0, { message: 'Quantité positive (seuls les ajustements peuvent être négatifs)', path: ['qty'] })

const idSchema = z.object({ request_id: z.uuid('Demande invalide'), note: text(300) })
const rejectSchema = z.object({ request_id: z.uuid('Demande invalide'), reason: z.string().trim().min(3, 'Motif de refus : 3 caractères minimum').max(300) })
const cancelMovementSchema = z.object({ movement_id: z.uuid('Mouvement invalide'), reason: z.string().trim().min(5, 'Motif d’annulation : 5 caractères minimum').max(300) })

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
async function dbFail(ctx: AuthContextValue, err: { message?: string; code?: string; details?: string | null }, values?: Record<string, string>): Promise<FormState> {
  if (isPermissionError(err)) await logAccessDenied(ctx, P.STOCK_WRITE, { via: 'database' })
  return { ok: false, message: stockErrorMessage(err), values }
}
const rev = () => revalidatePath('/stock', 'layout')

/** Nouvelle demande : publiée tout de suite si la règle ne demande aucune validation, sinon envoyée au valideur. */
export async function createMovementRequestAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await requireCtx()
  const values = raw(fd)
  const parsed = requestSchema.safeParse(obj(fd))
  if (!parsed.success) return invalid(parsed.error, values)
  const d = parsed.data
  const perm = d.kind === 'ajustement' ? P.STOCK_ADJUST : P.STOCK_WRITE
  if (!ctx.permissions.includes(perm)) {
    await logAccessDenied(ctx, perm, { via: 'server-action' })
    return { ok: false, message: 'Vous n’avez pas la permission d’effectuer cette action.', values }
  }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('stock_request_create', {
    p_kind: d.kind, p_material: d.material_id, p_qty: d.qty, p_warehouse: d.warehouse_id, p_location: d.location_id,
    p_to_warehouse: d.to_warehouse_id, p_to_location: d.to_location_id, p_unit_cost: d.unit_cost,
    p_reference: d.reference, p_reason: d.reason,
  })
  if (error) return dbFail(ctx, error, values)
  rev()
  const r = data as { number: string; status: string }
  return { ok: true, message: r.status === 'posted' ? `Mouvement ${r.number} enregistré.` : `Demande ${r.number} envoyée pour validation.` }
}

/** Validation d'une demande (niveau 1 ou 2 selon l'état) : les droits, l'auto-validation et l'ordre sont contrôlés en base. */
export async function approveRequestAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await requireCtx()
  const parsed = idSchema.safeParse(obj(fd))
  if (!parsed.success) return invalid(parsed.error, raw(fd))
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('stock_request_approve', { p_request: parsed.data.request_id, p_note: parsed.data.note })
  if (error) return dbFail(ctx, error)
  rev()
  const r = data as { status: string; step: number }
  return { ok: true, message: r.status === 'posted' ? 'Demande validée : mouvement enregistré.' : 'Validation de niveau 1 enregistrée. En attente du niveau 2.' }
}

export async function rejectRequestAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await requireCtx()
  const values = raw(fd)
  const parsed = rejectSchema.safeParse(obj(fd))
  if (!parsed.success) return invalid(parsed.error, values)
  const supabase = await createClient()
  const { error } = await supabase.rpc('stock_request_reject', { p_request: parsed.data.request_id, p_reason: parsed.data.reason })
  if (error) return dbFail(ctx, error, values)
  rev()
  return { ok: true, message: 'Demande refusée.' }
}

export async function cancelRequestAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await requireCtx()
  const parsed = z.object({ request_id: z.uuid('Demande invalide') }).safeParse(obj(fd))
  if (!parsed.success) return invalid(parsed.error, raw(fd))
  const supabase = await createClient()
  const { error } = await supabase.rpc('stock_request_cancel', { p_request: parsed.data.request_id, p_reason: null })
  if (error) return dbFail(ctx, error)
  rev()
  return { ok: true, message: 'Demande annulée.' }
}

/** Annulation contrôlée d'un mouvement : crée une réversion soumise au même circuit de validation. */
export async function cancelMovementAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await requireCtx()
  const values = raw(fd)
  const parsed = cancelMovementSchema.safeParse(obj(fd))
  if (!parsed.success) return invalid(parsed.error, values)
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('stock_cancel_movement', { p_movement: parsed.data.movement_id, p_reason: parsed.data.reason })
  if (error) return dbFail(ctx, error, values)
  rev()
  const r = data as { number: string; status: string }
  return { ok: true, message: r.status === 'posted' ? `Annulation ${r.number} enregistrée.` : `Demande d’annulation ${r.number} envoyée pour validation.` }
}
