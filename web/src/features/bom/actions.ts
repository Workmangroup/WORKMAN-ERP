'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'
import { getAuthContext } from '@/features/auth/services/access.service'
import type { AuthContextValue, FormState } from '@/features/auth/types'
import { logAccessDenied } from '@/features/rbac/services/audit-write.service'
import { bomErrorMessage, isPermissionError } from './errors'
import { bomEditSchema, bomSchema, costingSchema, lineEditSchema, lineSchema, materialSchema, opEditSchema, opSchema } from './schemas'

/** Écritures via la session de l'utilisateur : RLS et RPC (bom.*) font autorité. */

const uuid = z.uuid()

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
  return { ok: false, message: bomErrorMessage(err), values }
}
const raw = (fd: FormData): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [k, v] of fd.entries()) if (typeof v === 'string' && !k.startsWith('$ACTION')) out[k] = v
  return out
}
const obj = (fd: FormData) => Object.fromEntries([...fd.entries()].filter(([k, v]) => typeof v === 'string' && !k.startsWith('$ACTION')))
const invalid = (error: z.ZodError, values: Record<string, string>): FormState => {
  const fe = z.flattenError(error).fieldErrors as Record<string, string[] | undefined>
  const first = Object.values(fe).flat().find(Boolean)
  return { ok: false, message: first ?? 'Veuillez corriger les champs en erreur.', fieldErrors: fe, values }
}
const revalidateBom = (bomId: string) => { revalidatePath('/bom'); revalidatePath(`/bom/${bomId}`, 'layout') }

// ---------------------------------------------------------------------
// Composants (catalogue) et prix
// ---------------------------------------------------------------------
export async function saveMaterialAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.BOM_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const idRaw = String(fd.get('id') ?? '')
  const id = idRaw ? uuid.safeParse(idRaw) : null
  if (id && !id.success) return { ok: false, message: 'Identifiant invalide.', values }
  const parsed = materialSchema.safeParse(obj(fd))
  if (!parsed.success) return invalid(parsed.error, values)
  const { unit_cost, ...fields } = parsed.data
  const canPrice = auth.ctx.permissions.includes(P.COSTS_READ)

  const supabase = await createClient()
  let materialId = id?.data
  if (materialId) {
    const { data, error } = await supabase.from('bom_materials').update(fields).eq('id', materialId).select('id')
    if (error) return dbFail(auth.ctx, P.BOM_WRITE, error, values)
    if (!data?.length) return { ok: false, message: 'Composant introuvable ou modification non autorisée.', values }
  } else {
    const { data, error } = await supabase.from('bom_materials').insert(fields).select('id').single()
    if (error) return dbFail(auth.ctx, P.BOM_WRITE, error, values)
    materialId = data.id as string
  }
  if (canPrice && unit_cost !== null) {
    const { error } = await supabase.from('bom_material_prices').upsert({ material_id: materialId, unit_cost }, { onConflict: 'material_id' })
    if (error) return dbFail(auth.ctx, P.COSTS_READ, error, values)
  }
  revalidatePath('/bom', 'layout')
  return { ok: true, message: id ? 'Composant enregistré.' : 'Composant créé.' }
}

export async function archiveMaterialAction(fd: FormData): Promise<void> {
  const auth = await authorize(P.BOM_WRITE)
  if ('error' in auth) return
  const id = uuid.safeParse(fd.get('id'))
  if (!id.success) return
  const supabase = await createClient()
  await supabase.rpc('bom_material_archive', { p_material: id.data, p_archive: fd.get('archive') === '1' })
  revalidatePath('/bom', 'layout')
}

export async function deleteMaterialAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.BOM_WRITE)
  if ('error' in auth) return auth.error
  const id = uuid.safeParse(fd.get('id'))
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  const supabase = await createClient()
  const { error } = await supabase.rpc('bom_material_delete', { p_material: id.data })
  if (error) return dbFail(auth.ctx, P.BOM_WRITE, error)
  revalidatePath('/bom', 'layout')
  return { ok: true, message: 'Composant supprimé.' }
}

// ---------------------------------------------------------------------
// Nomenclature
// ---------------------------------------------------------------------
export async function createBomAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.BOM_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const parsed = bomSchema.safeParse(obj(fd))
  if (!parsed.success) return invalid(parsed.error, values)
  const data = parsed.data.kind === 'subassembly' ? { ...parsed.data, article_id: null } : parsed.data
  const supabase = await createClient()
  const { data: row, error } = await supabase.from('boms').insert(data).select('id').single()
  if (error) return dbFail(auth.ctx, P.BOM_WRITE, error, values)
  revalidatePath('/bom')
  redirect(`/bom/${row.id}?tab=composition&created=1`)
}

export async function updateBomAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.BOM_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const id = uuid.safeParse(fd.get('id'))
  if (!id.success) return { ok: false, message: 'Identifiant invalide.', values }
  const parsed = bomEditSchema.safeParse(obj(fd))
  if (!parsed.success) return invalid(parsed.error, values)
  const supabase = await createClient()
  const { data, error } = await supabase.from('boms').update(parsed.data).eq('id', id.data).select('id')
  if (error) return dbFail(auth.ctx, P.BOM_WRITE, error, values)
  if (!data?.length) return { ok: false, message: 'Nomenclature introuvable ou modification non autorisée.', values }
  revalidateBom(id.data)
  redirect(`/bom/${id.data}?updated=1`)
}

