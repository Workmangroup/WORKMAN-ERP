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
import { orderErrorMessage } from '@/features/orders/order-errors'

/** Livraisons, lots et retours : règles (BL sans double sortie, lot NC non vendu, retour contrôlé) dans 0055. */

const uuid = z.uuid()
const str = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim()
const optUuid = (fd: FormData, k: string) => (uuid.safeParse(str(fd, k)).success ? str(fd, k) : null)

async function authorize(perm: string): Promise<{ ctx: AuthContextValue } | { error: FormState }> {
  const ctx = await getAuthContext()
  if (!ctx) redirect('/login')
  if (!ctx.permissions.includes(perm)) {
    await logAccessDenied(ctx, perm, { via: 'server-action' })
    return { error: { ok: false, message: 'Vous n’avez pas la permission d’effectuer cette action.' } }
  }
  return { ctx }
}

async function run(perm: string, fn: string, args: Record<string, unknown>, done: string): Promise<FormState> {
  const auth = await authorize(perm)
  if ('error' in auth) return auth.error
  const supabase = await createClient()
  const { error } = await supabase.rpc(fn, args)
  if (error) {
    if (isPermissionError(error)) await logAccessDenied(auth.ctx, perm, { via: 'database' })
    return { ok: false, message: orderErrorMessage(error) }
  }
  revalidatePath('/shipments')
  return { ok: true, message: done }
}

const bad = (message: string): FormState => ({ ok: false, message })

export async function lotReceiveAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const v = optUuid(fd, 'variant_id')
  const w = optUuid(fd, 'warehouse_id')
  const qty = Math.trunc(Number(str(fd, 'qty')))
  if (!v || !w) return bad('Variante et entrepôt requis.')
  if (!Number.isFinite(qty) || qty <= 0) return bad('Quantité positive requise.')
  return run(P.STOCK_WRITE, 'finished_lot_receive', { p_variant: v, p_warehouse: w, p_lot_code: str(fd, 'lot_code'), p_qty: qty, p_origin_ref: str(fd, 'origin_ref') || null },
    'Lot reçu : stock et lot enregistrés.')
}

export async function lotMarkNcAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = optUuid(fd, 'lot_id')
  if (!id) return bad('Lot introuvable.')
  return run(P.QUALITY_WRITE, 'finished_lot_mark_nc', { p_lot: id, p_reason: str(fd, 'reason') }, 'Lot marqué non conforme : il n’est plus vendable et son stock restant est bloqué.')
}

export async function lotAssignAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const line = optUuid(fd, 'shipment_line_id')
  const lot = optUuid(fd, 'lot_id')
  const qty = Math.trunc(Number(str(fd, 'qty')))
  if (!line || !lot) return bad('Ligne d’expédition et lot requis.')
  if (!Number.isFinite(qty) || qty <= 0) return bad('Quantité positive requise.')
  return run(P.SHIPMENTS_WRITE, 'shipment_line_lot_assign', { p_line: line, p_lot: lot, p_qty: qty }, 'Lot affecté à la ligne d’expédition.')
}

export async function deliveryConfirmAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = optUuid(fd, 'shipment_id')
  if (!id) return bad('Expédition introuvable.')
  return run(P.SHIPMENTS_WRITE, 'delivery_confirm', { p_shipment: id, p_key: str(fd, 'idempotency_key'), p_receiver: str(fd, 'receiver') },
    'Livraison confirmée (une seule fois : un nouvel envoi avec la même clé ne change rien).')
}

export async function returnRequestAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const line = optUuid(fd, 'shipment_line_id')
  const qty = Math.trunc(Number(str(fd, 'qty')))
  if (!line) return bad('Ligne d’expédition requise.')
  if (!Number.isFinite(qty) || qty <= 0) return bad('Quantité positive requise.')
  return run(P.SHIPMENTS_WRITE, 'return_request', { p_shipment_line: line, p_qty: qty, p_reason: str(fd, 'reason'), p_lot: optUuid(fd, 'lot_id'), p_condition: str(fd, 'condition') || 'unknown' },
    'Retour demandé. Il n’entraîne ni avoir, ni remboursement, ni retour en stock tant qu’il n’est pas réglé.')
}

export async function returnReceiveAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = optUuid(fd, 'return_id')
  if (!id) return bad('Retour introuvable.')
  return run(P.SHIPMENTS_WRITE, 'return_receive', { p_return: id, p_condition: str(fd, 'condition') || 'unknown' }, 'Retour réceptionné.')
}

export async function returnInspectAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = optUuid(fd, 'return_id')
  if (!id) return bad('Retour introuvable.')
  return run(P.QUALITY_WRITE, 'return_open_inspection', { p_return: id }, 'Inspection qualité ouverte : la décision appartient au contrôle qualité.')
}

export async function returnSettleAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = optUuid(fd, 'return_id')
  if (!id) return bad('Retour introuvable.')
  return run(P.SHIPMENTS_WRITE, 'return_settle', { p_return: id }, 'Retour réglé selon la décision qualité (remis en stock vendable seulement si accepté).')
}
