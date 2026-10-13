'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'
import { getAuthContext } from '@/features/auth/services/access.service'
import type { AuthContextValue, FormState } from '@/features/auth/types'
import { logAccessDenied } from '@/features/rbac/services/audit-write.service'
import { isPermissionError } from '@/features/mrp/errors'
import { orderErrorMessage } from './order-errors'

/** Reliquats et engagements : les règles (motif, plancher livré/annulé/facturé, échéancier figé, activité) sont dans 0052. */

const uuid = z.uuid()
const str = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim()

async function authorize(perm: string): Promise<{ ctx: AuthContextValue } | { error: FormState }> {
  const ctx = await getAuthContext()
  if (!ctx) redirect('/login')
  if (!ctx.permissions.includes(perm)) {
    await logAccessDenied(ctx, perm, { via: 'server-action' })
    return { error: { ok: false, message: 'Vous n’avez pas la permission d’effectuer cette action.' } }
  }
  return { ctx }
}

async function call(perm: string, fn: string, args: Record<string, unknown>): Promise<{ ok: true; data: unknown } | { ok: false; state: FormState }> {
  const auth = await authorize(perm)
  if ('error' in auth) return { ok: false, state: auth.error }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc(fn, args)
  if (error) {
    if (isPermissionError(error)) await logAccessDenied(auth.ctx, perm, { via: 'database' })
    return { ok: false, state: { ok: false, message: orderErrorMessage(error) } }
  }
  revalidatePath('/orders')
  return { ok: true, data }
}

const bad = (message: string): FormState => ({ ok: false, message })

export async function orderCancelAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = uuid.safeParse(str(fd, 'id'))
  if (!id.success) return bad('Commande introuvable.')
  const r = await call(P.ORDERS_WRITE, 'order_cancel', { p_order: id.data, p_reason: str(fd, 'reason') })
  if (!r.ok) return r.state
  const d = r.data as { full: boolean; cancelled_qty: number; delivered_qty: number; production_orders_kept: number }
  if (d.full) return { ok: true, message: 'Commande annulée (aucune livraison ni production).' }
  return {
    ok: true,
    message: `Reliquat annulé : ${d.cancelled_qty} pièce(s). Livré conservé : ${d.delivered_qty}.${d.production_orders_kept ? ` ${d.production_orders_kept} ordre(s) de fabrication conservé(s) avec leur consommation.` : ''}`,
  }
}

export async function orderAmendLineAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const line = uuid.safeParse(str(fd, 'line_id'))
  if (!line.success) return bad('Ligne introuvable.')
  const qty = Number(str(fd, 'qty').replace(',', '.'))
  if (!Number.isFinite(qty)) return bad('Quantité invalide.')
  const due = str(fd, 'due_date') || null
  const r = await call(P.ORDERS_WRITE, 'order_amend_line', { p_line: line.data, p_qty: qty, p_due: due, p_reason: str(fd, 'reason') })
  if (!r.ok) return r.state
  return { ok: true, message: `Modification enregistrée : version ${r.data} de l’engagement.` }
}

export async function orderAddressAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = uuid.safeParse(str(fd, 'id'))
  if (!id.success) return bad('Commande introuvable.')
  const r = await call(P.ORDERS_WRITE, 'order_set_delivery_address', { p_order: id.data, p_address: str(fd, 'address') || null })
  return r.ok ? { ok: true, message: 'Adresse de livraison enregistrée.' } : r.state
}

/** Échéancier : lignes « date + quantité » ; les lignes vides sont ignorées. */
export async function orderScheduleAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const line = uuid.safeParse(str(fd, 'line_id'))
  if (!line.success) return bad('Ligne introuvable.')
  const dates = fd.getAll('due_date').map(String)
  const qtys = fd.getAll('qty').map((v) => Number(String(v).replace(',', '.')))
  const rows = dates.map((d, i) => ({ d: d.trim(), q: qtys[i] })).filter((r) => r.d !== '' || (Number.isFinite(r.q) && r.q !== 0))
  if (rows.length === 0 || rows.some((r) => !/^\d{4}-\d{2}-\d{2}$/.test(r.d) || !Number.isFinite(r.q) || r.q <= 0)) return bad('Chaque échéance demande une date et une quantité positive.')
  const r = await call(P.ORDERS_WRITE, 'order_set_schedule', { p_line: line.data, p_dates: rows.map((x) => x.d), p_qtys: rows.map((x) => x.q) })
  return r.ok ? { ok: true, message: `Échéancier enregistré (${rows.length} échéance(s)).` } : r.state
}
