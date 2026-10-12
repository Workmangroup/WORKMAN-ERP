'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'
import { getAuthContext } from '@/features/auth/services/access.service'
import type { AuthContextValue, FormState } from '@/features/auth/types'
import { logAccessDenied } from '@/features/rbac/services/audit-write.service'
import { isPermissionError, purchaseErrorMessage } from './errors'

/** Écritures via la session de l'utilisateur : RLS et RPC (purchase_*) font autorité. */

const uuid = z.uuid()
const opt = (max: number) => z.string().trim().max(max).transform((v) => (v === '' ? null : v)).optional().transform((v) => v ?? null)
const optUuid = z.string().trim().transform((v) => (v === '' ? null : v)).pipe(z.union([z.null(), z.uuid('Valeur invalide')])).optional().transform((v) => v ?? null)
const optDate = z.string().trim().transform((v) => (v === '' ? null : v)).pipe(z.union([z.null(), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date invalide')])).optional().transform((v) => v ?? null)
const dec = (label: string, opts: { zero?: boolean } = {}) =>
  z.string().trim().min(1, `${label} requis`).transform((v) => Number(v.replace(',', '.').replace(/\s/g, '')))
    .refine((n) => Number.isFinite(n), `${label} invalide`)
    .refine((n) => (opts.zero ? n >= 0 : n > 0), opts.zero ? `${label} : minimum 0` : `${label} : supérieur à 0`)
    .refine((n) => n <= 100_000_000, `${label} trop grand`)

async function authorize(...anyOf: string[]): Promise<{ ctx: AuthContextValue } | { error: FormState }> {
  const ctx = await getAuthContext()
  if (!ctx) redirect('/login')
  if (!anyOf.some((p) => ctx.permissions.includes(p))) {
    await logAccessDenied(ctx, anyOf.join('|'), { via: 'server-action' })
    return { error: { ok: false, message: 'Vous n’avez pas la permission d’effectuer cette action.' } }
  }
  return { ctx }
}
async function dbFail(ctx: AuthContextValue, permission: string, err: { message?: string; code?: string; details?: string | null }, values?: Record<string, string>): Promise<FormState> {
  if (isPermissionError(err)) await logAccessDenied(ctx, permission, { via: 'database' })
  return { ok: false, message: purchaseErrorMessage(err), values }
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
const rev = () => revalidatePath('/purchases', 'layout')
const REQ = [P.PURCHASES_REQUEST, P.PURCHASES_WRITE]

// ---------------------------------------------------------------------
// Demandes d'achat
// ---------------------------------------------------------------------
export async function createRequestAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(...REQ)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const parsed = z.object({ needed_date: optDate, reason: opt(500) }).safeParse(obj(fd))
  if (!parsed.success) return invalid(parsed.error, values)
  const supabase = await createClient()
  const { data, error } = await supabase.from('purchase_requests').insert(parsed.data).select('id').single()
  if (error) return dbFail(auth.ctx, P.PURCHASES_REQUEST, error, values)
  rev()
  redirect(`/purchases/requests/${data.id}`)
}

export async function addRequestLineAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(...REQ)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const parsed = z.object({ request_id: z.uuid(), material_id: z.uuid('Choisissez un composant'), qty: dec('Quantité'), supplier_id: optUuid, needed_date: optDate, note: opt(300) }).safeParse(obj(fd))
  if (!parsed.success) return invalid(parsed.error, values)
  const supabase = await createClient()
  const { error } = await supabase.from('purchase_request_lines').insert(parsed.data)
  if (error) return dbFail(auth.ctx, P.PURCHASES_REQUEST, error, values)
  rev()
  return { ok: true, message: 'Ligne ajoutée.' }
}

export async function deleteRequestLineAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(...REQ)
  if ('error' in auth) return auth.error
  const id = uuid.safeParse(fd.get('id'))
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  const supabase = await createClient()
  const { error } = await supabase.from('purchase_request_lines').delete().eq('id', id.data)
  if (error) return dbFail(auth.ctx, P.PURCHASES_REQUEST, error)
  rev()
  return { ok: true, message: 'Ligne supprimée.' }
}

async function rpcAction(anyOf: string[], fn: string, args: Record<string, unknown>, okMessage: string): Promise<FormState> {
  const auth = await authorize(...anyOf)
  if ('error' in auth) return auth.error
  const supabase = await createClient()
  const { error } = await supabase.rpc(fn, args)
  if (error) return dbFail(auth.ctx, anyOf[0], error)
  rev()
  return { ok: true, message: okMessage }
}
const idOf = (fd: FormData) => uuid.safeParse(fd.get('id'))

export async function submitRequestAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = idOf(fd)
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  return rpcAction(REQ, 'purchase_request_submit', { p_request: id.data }, 'Demande soumise pour validation.')
}
export async function cancelRequestAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = idOf(fd)
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  return rpcAction(REQ, 'purchase_request_cancel', { p_request: id.data }, 'Demande annulée.')
}
export async function decideRequestAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = idOf(fd)
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  const approve = fd.get('decision') === 'approve'
  return rpcAction([P.PURCHASES_APPROVE], 'purchase_request_decide', { p_request: id.data, p_approve: approve, p_comment: String(fd.get('comment') ?? '').trim().slice(0, 500) || null }, approve ? 'Demande validée.' : 'Demande rejetée.')
}

