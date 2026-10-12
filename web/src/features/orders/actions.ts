'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'
import { getAuthContext } from '@/features/auth/services/access.service'
import type { AuthContextValue, FormState } from '@/features/auth/types'
import { logAccessDenied } from '@/features/rbac/services/audit-write.service'
import { isPermissionError, mrpErrorMessage } from '@/features/mrp/errors'

/** Socle minimal des commandes client (source de la demande du MRP). */

const uuid = z.uuid()
const opt = (max: number) => z.string().trim().max(max).transform((v) => (v === '' ? null : v)).optional().transform((v) => v ?? null)
const date = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date requise')

async function authorize(permission: string): Promise<{ ctx: AuthContextValue } | { error: FormState }> {
  const ctx = await getAuthContext()
  if (!ctx) redirect('/login')
  if (!ctx.permissions.includes(permission)) {
    await logAccessDenied(ctx, permission, { via: 'server-action' })
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

export async function createOrderAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.ORDERS_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const parsed = z.object({ client_id: z.uuid('Choisissez un client'), client_ref: opt(60), order_date: date, notes: opt(1000) }).safeParse(obj(fd))
  if (!parsed.success) return invalid(parsed.error, values)
  const supabase = await createClient()
  const { data, error } = await supabase.from('sales_orders').insert(parsed.data).select('id').single()
  if (error) return dbFail(auth.ctx, P.ORDERS_WRITE, error, values)
  revalidatePath('/orders')
  redirect(`/orders/${data.id}`)
}

export async function addOrderLineAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.ORDERS_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const num = (min: number, max: number, msg: string) => z.string().trim().transform((v) => (v === '' ? 0 : Number(v.replace(',', '.')))).refine((n) => Number.isFinite(n) && n >= min && n <= max, msg)
  const parsed = z.object({
    order_id: z.uuid(), article_id: z.string().trim().transform((v) => (v === '' ? null : v)).pipe(z.uuid('Article invalide').nullable()), description: opt(300), due_date: date, note: opt(300),
    qty: z.string().trim().min(1, 'Quantité requise').transform((v) => Number(v.replace(',', '.'))).refine((n) => Number.isFinite(n) && n > 0 && n <= 10_000_000, 'Quantité : supérieure à 0'),
    unit_price: num(0, 999_999_999, 'Prix unitaire invalide'), discount_pct: num(0, 100, 'Remise : 0 à 100'),
  }).superRefine((v, c) => { if (!v.article_id && !v.description) c.addIssue({ code: 'custom', path: ['article_id'], message: 'Choisissez un article ou saisissez une désignation' }) }).safeParse(obj(fd))
  if (!parsed.success) return invalid(parsed.error, values)
  const supabase = await createClient()
  const { error } = await supabase.from('sales_order_lines').insert(parsed.data)
  if (error) return dbFail(auth.ctx, P.ORDERS_WRITE, error, values)
  revalidatePath(`/orders/${parsed.data.order_id}`)
  return { ok: true, message: 'Ligne ajoutée.' }
}

export async function deleteOrderLineAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.ORDERS_WRITE)
  if ('error' in auth) return auth.error
  const id = uuid.safeParse(fd.get('id'))
  const order = uuid.safeParse(fd.get('order_id'))
  if (!id.success || !order.success) return { ok: false, message: 'Identifiant invalide.' }
  const supabase = await createClient()
  const { error } = await supabase.from('sales_order_lines').delete().eq('id', id.data)
  if (error) return dbFail(auth.ctx, P.ORDERS_WRITE, error)
  revalidatePath(`/orders/${order.data}`)
  return { ok: true, message: 'Ligne supprimée.' }
}

export async function confirmOrderAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.ORDERS_CONFIRM)
  if ('error' in auth) return auth.error
  const id = uuid.safeParse(fd.get('id'))
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  const supabase = await createClient()
  const { error } = await supabase.rpc('sales_order_confirm', { p_order: id.data })
  if (error) return dbFail(auth.ctx, P.ORDERS_CONFIRM, error)
  revalidatePath('/orders', 'layout')
  return { ok: true, message: 'Commande confirmée : elle alimente désormais le MRP.' }
}

export async function setOrderStatusAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.ORDERS_WRITE)
  if ('error' in auth) return auth.error
  const id = uuid.safeParse(fd.get('id'))
  const status = z.enum(['cancelled', 'delivered']).safeParse(fd.get('status'))
  if (!id.success || !status.success) return { ok: false, message: 'Données invalides.' }
  const supabase = await createClient()
  const { error } = await supabase.rpc('sales_order_set_status', { p_order: id.data, p_status: status.data })
  if (error) return dbFail(auth.ctx, P.ORDERS_WRITE, error)
  revalidatePath('/orders', 'layout')
  return { ok: true, message: status.data === 'cancelled' ? 'Commande annulée.' : 'Commande marquée livrée.' }
}
