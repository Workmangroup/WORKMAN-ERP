'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'
import { getAuthContext } from '@/features/auth/services/access.service'
import type { AuthContextValue, FormState } from '@/features/auth/types'
import { logAccessDenied } from '@/features/rbac/services/audit-write.service'
import { isPermissionError, stockErrorMessage } from './errors'

/** Écritures via la session de l'utilisateur : RLS et RPC (stock_*) font autorité. */

const uuid = z.uuid()
const opt = (max: number) => z.string().trim().max(max).transform((v) => (v === '' ? null : v)).optional().transform((v) => v ?? null)
const optUuid = z.string().trim().transform((v) => (v === '' ? null : v)).pipe(z.union([z.null(), z.uuid('Valeur invalide')])).optional().transform((v) => v ?? null)
const decimal = (label: string, opts: { signed?: boolean; zero?: boolean } = {}) =>
  z.string().trim().min(1, `${label} requis`).transform((v) => Number(v.replace(',', '.').replace(/\s/g, '')))
    .refine((n) => Number.isFinite(n), `${label} invalide`)
    .refine((n) => (opts.signed ? n !== 0 : opts.zero ? n >= 0 : n > 0), opts.signed ? `${label} : valeur non nulle` : opts.zero ? `${label} : minimum 0` : `${label} : supérieur à 0`)
    .refine((n) => Math.abs(n) <= 100_000_000, `${label} trop grand`)
const optDecimal = (label: string) =>
  z.string().trim().optional().transform((v) => (v === undefined || v === '' ? null : v)).pipe(z.union([z.null(), decimal(label, { zero: true })]))

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
  return { ok: false, message: stockErrorMessage(err), values }
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
const rev = () => revalidatePath('/stock', 'layout')

// ---------------------------------------------------------------------
// Mouvements
// ---------------------------------------------------------------------
const moveSchema = z.object({
  type: z.enum(['in', 'out', 'transfer', 'adjustment']),
  material_id: z.uuid('Choisissez un composant'),
  warehouse_id: z.uuid('Choisissez un entrepôt'),
  location_id: optUuid,
  to_location_id: optUuid,
  qty: z.string(),
  reference: opt(120),
  reason: opt(300),
  unit_cost: optDecimal('Coût unitaire'),
  reservation_id: optUuid,
})

export async function moveAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const values = raw(fd)
  const parsed = moveSchema.safeParse(obj(fd))
  if (!parsed.success) return invalid(parsed.error, values)
  const d = parsed.data
  const auth = await authorize(d.type === 'adjustment' ? P.STOCK_ADJUST : P.STOCK_WRITE)
  if ('error' in auth) return auth.error
  const q = decimal('Quantité', { signed: d.type === 'adjustment' }).safeParse(d.qty)
  if (!q.success) return invalid(q.error, values)
  if (d.type === 'in' && !d.location_id) return { ok: false, message: 'Choisissez l’emplacement de réception.', fieldErrors: { location_id: ['Emplacement requis'] }, values }
  if (d.type === 'transfer' && !d.to_location_id) return { ok: false, message: 'Choisissez l’emplacement de destination.', fieldErrors: { to_location_id: ['Destination requise'] }, values }
  const supabase = await createClient()
  const { error } = await supabase.rpc('stock_move', {
    p_type: d.type, p_material: d.material_id, p_qty: q.data, p_warehouse: d.warehouse_id,
    p_location: d.location_id, p_to_location: d.type === 'transfer' ? d.to_location_id : null,
    p_reference: d.reference, p_reason: d.reason, p_unit_cost: d.type === 'in' ? d.unit_cost : null,
    p_reservation: d.type === 'out' ? d.reservation_id : null,
  })
  if (error) return dbFail(auth.ctx, d.type === 'adjustment' ? P.STOCK_ADJUST : P.STOCK_WRITE, error, values)
  rev()
  return { ok: true, message: 'Mouvement enregistré.' }
}

// ---------------------------------------------------------------------
// Réservations, stock de sécurité
// ---------------------------------------------------------------------
export async function reserveAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.STOCK_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const parsed = z.object({ material_id: z.uuid('Choisissez un composant'), warehouse_id: z.uuid('Choisissez un entrepôt'), qty: decimal('Quantité'), reference: z.string().trim().min(1, 'Référence requise').max(120), note: opt(300) }).safeParse(obj(fd))
  if (!parsed.success) return invalid(parsed.error, values)
  const d = parsed.data
  const supabase = await createClient()
  const { error } = await supabase.rpc('stock_reserve', { p_material: d.material_id, p_warehouse: d.warehouse_id, p_qty: d.qty, p_reference: d.reference, p_note: d.note })
  if (error) return dbFail(auth.ctx, P.STOCK_WRITE, error, values)
  rev()
  return { ok: true, message: 'Stock réservé.' }
}

