'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'
import { getAuthContext } from '@/features/auth/services/access.service'
import type { AuthContextValue, FormState } from '@/features/auth/types'
import { logAccessDenied } from '@/features/rbac/services/audit-write.service'
import { isPermissionError, subcontractErrorMessage } from './errors'

/** Écritures via la session de l'utilisateur : RLS et RPC (subcontract.*) font autorité. */

const uuid = z.uuid()
const date = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date invalide')
const optDate = z.string().trim().transform((v) => (v === '' ? null : v)).pipe(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date invalide').nullable())
const txt = (max: number) => z.string().trim().max(max).transform((v) => (v === '' ? null : v))
const num = (fd: FormData, k: string) => { const v = String(fd.get(k) ?? '').trim(); return v === '' ? NaN : Number(v.replace(',', '.')) }

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
  return { ok: false, message: subcontractErrorMessage(err), values }
}
const raw = (fd: FormData): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [k, v] of fd.entries()) if (typeof v === 'string' && !k.startsWith('$ACTION')) out[k] = v
  return out
}
const invalid = (error: z.ZodError, values: Record<string, string>): FormState => {
  const fe = z.flattenError(error).fieldErrors as Record<string, string[] | undefined>
  return { ok: false, message: Object.values(fe).flat().find(Boolean) ?? 'Veuillez corriger les champs en erreur.', fieldErrors: fe, values }
}
const rev = (id?: string) => { revalidatePath('/subcontracting', 'layout'); if (id) revalidatePath(`/subcontracting/orders/${id}`, 'layout') }

// ---------------------------------------------------------------------
// Sous-traitants
// ---------------------------------------------------------------------
const subSchema = z.object({
  name: z.string().trim().min(2, 'Nom requis (2 caractères minimum)').max(120),
  services: z.array(z.enum(['embroidery', 'screen_printing', 'printing', 'washing', 'finishing', 'other'])).min(1, 'Choisissez au moins une prestation'),
  country: z.string().trim().transform((v) => (v === '' ? null : v.toUpperCase())).pipe(z.string().regex(/^[A-Z]{2}$/, 'Code pays à 2 lettres').nullable()),
  city: txt(80).optional().transform((v) => v ?? null),
  contact_name: txt(120).optional().transform((v) => v ?? null),
  email: z.string().trim().max(120).transform((v) => (v === '' ? null : v)).pipe(z.string().email('E-mail invalide').nullable()).optional().transform((v) => v ?? null),
  phone: txt(40).optional().transform((v) => v ?? null),
  default_lead_days: z.string().trim().transform((v) => (v === '' ? 14 : Number(v))).pipe(z.number().int('Délai : nombre entier').min(0).max(365)),
  notes: txt(2000).optional().transform((v) => v ?? null),
})

export async function saveSubcontractorAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.SUBCONTRACT_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const parsed = subSchema.safeParse({ ...Object.fromEntries(fd.entries()), services: fd.getAll('services').map(String) })
  if (!parsed.success) return invalid(parsed.error, values)
  const supabase = await createClient()
  const id = String(fd.get('id') ?? '')
  const active = String(fd.get('active') ?? 'on') !== 'off'
  const payload = { ...parsed.data, active }
  const { error } = id && uuid.safeParse(id).success
    ? await supabase.from('subcontractors').update(payload).eq('id', id)
    : await supabase.from('subcontractors').insert(payload)
  if (error) return dbFail(auth.ctx, P.SUBCONTRACT_WRITE, error, values)
  rev()
  return { ok: true, message: id ? 'Sous-traitant mis à jour.' : 'Sous-traitant créé.' }
}

export async function toggleSubcontractorAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.SUBCONTRACT_WRITE)
  if ('error' in auth) return auth.error
  const id = uuid.safeParse(fd.get('id'))
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  const supabase = await createClient()
  const { error } = await supabase.from('subcontractors').update({ active: String(fd.get('active')) === 'true' }).eq('id', id.data)
  if (error) return dbFail(auth.ctx, P.SUBCONTRACT_WRITE, error)
  rev()
  return { ok: true, message: 'Statut du sous-traitant mis à jour.' }
}