export async function deleteBomAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.BOM_WRITE)
  if ('error' in auth) return auth.error
  const id = uuid.safeParse(fd.get('id'))
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  if (String(fd.get('confirm') ?? '').trim().toUpperCase() !== 'SUPPRIMER') return { ok: false, message: 'Saisissez « SUPPRIMER » pour confirmer.' }
  const supabase = await createClient()
  const { error } = await supabase.rpc('bom_delete', { p_bom: id.data })
  if (error) return dbFail(auth.ctx, P.BOM_WRITE, error)
  revalidatePath('/bom')
  redirect('/bom?deleted=1')
}

export async function archiveBomAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.BOM_WRITE)
  if ('error' in auth) return auth.error
  const id = uuid.safeParse(fd.get('id'))
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  const supabase = await createClient()
  const { error } = await supabase.rpc('bom_archive', { p_bom: id.data, p_reason: String(fd.get('reason') ?? '').trim().slice(0, 300) || null })
  if (error) return dbFail(auth.ctx, P.BOM_WRITE, error)
  revalidateBom(id.data)
  redirect(`/bom/${id.data}?archived=1`)
}

export async function restoreBomAction(fd: FormData): Promise<void> {
  const auth = await authorize(P.BOM_WRITE)
  if ('error' in auth) return
  const id = uuid.safeParse(fd.get('id'))
  if (!id.success) return
  const supabase = await createClient()
  const { error } = await supabase.rpc('bom_restore', { p_bom: id.data })
  revalidateBom(id.data)
  redirect(`/bom/${id.data}?${error ? 'restore_failed=1' : 'restored=1'}`)
}

export async function duplicateBomAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.BOM_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const id = uuid.safeParse(fd.get('id'))
  if (!id.success) return { ok: false, message: 'Identifiant invalide.', values }
  const name = String(fd.get('name') ?? '').trim()
  if (name.length < 2) return { ok: false, message: 'Nom requis (2 caractères minimum).', fieldErrors: { name: ['Nom requis (2 caractères minimum)'] }, values }
  const article = String(fd.get('article_id') ?? '')
  const version = String(fd.get('version_id') ?? '')
  if (article && !uuid.safeParse(article).success) return { ok: false, message: 'Article invalide.', values }
  if (version && !uuid.safeParse(version).success) return { ok: false, message: 'Version invalide.', values }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('bom_duplicate', { p_bom: id.data, p_name: name, p_article: article || null, p_version: version || null })
  if (error) return dbFail(auth.ctx, P.BOM_WRITE, error, values)
  revalidatePath('/bom')
  redirect(`/bom/${data}?tab=composition&duplicated=1`)
}

// ---------------------------------------------------------------------
// Lignes, opérations, paramètres de coût (brouillon uniquement : verrou en base)
// ---------------------------------------------------------------------
export async function addLineAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.BOM_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const bomId = uuid.safeParse(fd.get('bom_id'))
  const parsed = lineSchema.safeParse(obj(fd))
  if (!bomId.success) return { ok: false, message: 'Identifiant invalide.', values }
  if (!parsed.success) return invalid(parsed.error, values)
  const m = /^([mb]):([0-9a-f-]{36})$/i.exec(parsed.data.component)
  if (!m || !uuid.safeParse(m[2]).success) return { ok: false, message: 'Composant invalide.', values }
  const isBom = m[1].toLowerCase() === 'b'
  const supabase = await createClient()
  const { error } = await supabase.from('bom_lines').insert({
    version_id: parsed.data.version_id,
    line_type: isBom ? 'bom' : 'material',
    material_id: isBom ? null : m[2],
    child_bom_id: isBom ? m[2] : null,
    quantity: parsed.data.quantity,
    waste_pct: isBom ? 0 : (parsed.data.waste_pct ?? 0),
    note: parsed.data.note,
  })
  if (error) return dbFail(auth.ctx, P.BOM_WRITE, error, values)
  revalidateBom(bomId.data)
  return { ok: true, message: 'Ligne ajoutée.' }
}

export async function updateLineAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.BOM_WRITE)
  if ('error' in auth) return auth.error
  const bomId = uuid.safeParse(fd.get('bom_id'))
  const parsed = lineEditSchema.safeParse(obj(fd))
  if (!bomId.success) return { ok: false, message: 'Identifiant invalide.' }
  if (!parsed.success) return invalid(parsed.error, raw(fd))
  const supabase = await createClient()
  const { data, error } = await supabase.from('bom_lines').update({ quantity: parsed.data.quantity, waste_pct: parsed.data.waste_pct ?? 0, note: parsed.data.note }).eq('id', parsed.data.id).select('id')
  if (error) return dbFail(auth.ctx, P.BOM_WRITE, error)
  if (!data?.length) return { ok: false, message: 'Ligne introuvable ou modification non autorisée.' }
  revalidateBom(bomId.data)
  return { ok: true, message: 'Ligne enregistrée.' }
}