export async function releaseAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.STOCK_WRITE)
  if ('error' in auth) return auth.error
  const id = uuid.safeParse(fd.get('id'))
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  const supabase = await createClient()
  const { error } = await supabase.rpc('stock_release', { p_reservation: id.data })
  if (error) return dbFail(auth.ctx, P.STOCK_WRITE, error)
  rev()
  return { ok: true, message: 'Réservation libérée.' }
}

export async function setSafetyAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.STOCK_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const parsed = z.object({ material_id: z.uuid(), warehouse_id: z.uuid(), qty: decimal('Stock de sécurité', { zero: true }) }).safeParse(obj(fd))
  if (!parsed.success) return invalid(parsed.error, values)
  const supabase = await createClient()
  const { error } = await supabase.rpc('stock_set_safety', { p_material: parsed.data.material_id, p_warehouse: parsed.data.warehouse_id, p_qty: parsed.data.qty })
  if (error) return dbFail(auth.ctx, P.STOCK_WRITE, error, values)
  rev()
  return { ok: true, message: 'Stock de sécurité enregistré.' }
}

// ---------------------------------------------------------------------
// Entrepôts et emplacements
// ---------------------------------------------------------------------
export async function saveWarehouseAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.STOCK_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const parsed = z.object({ id: optUuid, name: z.string().trim().min(2, 'Nom requis (2 caractères minimum)').max(120), city: opt(80), address: opt(200) }).safeParse(obj(fd))
  if (!parsed.success) return invalid(parsed.error, values)
  const { id, ...fields } = parsed.data
  const supabase = await createClient()
  if (id) {
    const { data, error } = await supabase.from('warehouses').update(fields).eq('id', id).select('id')
    if (error) return dbFail(auth.ctx, P.STOCK_WRITE, error, values)
    if (!data?.length) return { ok: false, message: 'Entrepôt introuvable ou modification non autorisée.', values }
  } else {
    const { error } = await supabase.from('warehouses').insert(fields)
    if (error) return dbFail(auth.ctx, P.STOCK_WRITE, error, values)
  }
  rev()
  return { ok: true, message: id ? 'Entrepôt enregistré.' : 'Entrepôt créé (emplacement général GEN ajouté).' }
}

export async function saveLocationAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.STOCK_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const parsed = z.object({
    id: optUuid, warehouse_id: z.uuid(), code: z.string().trim().min(1, 'Code requis').max(30), name: opt(80),
    kind: z.enum(['storage', 'receiving', 'shipping', 'quarantine']),
  }).safeParse(obj(fd))
  if (!parsed.success) return invalid(parsed.error, values)
  const { id, ...f } = parsed.data
  const supabase = await createClient()
  if (id) {
    const { data, error } = await supabase.from('stock_locations').update({ name: f.name, kind: f.kind }).eq('id', id).select('id')
    if (error) return dbFail(auth.ctx, P.STOCK_WRITE, error, values)
    if (!data?.length) return { ok: false, message: 'Emplacement introuvable ou modification non autorisée.', values }
  } else {
    const { error } = await supabase.from('stock_locations').insert({ warehouse_id: f.warehouse_id, code: f.code.toUpperCase(), name: f.name, kind: f.kind })
    if (error) return dbFail(auth.ctx, P.STOCK_WRITE, error, values)
  }
  rev()
  return { ok: true, message: id ? 'Emplacement enregistré.' : 'Emplacement créé.' }
}

export async function archiveWarehouseAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.STOCK_WRITE)
  if ('error' in auth) return auth.error
  const id = uuid.safeParse(fd.get('id'))
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  const supabase = await createClient()
  const { error } = await supabase.rpc('stock_warehouse_archive', { p_warehouse: id.data, p_archive: fd.get('archive') === '1' })
  if (error) return dbFail(auth.ctx, P.STOCK_WRITE, error)
  rev()
  return { ok: true, message: fd.get('archive') === '1' ? 'Entrepôt archivé.' : 'Entrepôt restauré.' }
}

export async function archiveLocationAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.STOCK_WRITE)
  if ('error' in auth) return auth.error
  const id = uuid.safeParse(fd.get('id'))
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  const supabase = await createClient()
  const { error } = await supabase.rpc('stock_location_archive', { p_location: id.data, p_archive: fd.get('archive') === '1' })
  if (error) return dbFail(auth.ctx, P.STOCK_WRITE, error)
  rev()
  return { ok: true, message: fd.get('archive') === '1' ? 'Emplacement archivé.' : 'Emplacement restauré.' }
}

// ---------------------------------------------------------------------
// Inventaires
// ---------------------------------------------------------------------
export async function createInventoryAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.STOCK_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const parsed = z.object({ warehouse_id: z.uuid('Choisissez un entrepôt'), location_id: optUuid, note: opt(300) }).safeParse(obj(fd))
  if (!parsed.success) return invalid(parsed.error, values)
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('stock_inventory_create', { p_warehouse: parsed.data.warehouse_id, p_location: parsed.data.location_id, p_note: parsed.data.note })
  if (error) return dbFail(auth.ctx, P.STOCK_WRITE, error, values)
  rev()
  redirect(`/stock/inventories/${data}`)
}

