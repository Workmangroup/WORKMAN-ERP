'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'
import { getAuthContext } from '@/features/auth/services/access.service'
import type { AuthContextValue, FormState } from '@/features/auth/types'
import { logAccessDenied } from '@/features/rbac/services/audit-write.service'
import { isPermissionError, variantErrorMessage } from './errors'

/** Écritures via la session de l'utilisateur : RLS et RPC (variants.*) font autorité. */

const uuid = z.uuid()

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
  return { ok: false, message: variantErrorMessage(err), values }
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
const rev = (productId?: string) => { revalidatePath('/variants', 'layout'); if (productId) revalidatePath(`/variants/${productId}`, 'layout') }
const int = (fd: FormData, k: string) => { const v = String(fd.get(k) ?? '').trim(); return v === '' ? NaN : Number(v.replace(',', '.')) }

// ---------------------------------------------------------------------
// Catalogues tailles / couleurs
// ---------------------------------------------------------------------
const sizeSchema = z.object({
  code: z.string().trim().min(1, 'Code requis').max(12, '12 caractères maximum'), label: z.string().trim().min(1, 'Libellé requis').max(30),
  size_group: z.enum(['letters', 'numeric', 'other']), sort_order: z.string().trim().transform((v) => (v === '' ? 100 : Number(v))).pipe(z.number().int('Ordre : entier').min(0).max(100000)),
})
const colorSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,10}$/, 'Code : lettres et chiffres, 10 maximum'), name: z.string().trim().min(1, 'Nom requis').max(60),
  hex: z.string().trim().transform((v) => (v === '' ? null : v)).pipe(z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Teinte invalide (#RRGGBB)').nullable()),
  pantone: z.string().trim().max(30).transform((v) => (v === '' ? null : v)),
})

export async function saveSizeAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.VARIANTS_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const parsed = sizeSchema.safeParse(obj(fd))
  if (!parsed.success) return invalid(parsed.error, values)
  const supabase = await createClient()
  const id = String(fd.get('id') ?? '')
  const { code, ...rest } = parsed.data
  const { error } = id && uuid.safeParse(id).success
    ? await supabase.from('sizes').update(rest).eq('id', id)
    : await supabase.from('sizes').insert({ code, ...rest })
  if (error) return dbFail(auth.ctx, P.VARIANTS_WRITE, error, values)
  rev()
  return { ok: true, message: id ? 'Taille mise à jour.' : 'Taille ajoutée.' }
}
export async function saveColorAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.VARIANTS_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const parsed = colorSchema.safeParse(obj(fd))
  if (!parsed.success) return invalid(parsed.error, values)
  const supabase = await createClient()
  const id = String(fd.get('id') ?? '')
  const { code, ...rest } = parsed.data
  const { error } = id && uuid.safeParse(id).success
    ? await supabase.from('colors').update(rest).eq('id', id)
    : await supabase.from('colors').insert({ code, ...rest })
  if (error) return dbFail(auth.ctx, P.VARIANTS_WRITE, error, values)
  rev()
  return { ok: true, message: id ? 'Couleur mise à jour.' : 'Couleur ajoutée.' }
}
export async function toggleCatalogAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.VARIANTS_WRITE)
  if ('error' in auth) return auth.error
  const id = uuid.safeParse(fd.get('id'))
  const table = z.enum(['sizes', 'colors']).safeParse(fd.get('table'))
  if (!id.success || !table.success) return { ok: false, message: 'Données invalides.' }
  const supabase = await createClient()
  const { error } = await supabase.from(table.data).update({ active: String(fd.get('active')) === 'true' }).eq('id', id.data)
  if (error) return dbFail(auth.ctx, P.VARIANTS_WRITE, error)
  rev()
  return { ok: true, message: 'Catalogue mis à jour.' }
}
export async function deleteCatalogAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.VARIANTS_WRITE)
  if ('error' in auth) return auth.error
  const id = uuid.safeParse(fd.get('id'))
  const table = z.enum(['sizes', 'colors']).safeParse(fd.get('table'))
  if (!id.success || !table.success) return { ok: false, message: 'Données invalides.' }
  const supabase = await createClient()
  const { error } = await supabase.from(table.data).delete().eq('id', id.data)
  if (error) return dbFail(auth.ctx, P.VARIANTS_WRITE, error)
  rev()
  return { ok: true, message: 'Supprimé.' }
}
export async function seedDefaultsAction(_prev: FormState, _fd: FormData): Promise<FormState> {
  const auth = await authorize(P.VARIANTS_WRITE)
  if ('error' in auth) return auth.error
  const supabase = await createClient()
  const { error } = await supabase.rpc('variants_seed_defaults')
  if (error) return dbFail(auth.ctx, P.VARIANTS_WRITE, error)
  rev()
  return { ok: true, message: 'Catalogue standard chargé (les éléments existants sont conservés).' }
}

