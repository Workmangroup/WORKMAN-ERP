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

/** Expédition : chaque étape (préparation, picking, colisage, expédition, livraison, facture export) est contrôlée par une fonction SQL (0021). */

const uuid = (label: string) => z.uuid(`${label} invalide`)
const optText = (max: number) => z.string().trim().max(max).optional().transform((v) => (v ? v : null))
const int = (label: string, min = 1) => z.string().trim().min(1, `${label} requis`)
  .transform((v) => Number(v.replace(/\s/g, '')))
  .refine((n) => Number.isInteger(n) && n >= min, `${label} : entier ≥ ${min}`)
  .refine((n) => n <= 1_000_000, `${label} trop grand`)
const dec = (label: string) => z.string().trim().optional().transform((v) => (v ? Number(v.replace(',', '.')) : null))
  .refine((n) => n === null || (Number.isFinite(n) && n >= 0), `${label} invalide`)

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
const MESSAGES: [string, string][] = [
  ['SHIPPING_ORDER_NOT_CONFIRMED', 'Seule une commande confirmée peut être préparée.'],
  ['SHIPPING_ARTICLE_NOT_IN_ORDER', 'Cette variante n’appartient pas à un article de la commande.'],
  ['SHIPPING_QTY_EXCEEDS_ORDER', 'La quantité dépasse ce qui reste à affecter sur la commande pour cet article.'],
  ['SHIPPING_QTY_EXCEEDS_LINE', 'La quantité prélevée dépasse la quantité demandée sur la ligne.'],
  ['SHIPPING_STOCK_INSUFFICIENT', 'Stock disponible insuffisant (en stock − déjà réservé).'],
  ['SHIPPING_NOT_PICKED', 'Toutes les lignes doivent être entièrement prélevées avant le colisage.'],
  ['SHIPPING_BAD_WEIGHT', 'Le poids net ne peut pas dépasser le poids brut.'],
  ['SHIPPING_BAD_STATUS', 'Cette action n’est pas possible dans l’état actuel de l’expédition.'],
  ['SHIPPING_BAD_EVENT', 'Évènement de suivi non autorisé ici.'],
  ['SHIPPING_REASON_REQUIRED', 'Motif trop court (5 caractères minimum).'],
  ['SHIPPING_EXPORT_DATA_MISSING', 'La facture export exige un incoterm et un pays de destination.'],
  ['SHIPPING_ALREADY_INVOICED', 'Une facture export a déjà été émise pour cette expédition.'],
  ['SHIPPING_IMMUTABLE', 'Le journal de suivi ne peut pas être modifié.'],
  ['SHIPPING_NOT_FOUND', 'Expédition introuvable.'],
  ['RBAC_FORBIDDEN', 'Vous n’avez pas la permission d’effectuer cette action.'],
  ['check constraint', 'Une valeur ne respecte pas les règles de saisie.'],
]
const messageOf = (err: { message?: string; code?: string; details?: string | null }) => {
  const text = `${err.message ?? ''} ${err.details ?? ''}`
  for (const [k, m] of MESSAGES) if (text.includes(k)) return m
  if (err.code === '42501' || text.includes('row-level security')) return 'Vous n’avez pas la permission d’effectuer cette action.'
  return 'Une erreur est survenue. Réessayez ou contactez un administrateur.'
}
async function dbFail(ctx: AuthContextValue, err: { message?: string; code?: string; details?: string | null }, values?: Record<string, string>): Promise<FormState> {
  if (isPermissionError(err)) await logAccessDenied(ctx, P.SHIPMENTS_WRITE, { via: 'database' })
  return { ok: false, message: messageOf(err), values }
}
const rev = () => revalidatePath('/shipments', 'layout')

async function run(fn: string, args: Record<string, unknown>, values: Record<string, string>, success: string | ((data: unknown) => string)): Promise<FormState> {
  const ctx = await requireCtx()
  const supabase = await createClient()
  const { data, error } = await supabase.rpc(fn, args)
  if (error) return dbFail(ctx, error, values)
  rev()
  return { ok: true, message: typeof success === 'function' ? success(data) : success }
}