export async function deleteLineAction(fd: FormData): Promise<void> {
  const auth = await authorize(P.BOM_WRITE)
  if ('error' in auth) return
  const id = uuid.safeParse(fd.get('id'))
  const bomId = uuid.safeParse(fd.get('bom_id'))
  if (!id.success || !bomId.success) return
  const supabase = await createClient()
  await supabase.from('bom_lines').delete().eq('id', id.data)
  revalidateBom(bomId.data)
}

export async function addOperationAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.BOM_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const bomId = uuid.safeParse(fd.get('bom_id'))
  const parsed = opSchema.safeParse(obj(fd))
  if (!bomId.success) return { ok: false, message: 'Identifiant invalide.', values }
  if (!parsed.success) return invalid(parsed.error, values)
  const supabase = await createClient()
  const { error } = await supabase.from('bom_operations').insert(parsed.data)
  if (error) return dbFail(auth.ctx, P.BOM_WRITE, error, values)
  revalidateBom(bomId.data)
  return { ok: true, message: 'Opération ajoutée.' }
}

export async function updateOperationAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.BOM_WRITE)
  if ('error' in auth) return auth.error
  const bomId = uuid.safeParse(fd.get('bom_id'))
  const parsed = opEditSchema.safeParse(obj(fd))
  if (!bomId.success) return { ok: false, message: 'Identifiant invalide.' }
  if (!parsed.success) return invalid(parsed.error, raw(fd))
  const supabase = await createClient()
  const { data, error } = await supabase.from('bom_operations').update({ name: parsed.data.name, minutes: parsed.data.minutes }).eq('id', parsed.data.id).select('id')
  if (error) return dbFail(auth.ctx, P.BOM_WRITE, error)
  if (!data?.length) return { ok: false, message: 'Opération introuvable ou modification non autorisée.' }
  revalidateBom(bomId.data)
  return { ok: true, message: 'Opération enregistrée.' }
}

export async function deleteOperationAction(fd: FormData): Promise<void> {
  const auth = await authorize(P.BOM_WRITE)
  if ('error' in auth) return
  const id = uuid.safeParse(fd.get('id'))
  const bomId = uuid.safeParse(fd.get('bom_id'))
  if (!id.success || !bomId.success) return
  const supabase = await createClient()
  await supabase.from('bom_operations').delete().eq('id', id.data)
  revalidateBom(bomId.data)
}

export async function saveCostingAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.BOM_WRITE, P.COSTS_READ)
  if ('error' in auth) return auth.error
  const bomId = uuid.safeParse(fd.get('bom_id'))
  const parsed = costingSchema.safeParse(obj(fd))
  if (!bomId.success) return { ok: false, message: 'Identifiant invalide.' }
  if (!parsed.success) return invalid(parsed.error, raw(fd))
  const supabase = await createClient()
  const { data, error } = await supabase.from('bom_version_costs').update({ hourly_rate: parsed.data.hourly_rate, overhead_pct: parsed.data.overhead_pct }).eq('version_id', parsed.data.version_id).select('version_id')
  if (error) return dbFail(auth.ctx, P.BOM_WRITE, error)
  if (!data?.length) return { ok: false, message: 'Version introuvable ou modification non autorisée.' }
  revalidateBom(bomId.data)
  return { ok: true, message: 'Paramètres de coût enregistrés.' }
}

// ---------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------
export async function newVersionAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.BOM_WRITE)
  if ('error' in auth) return auth.error
  const id = uuid.safeParse(fd.get('bom_id'))
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('bom_new_version', { p_bom: id.data, p_note: String(fd.get('note') ?? '').trim().slice(0, 500) || null })
  if (error) return dbFail(auth.ctx, P.BOM_WRITE, error)
  revalidateBom(id.data)
  redirect(`/bom/${id.data}?tab=composition&v=${data}`)
}

export async function validateVersionAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.BOM_VALIDATE)
  if ('error' in auth) return auth.error
  const vid = uuid.safeParse(fd.get('version_id'))
  const bid = uuid.safeParse(fd.get('bom_id'))
  if (!vid.success || !bid.success) return { ok: false, message: 'Identifiant invalide.' }
  const supabase = await createClient()
  const { error } = await supabase.rpc('bom_validate_version', { p_version: vid.data, p_comment: String(fd.get('comment') ?? '').trim().slice(0, 500) || null })
  if (error) return dbFail(auth.ctx, P.BOM_VALIDATE, error)
  revalidateBom(bid.data)
  redirect(`/bom/${bid.data}?tab=versions&validated=1`)
}

export async function discardDraftAction(fd: FormData): Promise<void> {
  const auth = await authorize(P.BOM_WRITE)
  if ('error' in auth) return
  const vid = uuid.safeParse(fd.get('version_id'))
  const bid = uuid.safeParse(fd.get('bom_id'))
  if (!vid.success || !bid.success) return
  const supabase = await createClient()
  await supabase.rpc('bom_discard_draft', { p_version: vid.data })
  revalidateBom(bid.data)
  redirect(`/bom/${bid.data}?tab=versions`)
}