// ---------------------------------------------------------------------
// Matrice
// ---------------------------------------------------------------------
export async function generateVariantsAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.VARIANTS_WRITE)
  if ('error' in auth) return auth.error
  const pid = uuid.safeParse(fd.get('product_id'))
  const colors = z.array(uuid).safeParse(fd.getAll('color').map(String))
  const sizes = z.array(uuid).safeParse(fd.getAll('size').map(String))
  if (!pid.success || !colors.success || !sizes.success) return { ok: false, message: 'Données invalides.' }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('variant_generate', { p_product: pid.data, p_colors: colors.data, p_sizes: sizes.data })
  if (error) return dbFail(auth.ctx, P.VARIANTS_WRITE, error)
  rev(pid.data)
  return { ok: true, message: data === 0 ? 'Aucune nouvelle variante : toutes les combinaisons existent déjà.' : `${data} variante(s) créée(s).` }
}

export async function syncFromSpecAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.VARIANTS_WRITE)
  if ('error' in auth) return auth.error
  const pid = uuid.safeParse(fd.get('product_id'))
  if (!pid.success) return { ok: false, message: 'Données invalides.' }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('variant_sync_from_spec', { p_product: pid.data })
  if (error) return dbFail(auth.ctx, P.VARIANTS_WRITE, error)
  rev(pid.data)
  const r = data as { colors_created: number; sizes_created: number; variants_created: number }
  return { ok: true, message: `Import terminé : ${r.variants_created} variante(s), ${r.colors_created} couleur(s) et ${r.sizes_created} taille(s) ajoutées au catalogue.` }
}

const changeSchema = z.array(z.object({
  id: z.uuid(),
  price: z.number().min(0).max(999_999_999).nullable().optional(),
  barcode: z.string().trim().max(14).nullable().optional(),
  active: z.boolean().optional(),
  bom_id: z.uuid().nullable().optional(),
})).min(1, 'Aucune modification').max(800)

/** Enregistre les modifications de la matrice (prix, codes-barres, activation, nomenclature) en une seule transaction. */
export async function saveMatrixAction(productId: string, changes: unknown): Promise<FormState> {
  const auth = await authorize(P.VARIANTS_WRITE)
  if ('error' in auth) return auth.error
  if (!uuid.safeParse(productId).success) return { ok: false, message: 'Identifiant invalide.' }
  const parsed = changeSchema.safeParse(changes)
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'Modifications invalides.' }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('variant_bulk_update', { p_product: productId, p_changes: parsed.data })
  if (error) return dbFail(auth.ctx, P.VARIANTS_WRITE, error)
  rev(productId)
  return { ok: true, message: data === 0 ? 'Aucune modification à enregistrer.' : `${data} variante(s) mise(s) à jour.` }
}

export async function assignBarcodesAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.VARIANTS_WRITE)
  if ('error' in auth) return auth.error
  const pid = uuid.safeParse(fd.get('product_id'))
  if (!pid.success) return { ok: false, message: 'Données invalides.' }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('variant_assign_barcodes', { p_product: pid.data })
  if (error) return dbFail(auth.ctx, P.VARIANTS_WRITE, error)
  rev(pid.data)
  return { ok: true, message: data === 0 ? 'Toutes les variantes actives ont déjà un code-barres.' : `${data} code(s)-barres EAN-13 généré(s).` }
}

export async function deleteVariantAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.VARIANTS_WRITE)
  if ('error' in auth) return auth.error
  const id = uuid.safeParse(fd.get('id'))
  const pid = uuid.safeParse(fd.get('product_id'))
  if (!id.success || !pid.success) return { ok: false, message: 'Données invalides.' }
  const supabase = await createClient()
  const { error } = await supabase.rpc('variant_delete', { p_variant: id.data })
  if (error) return dbFail(auth.ctx, P.VARIANTS_WRITE, error)
  rev(pid.data)
  return { ok: true, message: 'Variante supprimée.' }
}