export async function countLineAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.STOCK_WRITE)
  if ('error' in auth) return auth.error
  const parsed = z.object({ id: z.uuid(), counted: optDecimal('Quantité comptée') }).safeParse({ id: fd.get('id'), counted: String(fd.get('counted') ?? '') })
  if (!parsed.success) return invalid(parsed.error, raw(fd))
  if (parsed.data.counted === null) return { ok: false, message: 'Saisissez la quantité comptée.' }
  const supabase = await createClient()
  // Comptage aveugle : la saisie passe par la RPC (passage 1 ou 2 selon la phase, un seul passage par compteur et par ligne).
  const { error } = await supabase.rpc('stock_inventory_count_submit', { p_line: parsed.data.id, p_qty: parsed.data.counted })
  if (error) return dbFail(auth.ctx, P.STOCK_WRITE, error)
  rev()
  return { ok: true, message: 'Comptage enregistré.' }
}

export async function addInventoryLineAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.STOCK_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const parsed = z.object({ inventory_id: z.uuid(), material_id: z.uuid('Choisissez un composant'), location_id: z.uuid('Choisissez un emplacement') }).safeParse(obj(fd))
  if (!parsed.success) return invalid(parsed.error, values)
  const supabase = await createClient()
  const { error } = await supabase.rpc('stock_inventory_add_line', { p_inventory: parsed.data.inventory_id, p_material: parsed.data.material_id, p_location: parsed.data.location_id })
  if (error) return dbFail(auth.ctx, P.STOCK_WRITE, error, values)
  rev()
  return { ok: true, message: 'Ligne ajoutée.' }
}

/** Clôture du passage en cours (comptage ou recomptage) : écarts non expliqués → recomptage, sinon réconciliation. */
export async function closeInventoryCountAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.STOCK_WRITE)
  if ('error' in auth) return auth.error
  const id = uuid.safeParse(fd.get('id'))
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  const supabase = await createClient()
  const { data: inv } = await supabase.from('stock_inventories').select('phase').eq('id', id.data).maybeSingle()
  if (inv?.phase === 'recounting') {
    const { data, error } = await supabase.rpc('stock_inventory_close_recount', { p_inventory: id.data })
    if (error) return dbFail(auth.ctx, P.STOCK_WRITE, error)
    rev()
    return { ok: true, message: `Recomptage clos : ${(data as { recounted_lines?: number } | null)?.recounted_lines ?? 0} ligne(s) recomptée(s).` }
  }
  const { data, error } = await supabase.rpc('stock_inventory_close_count', { p_inventory: id.data })
  if (error) return dbFail(auth.ctx, P.STOCK_WRITE, error)
  rev()
  const recount = (data as { recount_lines?: number } | null)?.recount_lines ?? 0
  return { ok: true, message: recount > 0 ? `${recount} ligne(s) à recompter (écart non expliqué).` : 'Comptage clos : réconciliation prête.' }
}

export async function requestInventoryApprovalAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.STOCK_WRITE)
  if ('error' in auth) return auth.error
  const id = uuid.safeParse(fd.get('id'))
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  const supabase = await createClient()
  const { error } = await supabase.rpc('stock_inventory_request_approval', { p_inventory: id.data })
  if (error) return dbFail(auth.ctx, P.STOCK_WRITE, error)
  rev()
  return { ok: true, message: 'Demande d’accord envoyée. Un autre utilisateur doit la décider.' }
}

/** Décision distincte : approuver (ajuste le stock réel) ou refuser (motif). Le compteur et le demandeur ne peuvent pas décider. */
export async function decideInventoryAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.STOCK_ADJUST)
  if ('error' in auth) return auth.error
  const id = uuid.safeParse(fd.get('id'))
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  const approve = String(fd.get('approve') ?? '') === 'true'
  const reason = String(fd.get('reason') ?? '').trim()
  if (reason.length < 5) return { ok: false, message: 'Motif obligatoire (5 caractères minimum).' }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('stock_inventory_decide', { p_inventory: id.data, p_approve: approve, p_reason: reason })
  if (error) return dbFail(auth.ctx, P.STOCK_ADJUST, error)
  rev()
  if (!approve) return { ok: true, message: 'Accord refusé : l’inventaire retourne en réconciliation.' }
  const res = data as { adjusted?: number; qty_delta?: number } | null
  return { ok: true, message: `Inventaire validé : ${res?.adjusted ?? 0} écart(s) appliqué(s) au stock.` }
}

export async function cancelInventoryAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.STOCK_WRITE)
  if ('error' in auth) return auth.error
  const id = uuid.safeParse(fd.get('id'))
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  const supabase = await createClient()
  const { error } = await supabase.rpc('stock_inventory_cancel', { p_inventory: id.data })
  if (error) return dbFail(auth.ctx, P.STOCK_WRITE, error)
  rev()
  return { ok: true, message: 'Inventaire annulé.' }
}