export async function convertRequestAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.PURCHASES_WRITE)
  if ('error' in auth) return auth.error
  const id = idOf(fd)
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('purchase_request_to_orders', { p_request: id.data })
  if (error) return dbFail(auth.ctx, P.PURCHASES_WRITE, error)
  rev()
  const ids = (data as string[]) ?? []
  redirect(ids.length === 1 ? `/purchases/orders/${ids[0]}` : `/purchases/orders?request=${id.data}`)
}

export async function requestFromMrpAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(...REQ)
  if ('error' in auth) return auth.error
  const id = uuid.safeParse(fd.get('id'))
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('purchase_request_from_mrp', { p_run: id.data })
  if (error) return dbFail(auth.ctx, P.PURCHASES_REQUEST, error)
  rev()
  redirect(`/purchases/requests/${data}`)
}

// ---------------------------------------------------------------------
// Commandes fournisseur
// ---------------------------------------------------------------------
export async function createOrderAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.PURCHASES_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const parsed = z.object({ supplier_id: z.uuid('Choisissez un fournisseur'), expected_date: optDate, notes: opt(1000) }).safeParse(obj(fd))
  if (!parsed.success) return invalid(parsed.error, values)
  const supabase = await createClient()
  const { data, error } = await supabase.from('purchase_orders').insert(parsed.data).select('id').single()
  if (error) return dbFail(auth.ctx, P.PURCHASES_WRITE, error, values)
  rev()
  redirect(`/purchases/orders/${data.id}`)
}

export async function updateOrderHeaderAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.PURCHASES_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const parsed = z.object({ id: z.uuid(), expected_date: optDate, notes: opt(1000) }).safeParse(obj(fd))
  if (!parsed.success) return invalid(parsed.error, values)
  const supabase = await createClient()
  const { data, error } = await supabase.from('purchase_orders').update({ expected_date: parsed.data.expected_date, notes: parsed.data.notes }).eq('id', parsed.data.id).select('id')
  if (error) return dbFail(auth.ctx, P.PURCHASES_WRITE, error, values)
  if (!data?.length) return { ok: false, message: 'Commande introuvable ou modification non autorisée.', values }
  rev()
  return { ok: true, message: 'Commande enregistrée.' }
}

export async function addOrderLineAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.PURCHASES_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const parsed = z.object({ po_id: z.uuid(), material_id: z.uuid('Choisissez un composant'), qty_ordered: dec('Quantité'), unit_price: z.string().trim().transform((v) => (v === '' ? '0' : v)).pipe(dec('Prix unitaire', { zero: true })), expected_date: optDate, note: opt(300) }).safeParse(obj(fd))
  if (!parsed.success) return invalid(parsed.error, values)
  const supabase = await createClient()
  const { error } = await supabase.from('purchase_order_lines').insert(parsed.data)
  if (error) return dbFail(auth.ctx, P.PURCHASES_WRITE, error, values)
  rev()
  return { ok: true, message: 'Ligne ajoutée.' }
}

