'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'
import { getAuthContext } from '@/features/auth/services/access.service'
import type { AuthContextValue, FormState } from '@/features/auth/types'
import { logAccessDenied } from '@/features/rbac/services/audit-write.service'
import { isPermissionError, warehouseErrorMessage } from './errors'

/** Écritures via la session de l'utilisateur : RLS, déclencheurs et RPC (wh_*) font autorité. */

const uuid = z.uuid()
const txt = (max: number) => z.string().trim().max(max).transform((v) => (v === '' ? null : v))

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
  return { ok: false, message: warehouseErrorMessage(err), values }
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
const rev = (id?: string) => { revalidatePath('/warehouses', 'layout'); revalidatePath('/stock', 'layout'); if (id) revalidatePath(`/warehouses/${id}`, 'layout') }

// ---------------------------------------------------------------------
// Entrepôt
// ---------------------------------------------------------------------
const whSchema = z.object({
  name: z.string().trim().min(2, 'Nom requis (2 caractères minimum)').max(120),
  kind: z.enum(['fabric', 'supplies', 'finished_goods', 'mixed', 'other'], { error: 'Choisissez le type d’entrepôt' }),
  city: txt(80).optional().transform((v) => v ?? null),
  address: txt(200).optional().transform((v) => v ?? null),
})

export async function createWarehouseAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.WAREHOUSES_MANAGE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const parsed = whSchema.safeParse(Object.fromEntries(fd.entries()))
  if (!parsed.success) return invalid(parsed.error, values)
  const supabase = await createClient()
  const { data, error } = await supabase.from('warehouses').insert(parsed.data).select('id').single()
  if (error) return dbFail(auth.ctx, P.WAREHOUSES_MANAGE, error, values)
  rev()
  redirect(`/warehouses/${data.id}?created=1`)
}

export async function updateWarehouseAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = uuid.safeParse(fd.get('id'))
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  const auth = await authorize(P.STOCK_READ)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const parsed = whSchema.safeParse(Object.fromEntries(fd.entries()))
  if (!parsed.success) return invalid(parsed.error, values)
  const supabase = await createClient()
  const { data, error } = await supabase.from('warehouses').update(parsed.data).eq('id', id.data).select('id')
  if (error) return dbFail(auth.ctx, P.STOCK_READ, error, values)
  if (!data?.length) return { ok: false, message: 'Entrepôt introuvable ou modification non autorisée.', values }
  rev(id.data)
  return { ok: true, message: 'Entrepôt mis à jour.' }
}

// ---------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------
const zoneSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9._-]{0,19}$/, 'Code : lettres, chiffres, . _ - (20 max)'),
  name: z.string().trim().min(2, 'Nom requis').max(80),
  zone_type: z.enum(['storage', 'reception', 'cutting', 'workshop', 'quarantine', 'shipping', 'other']),
  notes: txt(300).optional().transform((v) => v ?? null),
})

export async function saveZoneAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const wid = uuid.safeParse(fd.get('warehouse_id'))
  if (!wid.success) return { ok: false, message: 'Entrepôt invalide.' }
  const auth = await authorize(P.STOCK_READ)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const parsed = zoneSchema.safeParse(Object.fromEntries(fd.entries()))
  if (!parsed.success) return invalid(parsed.error, values)
  const supabase = await createClient()
  const id = String(fd.get('id') ?? '')
  const { error } = id && uuid.safeParse(id).success
    ? await supabase.from('warehouse_locations').update({ name: parsed.data.name, zone_type: parsed.data.zone_type, notes: parsed.data.notes }).eq('id', id)
    : await supabase.from('warehouse_locations').insert({ warehouse_id: wid.data, ...parsed.data })
  if (error) return dbFail(auth.ctx, P.STOCK_READ, error, values)
  rev(wid.data)
  return { ok: true, message: id ? 'Zone mise à jour.' : 'Zone créée.' }
}