// ---------------------------------------------------------------------
// Commandes
// ---------------------------------------------------------------------
const orderSchema = z.object({
  subcontractor_id: z.uuid('Choisissez un sous-traitant'),
  service: z.enum(['embroidery', 'screen_printing', 'printing', 'washing', 'finishing', 'other'], { error: 'Choisissez une prestation' }),
  product_id: z.string().trim().transform((v) => (v === '' ? null : v)).pipe(z.uuid('Produit invalide').nullable()),
  description: z.string().trim().min(2, 'Décrivez la prestation').max(300),
  qty: z.string().trim().min(1, 'Quantité requise').transform((v) => Number(v.replace(',', '.'))).pipe(z.number().int('Quantité : nombre entier').min(1, 'Quantité : au moins 1').max(1_000_000)),
  requested_on: date,
  due_date: optDate,
  notes: txt(2000).optional().transform((v) => v ?? null),
})

export async function createOrderAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.SUBCONTRACT_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const parsed = orderSchema.safeParse(Object.fromEntries(fd.entries()))
  if (!parsed.success) return invalid(parsed.error, values)
  const supabase = await createClient()
  const { data, error } = await supabase.from('subcontract_orders').insert(parsed.data).select('id').single()
  if (error) return dbFail(auth.ctx, P.SUBCONTRACT_WRITE, error, values)
  rev()
  redirect(`/subcontracting/orders/${data.id}?created=1`)
}

export async function updateOrderAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.SUBCONTRACT_WRITE)
  if ('error' in auth) return auth.error
  const id = uuid.safeParse(fd.get('id'))
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  const supabase = await createClient()
  const payload = { due_date: optDate.safeParse(String(fd.get('due_date') ?? '')).data ?? null, notes: String(fd.get('notes') ?? '').trim().slice(0, 2000) || null }
  const { error } = await supabase.from('subcontract_orders').update(payload).eq('id', id.data)
  if (error) return dbFail(auth.ctx, P.SUBCONTRACT_WRITE, error)
  rev(id.data)
  return { ok: true, message: 'Commande mise à jour.' }
}

/** Action générique : appelle une RPC (dont le premier paramètre est l'identifiant de la commande) puis rafraîchit. */
async function callRpc(permission: string, fn: string, args: Record<string, unknown>, orderId: string, okMessage: string): Promise<FormState> {
  const auth = await authorize(permission)
  if ('error' in auth) return auth.error
  const supabase = await createClient()
  const { error } = await supabase.rpc(fn, args)
  if (error) return dbFail(auth.ctx, permission, error)
  rev(orderId)
  return { ok: true, message: okMessage }
}

export async function sendOrderAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = uuid.safeParse(fd.get('id'))
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  const due = optDate.safeParse(String(fd.get('due_date') ?? '')).data ?? null
  return callRpc(P.SUBCONTRACT_WRITE, 'sc_order_send', { p_order: id.data, p_due: due }, id.data, 'Commande envoyée au sous-traitant.')
}

export async function cancelOrderAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = uuid.safeParse(fd.get('id'))
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  return callRpc(P.SUBCONTRACT_WRITE, 'sc_order_cancel', { p_order: id.data, p_reason: String(fd.get('reason') ?? '').trim().slice(0, 300) }, id.data, 'Commande annulée.')
}

export async function closeOrderAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = uuid.safeParse(fd.get('id'))
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  return callRpc(P.SUBCONTRACT_WRITE, 'sc_order_close', { p_order: id.data }, id.data, 'Commande clôturée.')
}

export async function addShipmentAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = uuid.safeParse(fd.get('id'))
  const qty = num(fd, 'qty')
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  if (!Number.isInteger(qty)) return { ok: false, message: 'Quantité : nombre entier requis.' }
  const shipped = optDate.safeParse(String(fd.get('shipped_on') ?? '')).data ?? new Date().toISOString().slice(0, 10)
  return callRpc(P.SUBCONTRACT_WRITE, 'sc_shipment_add', {
    p_order: id.data, p_qty: qty, p_shipped_on: shipped, p_carrier: String(fd.get('carrier') ?? '').trim().slice(0, 80) || null, p_tracking: String(fd.get('tracking') ?? '').trim().slice(0, 80) || null,
  }, id.data, 'Envoi enregistré.')
}