/** Crée une nomenclature propre à la variante (copie de celle du produit, sans article) et l'affecte à la variante, à sa couleur ou à toutes. */
export async function createVariantBomAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.VARIANTS_WRITE)
  if ('error' in auth) return auth.error
  const pid = uuid.safeParse(fd.get('product_id'))
  const vid = uuid.safeParse(fd.get('variant_id'))
  const bom = uuid.safeParse(fd.get('source_bom'))
  const scope = z.enum(['variant', 'color', 'all']).safeParse(fd.get('scope'))
  const name = String(fd.get('name') ?? '').trim().slice(0, 160)
  if (!pid.success || !vid.success || !bom.success || !scope.success || name.length < 2) return { ok: false, message: 'Donnez un nom d’au moins 2 caractères à la nouvelle nomenclature.' }
  if (!auth.ctx.permissions.includes(P.BOM_WRITE)) return { ok: false, message: 'La création d’une nomenclature exige le droit « Gérer les nomenclatures ».' }
  const supabase = await createClient()
  const { data: copy, error: e1 } = await supabase.rpc('bom_duplicate', { p_bom: bom.data, p_name: name, p_article: null, p_version: null })
  if (e1) return { ok: false, message: 'Copie de la nomenclature impossible : ' + variantErrorMessage(e1) }
  const { data: me } = await supabase.from('product_variants').select('color_id').eq('id', vid.data).maybeSingle()
  let q = supabase.from('product_variants').select('id').eq('product_id', pid.data)
  if (scope.data === 'variant') q = q.eq('id', vid.data)
  else if (scope.data === 'color' && me) q = q.eq('color_id', me.color_id as string)
  const { data: targets } = await q
  const { error } = await supabase.rpc('variant_bulk_update', { p_product: pid.data, p_changes: (targets ?? []).map((t) => ({ id: t.id as string, bom_id: copy as string })) })
  if (error) return dbFail(auth.ctx, P.VARIANTS_WRITE, error)
  rev(pid.data)
  return { ok: true, message: `Nomenclature créée et affectée à ${targets?.length ?? 0} variante(s). Ouvrez-la dans le module Nomenclatures pour l’adapter.` }
}

// ---------------------------------------------------------------------
// Stock par variante
// ---------------------------------------------------------------------
export async function stockMoveAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.VARIANTS_STOCK)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const vid = uuid.safeParse(fd.get('variant_id'))
  const pid = uuid.safeParse(fd.get('product_id'))
  const wh = uuid.safeParse(fd.get('warehouse_id'))
  const to = String(fd.get('to_warehouse_id') ?? '')
  const type = z.enum(['receipt', 'issue', 'adjustment', 'inventory', 'transfer']).safeParse(fd.get('type'))
  const qty = int(fd, 'qty')
  if (!vid.success || !pid.success || !wh.success || !type.success) return { ok: false, message: 'Données invalides.', values }
  if (!Number.isInteger(qty)) return { ok: false, message: 'Quantité : nombre entier requis.', values, fieldErrors: { qty: ['Nombre entier requis'] } }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('variant_stock_move', {
    p_variant: vid.data, p_type: type.data, p_warehouse: wh.data, p_qty: qty, p_to_warehouse: uuid.safeParse(to).success ? to : null,
    p_reason: String(fd.get('reason') ?? '').trim().slice(0, 200) || null, p_reference: String(fd.get('reference') ?? '').trim().slice(0, 80) || null,
  })
  if (error) return dbFail(auth.ctx, P.VARIANTS_STOCK, error, values)
  rev(pid.data)
  const r = data as { on_hand: number; available: number }
  return { ok: true, message: `Mouvement enregistré : ${r.on_hand} en stock, ${r.available} disponible(s).` }
}

export async function reserveStockAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.VARIANTS_STOCK)
  if ('error' in auth) return auth.error
  const vid = uuid.safeParse(fd.get('variant_id'))
  const pid = uuid.safeParse(fd.get('product_id'))
  const wh = uuid.safeParse(fd.get('warehouse_id'))
  const delta = int(fd, 'delta')
  if (!vid.success || !pid.success || !wh.success || !Number.isInteger(delta)) return { ok: false, message: 'Quantité : nombre entier requis (négatif pour libérer).' }
  const supabase = await createClient()
  const { error } = await supabase.rpc('variant_stock_reserve', { p_variant: vid.data, p_warehouse: wh.data, p_delta: delta })
  if (error) return dbFail(auth.ctx, P.VARIANTS_STOCK, error)
  rev(pid.data)
  return { ok: true, message: delta > 0 ? 'Pièces réservées.' : 'Réservation libérée.' }
}

export async function safetyStockAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.VARIANTS_STOCK)
  if ('error' in auth) return auth.error
  const vid = uuid.safeParse(fd.get('variant_id'))
  const pid = uuid.safeParse(fd.get('product_id'))
  const wh = uuid.safeParse(fd.get('warehouse_id'))
  const qty = int(fd, 'qty')
  if (!vid.success || !pid.success || !wh.success || !Number.isInteger(qty) || qty < 0) return { ok: false, message: 'Stock de sécurité : entier positif ou nul.' }
  const supabase = await createClient()
  const { error } = await supabase.rpc('variant_stock_set_safety', { p_variant: vid.data, p_warehouse: wh.data, p_qty: qty })
  if (error) return dbFail(auth.ctx, P.VARIANTS_STOCK, error)
  rev(pid.data)
  return { ok: true, message: 'Stock de sécurité enregistré.' }
}