export async function archiveZoneAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = uuid.safeParse(fd.get('id'))
  const wid = uuid.safeParse(fd.get('warehouse_id'))
  if (!id.success || !wid.success) return { ok: false, message: 'Identifiant invalide.' }
  const auth = await authorize(P.STOCK_READ)
  if ('error' in auth) return auth.error
  const supabase = await createClient()
  const restore = String(fd.get('restore') ?? '') === '1'
  const { error } = await supabase.from('warehouse_locations').update({ archived_at: restore ? null : new Date().toISOString() }).eq('id', id.data)
  if (error) return dbFail(auth.ctx, P.STOCK_READ, error)
  rev(wid.data)
  return { ok: true, message: restore ? 'Zone réactivée.' : 'Zone archivée.' }
}

// ---------------------------------------------------------------------
// Emplacements (stock_locations)
// ---------------------------------------------------------------------
const binSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9._-]{0,29}$/, 'Code : lettres, chiffres, . _ - (30 max)'),
  name: txt(80).optional().transform((v) => v ?? null),
  kind: z.enum(['storage', 'receiving', 'shipping', 'quarantine']),
  zone_id: z.string().trim().transform((v) => (v === '' ? null : v)).pipe(z.uuid('Zone invalide').nullable()),
})

export async function saveBinAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const wid = uuid.safeParse(fd.get('warehouse_id'))
  if (!wid.success) return { ok: false, message: 'Entrepôt invalide.' }
  const auth = await authorize(P.STOCK_READ)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const parsed = binSchema.safeParse(Object.fromEntries(fd.entries()))
  if (!parsed.success) return invalid(parsed.error, values)
  const supabase = await createClient()
  const id = String(fd.get('id') ?? '')
  const { error } = id && uuid.safeParse(id).success
    ? await supabase.from('stock_locations').update({ name: parsed.data.name, kind: parsed.data.kind, zone_id: parsed.data.zone_id }).eq('id', id)
    : await supabase.from('stock_locations').insert({ warehouse_id: wid.data, ...parsed.data })
  if (error) return dbFail(auth.ctx, P.STOCK_READ, error, values)
  rev(wid.data)
  return { ok: true, message: id ? 'Emplacement mis à jour.' : 'Emplacement créé.' }
}

// ---------------------------------------------------------------------
// Accès utilisateurs
// ---------------------------------------------------------------------
export async function assignUserAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const wid = uuid.safeParse(fd.get('warehouse_id'))
  const uid = uuid.safeParse(fd.get('user_id'))
  if (!wid.success || !uid.success) return { ok: false, message: 'Choisissez un utilisateur.' }
  const role = z.enum(['viewer', 'operator', 'manager']).safeParse(fd.get('role'))
  if (!role.success) return { ok: false, message: 'Choisissez un rôle.' }
  const auth = await authorize(P.STOCK_READ)
  if ('error' in auth) return auth.error
  const supabase = await createClient()
  const { error } = await supabase.rpc('wh_assign_user', { p_user: uid.data, p_warehouse: wid.data, p_role: role.data })
  if (error) return dbFail(auth.ctx, P.STOCK_READ, error)
  rev(wid.data)
  return { ok: true, message: 'Accès accordé.' }
}

export async function revokeUserAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const wid = uuid.safeParse(fd.get('warehouse_id'))
  const uid = uuid.safeParse(fd.get('user_id'))
  if (!wid.success || !uid.success) return { ok: false, message: 'Identifiant invalide.' }
  const auth = await authorize(P.STOCK_READ)
  if ('error' in auth) return auth.error
  const supabase = await createClient()
  const { error } = await supabase.rpc('wh_revoke_user', { p_user: uid.data, p_warehouse: wid.data })
  if (error) return dbFail(auth.ctx, P.STOCK_READ, error)
  rev(wid.data)
  return { ok: true, message: 'Accès retiré.' }
}