export async function addReceiptAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = uuid.safeParse(fd.get('id'))
  const qty = num(fd, 'qty')
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  if (!Number.isInteger(qty)) return { ok: false, message: 'Quantité : nombre entier requis.' }
  const received = optDate.safeParse(String(fd.get('received_on') ?? '')).data ?? new Date().toISOString().slice(0, 10)
  const shipment = uuid.safeParse(String(fd.get('shipment_id') ?? '')).success ? String(fd.get('shipment_id')) : null
  return callRpc(P.SUBCONTRACT_WRITE, 'sc_receipt_add', { p_order: id.data, p_qty: qty, p_received_on: received, p_shipment: shipment }, id.data, 'Retour réceptionné : à contrôler.')
}

export async function qualityAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const rid = uuid.safeParse(fd.get('receipt_id'))
  const oid = uuid.safeParse(fd.get('order_id'))
  const acc = num(fd, 'accepted'), rej = num(fd, 'rejected')
  if (!rid.success || !oid.success) return { ok: false, message: 'Identifiant invalide.' }
  if (!Number.isInteger(acc) || !Number.isInteger(rej)) return { ok: false, message: 'Quantités : nombres entiers requis.' }
  return callRpc(P.SUBCONTRACT_QC, 'sc_receipt_qc', { p_receipt: rid.data, p_accepted: acc, p_rejected: rej, p_notes: String(fd.get('notes') ?? '').trim().slice(0, 500) || null }, oid.data, 'Contrôle enregistré.')
}

export async function stockAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const rid = uuid.safeParse(fd.get('receipt_id'))
  const oid = uuid.safeParse(fd.get('order_id'))
  const vid = uuid.safeParse(fd.get('variant_id'))
  const wid = uuid.safeParse(fd.get('warehouse_id'))
  if (!rid.success || !oid.success || !vid.success || !wid.success) return { ok: false, message: 'Choisissez la variante et l’entrepôt.' }
  return callRpc(P.SUBCONTRACT_QC, 'sc_receipt_stock', { p_receipt: rid.data, p_variant: vid.data, p_warehouse: wid.data }, oid.data, 'Pièces acceptées entrées en stock.')
}

// ---------------------------------------------------------------------
// Coûts (subcontract.costs)
// ---------------------------------------------------------------------
const costSchema = z.object({
  order_id: z.uuid(), shipment_id: z.string().trim().transform((v) => (v === '' ? null : v)).pipe(z.uuid().nullable()),
  kind: z.enum(['service', 'shipping', 'other']),
  description: z.string().trim().min(1, 'Description requise').max(200),
  quantity: z.string().trim().min(1, 'Quantité requise').transform((v) => Number(v.replace(',', '.'))).pipe(z.number().positive('Quantité supérieure à 0')),
  unit_cost: z.string().trim().min(1, 'Montant requis').transform((v) => Number(v.replace(',', '.'))).pipe(z.number().min(0, 'Montant positif ou nul')),
  incurred_on: date,
})
export async function addCostAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.SUBCONTRACT_COSTS)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const parsed = costSchema.safeParse(Object.fromEntries(fd.entries()))
  if (!parsed.success) return invalid(parsed.error, values)
  const supabase = await createClient()
  const { error } = await supabase.from('subcontract_costs').insert(parsed.data)
  if (error) return dbFail(auth.ctx, P.SUBCONTRACT_COSTS, error, values)
  rev(parsed.data.order_id)
  return { ok: true, message: 'Coût enregistré.' }
}

export async function deleteCostAction(fd: FormData): Promise<void> {
  const auth = await authorize(P.SUBCONTRACT_COSTS)
  if ('error' in auth) return
  const id = uuid.safeParse(fd.get('id'))
  const oid = uuid.safeParse(fd.get('order_id'))
  if (!id.success || !oid.success) return
  const supabase = await createClient()
  await supabase.from('subcontract_costs').delete().eq('id', id.data)
  rev(oid.data)
}