export async function updateOrderLineAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.PURCHASES_WRITE)
  if ('error' in auth) return auth.error
  const parsed = z.object({ id: z.uuid(), qty_ordered: dec('Quantité'), unit_price: dec('Prix unitaire', { zero: true }), expected_date: optDate }).safeParse(obj(fd))
  if (!parsed.success) return invalid(parsed.error, raw(fd))
  const { id, ...fields } = parsed.data
  const supabase = await createClient()
  const { data, error } = await supabase.from('purchase_order_lines').update(fields).eq('id', id).select('id')
  if (error) return dbFail(auth.ctx, P.PURCHASES_WRITE, error)
  if (!data?.length) return { ok: false, message: 'Ligne introuvable ou modification non autorisée.' }
  rev()
  return { ok: true, message: 'Enregistré.' }
}

export async function deleteOrderLineAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.PURCHASES_WRITE)
  if ('error' in auth) return auth.error
  const id = idOf(fd)
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  const supabase = await createClient()
  const { error } = await supabase.from('purchase_order_lines').delete().eq('id', id.data)
  if (error) return dbFail(auth.ctx, P.PURCHASES_WRITE, error)
  rev()
  return { ok: true, message: 'Ligne supprimée.' }
}

export async function sendOrderAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = idOf(fd)
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  return rpcAction([P.PURCHASES_WRITE], 'purchase_order_send', { p_po: id.data }, 'Commande envoyée au fournisseur.')
}
export async function cancelOrderAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = idOf(fd)
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  return rpcAction([P.PURCHASES_WRITE], 'purchase_order_cancel', { p_po: id.data }, 'Commande annulée.')
}

// ---------------------------------------------------------------------
// Réception (entrée en stock automatique) et retour fournisseur
// ---------------------------------------------------------------------
export async function receiveAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.PURCHASES_RECEIVE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const head = z.object({ po_id: z.uuid(), warehouse_id: z.uuid('Choisissez un entrepôt'), location_id: z.uuid('Choisissez un emplacement'), delivery_note: opt(80), notes: opt(300) }).safeParse(obj(fd))
  if (!head.success) return invalid(head.error, values)
  const lines: { line_id: string; qty: number }[] = []
  for (const [k, v] of fd.entries()) {
    if (!k.startsWith('qty_') || typeof v !== 'string' || v.trim() === '') continue
    const n = Number(v.replace(',', '.'))
    if (!Number.isFinite(n) || n < 0) return { ok: false, message: 'Quantité reçue invalide.', values }
    if (n > 0) lines.push({ line_id: k.slice(4), qty: n })
  }
  if (lines.length === 0) return { ok: false, message: 'Saisissez au moins une quantité reçue.', values }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('purchase_receive', { p_po: head.data.po_id, p_warehouse: head.data.warehouse_id, p_location: head.data.location_id, p_lines: lines, p_delivery_note: head.data.delivery_note, p_notes: head.data.notes })
  if (error) return dbFail(auth.ctx, P.PURCHASES_RECEIVE, error, values)
  rev()
  redirect(`/purchases/receipts/${data}?received=1`)
}

export async function returnAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.PURCHASES_RECEIVE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const head = z.object({ receipt_id: z.uuid(), reason: z.string().trim().min(3, 'Motif requis (3 caractères minimum)').max(300) }).safeParse(obj(fd))
  if (!head.success) return invalid(head.error, values)
  const lines: { receipt_line_id: string; qty: number }[] = []
  for (const [k, v] of fd.entries()) {
    if (!k.startsWith('qty_') || typeof v !== 'string' || v.trim() === '') continue
    const n = Number(v.replace(',', '.'))
    if (!Number.isFinite(n) || n < 0) return { ok: false, message: 'Quantité retournée invalide.', values }
    if (n > 0) lines.push({ receipt_line_id: k.slice(4), qty: n })
  }
  if (lines.length === 0) return { ok: false, message: 'Saisissez au moins une quantité à retourner.', values }
  const supabase = await createClient()
  const { error } = await supabase.rpc('purchase_return', { p_receipt: head.data.receipt_id, p_lines: lines, p_reason: head.data.reason })
  if (error) return dbFail(auth.ctx, P.PURCHASES_RECEIVE, error, values)
  rev()
  redirect(`/purchases/receipts/${head.data.receipt_id}?returned=1`)
}