export async function createShipmentAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const values = raw(fd)
  const parsed = z.object({
    order_id: uuid('Commande'), warehouse_id: uuid('Entrepôt'),
    incoterm: z.string().trim().optional().transform((v) => (v ? v : null))
      .pipe(z.union([z.null(), z.enum(['EXW', 'FCA', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP'], { message: 'Incoterm inconnu' })])),
    country: z.string().trim().optional().transform((v) => (v ? v.toUpperCase() : null))
      .pipe(z.union([z.null(), z.string().regex(/^[A-Z]{2}$/, 'Pays : code ISO à 2 lettres')])),
    currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'Devise : code ISO à 3 lettres'),
  }).safeParse({ order_id: fd.get('order_id'), warehouse_id: fd.get('warehouse_id'), incoterm: fd.get('incoterm'), country: fd.get('country'), currency: fd.get('currency') || 'EUR' })
  if (!parsed.success) return invalid(parsed.error, values)
  const d = parsed.data
  return run('shipment_create', { p_order: d.order_id, p_warehouse: d.warehouse_id, p_incoterm: d.incoterm, p_country: d.country, p_currency: d.currency },
    values, 'Expédition préparée.')
}

export async function addShipmentLineAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const values = raw(fd)
  const parsed = z.object({ shipment_id: uuid('Expédition'), variant_id: uuid('Variante'), qty: int('Quantité') })
    .safeParse({ shipment_id: fd.get('shipment_id'), variant_id: fd.get('variant_id'), qty: fd.get('qty') })
  if (!parsed.success) return invalid(parsed.error, values)
  return run('shipment_add_line', { p_shipment: parsed.data.shipment_id, p_variant: parsed.data.variant_id, p_qty: parsed.data.qty }, values, 'Ligne ajoutée.')
}

export async function pickLineAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const values = raw(fd)
  const parsed = z.object({ line_id: uuid('Ligne'), qty: int('Quantité prélevée') }).safeParse({ line_id: fd.get('line_id'), qty: fd.get('qty') })
  if (!parsed.success) return invalid(parsed.error, values)
  return run('shipment_pick', { p_line: parsed.data.line_id, p_qty: parsed.data.qty }, values, 'Prélèvement enregistré.')
}

export async function packShipmentAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const values = raw(fd)
  const parsed = z.object({
    shipment_id: uuid('Expédition'), packages: int('Nombre de colis'), gross: dec('Poids brut'), net: dec('Poids net'),
  }).safeParse({ shipment_id: fd.get('shipment_id'), packages: fd.get('packages'), gross: fd.get('gross'), net: fd.get('net') })
  if (!parsed.success) return invalid(parsed.error, values)
  const d = parsed.data
  return run('shipment_pack', { p_shipment: d.shipment_id, p_packages: d.packages, p_gross: d.gross, p_net: d.net }, values, 'Colisage enregistré.')
}

export async function shipShipmentAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const values = raw(fd)
  const parsed = z.object({ shipment_id: uuid('Expédition'), carrier: optText(80), tracking: optText(80) })
    .safeParse({ shipment_id: fd.get('shipment_id'), carrier: fd.get('carrier'), tracking: fd.get('tracking') })
  if (!parsed.success) return invalid(parsed.error, values)
  return run('shipment_ship', { p_shipment: parsed.data.shipment_id, p_carrier: parsed.data.carrier, p_tracking: parsed.data.tracking }, values,
    (bl) => `Expédié. Bon de livraison ${String(bl)}.`)
}

export async function deliverShipmentAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const parsed = z.object({ shipment_id: uuid('Expédition') }).safeParse({ shipment_id: fd.get('shipment_id') })
  if (!parsed.success) return { ok: false, message: 'Expédition invalide.' }
  return run('shipment_deliver', { p_shipment: parsed.data.shipment_id }, {}, 'Livraison confirmée.')
}

export async function cancelShipmentAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const values = raw(fd)
  const parsed = z.object({ shipment_id: uuid('Expédition'), reason: z.string().trim().min(5, 'Motif : 5 caractères minimum').max(300) })
    .safeParse({ shipment_id: fd.get('shipment_id'), reason: fd.get('reason') })
  if (!parsed.success) return invalid(parsed.error, values)
  return run('shipment_cancel', { p_shipment: parsed.data.shipment_id, p_reason: parsed.data.reason }, values, 'Expédition annulée, réservations libérées.')
}

export async function trackShipmentAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const values = raw(fd)
  const parsed = z.object({
    shipment_id: uuid('Expédition'), event: z.enum(['in_transit', 'exception'], { message: 'Évènement inconnu' }),
    location: optText(120), note: optText(300),
  }).safeParse({ shipment_id: fd.get('shipment_id'), event: fd.get('event'), location: fd.get('location'), note: fd.get('note') })
  if (!parsed.success) return invalid(parsed.error, values)
  const d = parsed.data
  return run('shipment_track', { p_shipment: d.shipment_id, p_event: d.event, p_location: d.location, p_note: d.note }, values, 'Évènement enregistré.')
}

export async function exportInvoiceAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const parsed = z.object({ shipment_id: uuid('Expédition') }).safeParse({ shipment_id: fd.get('shipment_id') })
  if (!parsed.success) return { ok: false, message: 'Expédition invalide.' }
  return run('shipment_export_invoice', { p_shipment: parsed.data.shipment_id }, {}, (no) => `Facture export ${String(no)} émise.`)
}
