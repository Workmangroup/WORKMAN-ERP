'use server'

import { randomUUID } from 'node:crypto'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'
import { extensionOf, fileTypeOf, matchesMagic, safeFileName } from '@/lib/ged/constants'
import { getAuthContext } from '@/features/auth/services/access.service'
import type { AuthContextValue, FormState } from '@/features/auth/types'
import { logAccessDenied } from '@/features/rbac/services/audit-write.service'
import { removeFiles } from '@/features/ged/services/storage.service'
import { PHOTO_VIEWS } from '@/lib/products/options'
import { isPermissionError, productErrorMessage } from './errors'
import { certSchema, docKindSchema, productEditSchema, productSchema, specSchema } from './schemas'

/** Écritures via la session de l'utilisateur : RLS et RPC (products.*) font autorité. */

const BUCKET = 'product-photos'
const MAX_PHOTO = 8 * 1024 * 1024
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
  return { ok: false, message: productErrorMessage(err), values }
}
const raw = (fd: FormData): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [k, v] of fd.entries()) if (typeof v === 'string' && !k.startsWith('$ACTION')) out[k] = v
  return out
}
const obj = (fd: FormData) => Object.fromEntries([...fd.entries()].filter(([k, v]) => typeof v === 'string' && !k.startsWith('$ACTION')))
const invalid = (error: z.ZodError, values: Record<string, string>): FormState => ({
  ok: false, message: 'Veuillez corriger les champs en erreur.', fieldErrors: z.flattenError(error).fieldErrors as Record<string, string[] | undefined>, values,
})
const refresh = (id: string) => revalidatePath(`/products/${id}`, 'layout')

// ---------------------------------------------------------------------
// Produit : création, modification, duplication, archivage, suppression
// ---------------------------------------------------------------------
export async function createProductAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.PRODUCTS_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const parsed = productSchema.safeParse(obj(fd))
  if (!parsed.success) return invalid(parsed.error, values)
  const supabase = await createClient()
  const { data, error } = await supabase.from('product_master').insert(parsed.data).select('id').single()
  if (error) return dbFail(auth.ctx, P.PRODUCTS_WRITE, error, values)
  revalidatePath('/products')
  redirect(`/products/${data.id}?created=1`)
}

export async function updateProductAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.PRODUCTS_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const id = uuid.safeParse(fd.get('id'))
  if (!id.success) return { ok: false, message: 'Identifiant invalide.', values }
  const parsed = productEditSchema.safeParse(obj(fd))
  if (!parsed.success) return invalid(parsed.error, values)
  const supabase = await createClient()
  const { data, error } = await supabase.from('product_master').update(parsed.data).eq('id', id.data).select('id')
  if (error) return dbFail(auth.ctx, P.PRODUCTS_WRITE, error, values)
  if (!data?.length) return { ok: false, message: 'Produit introuvable ou modification non autorisée.', values }
  revalidatePath('/products', 'layout')
  redirect(`/products/${id.data}?updated=1`)
}

export async function duplicateProductAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.PRODUCTS_WRITE)
  if ('error' in auth) return auth.error
  const id = uuid.safeParse(fd.get('id'))
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  const name = String(fd.get('name') ?? '').trim().slice(0, 160)
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('product_duplicate', { p_product: id.data, p_name: name || null })
  if (error) return dbFail(auth.ctx, P.PRODUCTS_WRITE, error)
  revalidatePath('/products')
  redirect(`/products/${data}?duplicated=1`)
}

export async function archiveProductAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.PRODUCTS_ARCHIVE)
  if ('error' in auth) return auth.error
  const id = uuid.safeParse(fd.get('id'))
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  const supabase = await createClient()
  const { error } = await supabase.rpc('product_archive', { p_product: id.data, p_reason: String(fd.get('reason') ?? '').trim().slice(0, 300) || null })
  if (error) return dbFail(auth.ctx, P.PRODUCTS_ARCHIVE, error)
  revalidatePath('/products', 'layout')
  redirect(`/products/${id.data}?archived=1`)
}

export async function restoreProductAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.PRODUCTS_ARCHIVE)
  if ('error' in auth) return auth.error
  const id = uuid.safeParse(fd.get('id'))
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  const supabase = await createClient()
  const { error } = await supabase.rpc('product_restore', { p_product: id.data })
  if (error) return dbFail(auth.ctx, P.PRODUCTS_ARCHIVE, error)
  revalidatePath('/products', 'layout')
  return { ok: true, message: 'Produit restauré.' }
}

export async function deleteProductAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.PRODUCTS_WRITE)
  if ('error' in auth) return auth.error
  const id = uuid.safeParse(fd.get('id'))
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  if (String(fd.get('confirm') ?? '').trim().toUpperCase() !== 'SUPPRIMER') return { ok: false, message: 'Saisissez « SUPPRIMER » pour confirmer.' }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('product_delete', { p_product: id.data })
  if (error) return dbFail(auth.ctx, P.PRODUCTS_WRITE, error)
  await removeFiles((data as { bucket: string; path: string }[]) ?? [])
  revalidatePath('/products')
  redirect('/products?deleted=1')
}

// ---------------------------------------------------------------------
// Fiche technique et versions
// ---------------------------------------------------------------------
export async function saveSpecAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.PRODUCTS_WRITE)
  if ('error' in auth) return auth.error
  const versionId = uuid.safeParse(fd.get('version_id'))
  const productId = uuid.safeParse(fd.get('product_id'))
  if (!versionId.success || !productId.success) return { ok: false, message: 'Données invalides.' }
  let json: unknown
  try { json = JSON.parse(String(fd.get('spec') ?? '')) } catch { return { ok: false, message: 'Fiche illisible.' } }
  const parsed = specSchema.safeParse(json)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return { ok: false, message: `${first.message}${first.path.length ? ` (${first.path.join(' › ')})` : ''}` }
  }
  const note = String(fd.get('change_note') ?? '').trim().slice(0, 500)
  const supabase = await createClient()
  const { data, error } = await supabase.from('product_versions').update({ spec: parsed.data, change_note: note || null }).eq('id', versionId.data).select('id')
  if (error) return dbFail(auth.ctx, P.PRODUCTS_WRITE, error)
  if (!data?.length) return { ok: false, message: productErrorMessage({ message: 'PRODUCT_VERSION_LOCKED' }) }
  refresh(productId.data)
  return { ok: true, message: 'Fiche enregistrée.' }
}

export async function newVersionAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.PRODUCTS_WRITE)
  if ('error' in auth) return auth.error
  const id = uuid.safeParse(fd.get('product_id'))
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  const note = String(fd.get('note') ?? '').trim().slice(0, 500)
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('product_new_version', { p_product: id.data, p_note: note || null })
  if (error) return dbFail(auth.ctx, P.PRODUCTS_WRITE, error)
  refresh(id.data)
  redirect(`/products/${id.data}/spec?v=${data}`)
}

export async function validateVersionAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.PRODUCTS_VALIDATE)
  if ('error' in auth) return auth.error
  const vid = uuid.safeParse(fd.get('version_id'))
  const pid = uuid.safeParse(fd.get('product_id'))
  if (!vid.success || !pid.success) return { ok: false, message: 'Identifiant invalide.' }
  const supabase = await createClient()
  const { error } = await supabase.rpc('product_validate_version', { p_version: vid.data, p_comment: String(fd.get('comment') ?? '').trim().slice(0, 500) || null })
  if (error) return dbFail(auth.ctx, P.PRODUCTS_VALIDATE, error)
  refresh(pid.data)
  redirect(`/products/${pid.data}?tab=versions&validated=1`)
}

export async function discardDraftAction(fd: FormData): Promise<void> {
  const auth = await authorize(P.PRODUCTS_WRITE)
  if ('error' in auth) return
  const vid = uuid.safeParse(fd.get('version_id'))
  const pid = uuid.safeParse(fd.get('product_id'))
  if (!vid.success || !pid.success) return
  const supabase = await createClient()
  await supabase.rpc('product_discard_draft', { p_version: vid.data })
  refresh(pid.data)
  redirect(`/products/${pid.data}?tab=versions`)
}

// ---------------------------------------------------------------------
// Photos (Storage privé `product-photos`)
// ---------------------------------------------------------------------
export async function uploadPhotoAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.PRODUCTS_WRITE)
  if ('error' in auth) return auth.error
  const pid = uuid.safeParse(fd.get('product_id'))
  const cid = uuid.safeParse(fd.get('client_id'))
  if (!pid.success || !cid.success) return { ok: false, message: 'Données invalides.' }
  const view = String(fd.get('view') ?? 'front')
  const caption = String(fd.get('caption') ?? '').trim().slice(0, 200)
  const color = String(fd.get('color') ?? '').trim().slice(0, 60)

  const files = fd.getAll('file').filter((f): f is File => f instanceof File && f.size > 0)
  if (files.length === 0) return { ok: false, message: 'Sélectionnez au moins une image.' }
  const supabase = await createClient()
  let added = 0
  const errors: string[] = []
  for (const file of files.slice(0, 10)) {
    const ft = fileTypeOf(file.name)
    if (!ft || ft.kind !== 'image') { errors.push(`${file.name} : seules les images JPG, PNG ou WebP sont acceptées`); continue }
    if (file.size > MAX_PHOTO) { errors.push(`${file.name} : plus de 8 Mo`); continue }
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (!matchesMagic(extensionOf(file.name), bytes)) { errors.push(`${file.name} : le contenu ne correspond pas à une image`); continue }

    const path = `${auth.ctx.profile.company_id}/${cid.data}/${pid.data}/${randomUUID()}-${safeFileName(file.name)}`
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, bytes, { contentType: ft.mime, upsert: false })
    if (upErr) { errors.push(`${file.name} : envoi refusé`); continue }
    const { error } = await supabase.from('product_photos').insert({
      product_id: pid.data, storage_path: path, file_name: file.name.slice(0, 200), mime_type: ft.mime, size_bytes: file.size,
      view: PHOTO_VIEWS.some((v) => v.value === view) ? view : 'front', color: color || null, caption: caption || null,
    })
    if (error) { await removeFiles([{ bucket: BUCKET, path }]); errors.push(`${file.name} : ${productErrorMessage(error)}`); continue }
    added++
  }
  refresh(pid.data)
  if (added === 0) return { ok: false, message: errors[0] ?? 'Aucune photo ajoutée.' }
  return { ok: true, message: `${added} photo(s) ajoutée(s).${errors.length ? ` Ignorées : ${errors.join(' ; ')}` : ''}` }
}

export async function setMainPhotoAction(fd: FormData): Promise<void> {
  const auth = await authorize(P.PRODUCTS_WRITE)
  if ('error' in auth) return
  const id = uuid.safeParse(fd.get('id'))
  const pid = uuid.safeParse(fd.get('product_id'))
  if (!id.success || !pid.success) return
  const supabase = await createClient()
  await supabase.from('product_photos').update({ is_main: true }).eq('id', id.data).eq('product_id', pid.data)
  refresh(pid.data)
}

export async function deletePhotoAction(fd: FormData): Promise<void> {
  const auth = await authorize(P.PRODUCTS_WRITE)
  if ('error' in auth) return
  const id = uuid.safeParse(fd.get('id'))
  const pid = uuid.safeParse(fd.get('product_id'))
  if (!id.success || !pid.success) return
  const supabase = await createClient()
  const { data: photo } = await supabase.from('product_photos').select('storage_path').eq('id', id.data).eq('product_id', pid.data).maybeSingle()
  if (!photo) return
  const { data: gone, error } = await supabase.from('product_photos').delete().eq('id', id.data).select('id')
  if (!error && gone?.length) await removeFiles([{ bucket: BUCKET, path: photo.storage_path as string }])
  refresh(pid.data)
}

// ---------------------------------------------------------------------
// Documents GED (patronages, fiches, rapports d'essai…)
// ---------------------------------------------------------------------
export async function linkDocumentsAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.PRODUCTS_WRITE)
  if ('error' in auth) return auth.error
  const pid = uuid.safeParse(fd.get('product_id'))
  const kind = docKindSchema.safeParse(fd.get('kind'))
  const ids = z.array(uuid).max(100).safeParse(fd.getAll('doc').map(String))
  if (!pid.success || !kind.success || !ids.success || ids.data.length === 0) return { ok: false, message: 'Sélectionnez au moins un document.' }
  const revision = String(fd.get('revision') ?? '').trim().slice(0, 30) || null
  const supabase = await createClient()
  const { data, error } = await supabase.from('product_documents').insert(ids.data.map((d) => ({ product_id: pid.data, ged_document_id: d, kind: kind.data, revision }))).select('id')
  if (error) return dbFail(auth.ctx, P.PRODUCTS_WRITE, error)
  refresh(pid.data)
  return { ok: true, message: `${data?.length ?? 0} document(s) rattaché(s).` }
}

export async function updateDocumentAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.PRODUCTS_WRITE)
  if ('error' in auth) return auth.error
  const id = uuid.safeParse(fd.get('id'))
  const pid = uuid.safeParse(fd.get('product_id'))
  const kind = docKindSchema.safeParse(fd.get('kind'))
  if (!id.success || !pid.success || !kind.success) return { ok: false, message: 'Données invalides.' }
  const supabase = await createClient()
  const { data, error } = await supabase.from('product_documents').update({
    kind: kind.data, revision: String(fd.get('revision') ?? '').trim().slice(0, 30) || null, note: String(fd.get('note') ?? '').trim().slice(0, 300) || null,
  }).eq('id', id.data).select('id')
  if (error) return dbFail(auth.ctx, P.PRODUCTS_WRITE, error)
  if (!data?.length) return { ok: false, message: 'Modification non autorisée.' }
  refresh(pid.data)
  return { ok: true, message: 'Document mis à jour.' }
}

export async function unlinkDocumentAction(fd: FormData): Promise<void> {
  const auth = await authorize(P.PRODUCTS_WRITE)
  if ('error' in auth) return
  const id = uuid.safeParse(fd.get('id'))
  const pid = uuid.safeParse(fd.get('product_id'))
  if (!id.success || !pid.success) return
  const supabase = await createClient()
  await supabase.from('product_documents').delete().eq('id', id.data).eq('product_id', pid.data)
  refresh(pid.data)
}

// ---------------------------------------------------------------------
// Certifications
// ---------------------------------------------------------------------
export async function saveCertAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.PRODUCTS_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const pid = uuid.safeParse(fd.get('product_id'))
  if (!pid.success) return { ok: false, message: 'Données invalides.', values }
  const parsed = certSchema.safeParse(obj(fd))
  if (!parsed.success) return invalid(parsed.error, values)
  const cid = String(fd.get('id') ?? '')
  const supabase = await createClient()
  if (cid) {
    if (!uuid.safeParse(cid).success) return { ok: false, message: 'Identifiant invalide.', values }
    const { data, error } = await supabase.from('product_certifications').update(parsed.data).eq('id', cid).eq('product_id', pid.data).select('id')
    if (error) return dbFail(auth.ctx, P.PRODUCTS_WRITE, error, values)
    if (!data?.length) return { ok: false, message: 'Modification non autorisée.', values }
  } else {
    const { error } = await supabase.from('product_certifications').insert({ ...parsed.data, product_id: pid.data })
    if (error) return dbFail(auth.ctx, P.PRODUCTS_WRITE, error, values)
  }
  refresh(pid.data)
  return { ok: true, message: cid ? 'Certification mise à jour.' : 'Certification ajoutée.' }
}

export async function deleteCertAction(fd: FormData): Promise<void> {
  const auth = await authorize(P.PRODUCTS_WRITE)
  if ('error' in auth) return
  const id = uuid.safeParse(fd.get('id'))
  const pid = uuid.safeParse(fd.get('product_id'))
  if (!id.success || !pid.success) return
  const supabase = await createClient()
  await supabase.from('product_certifications').delete().eq('id', id.data).eq('product_id', pid.data)
  refresh(pid.data)
}

/** Étapes du dossier : prototype, demande de revue (rédacteur) ; rejet motivé (approbateur). L'approbation reste validateVersionAction. */
export async function versionStepAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const step = String(fd.get('step') ?? '')
  const vid = uuid.safeParse(fd.get('version_id'))
  const pid = uuid.safeParse(fd.get('product_id'))
  if (!vid.success || !pid.success) return { ok: false, message: 'Identifiant invalide.' }
  const auth = await authorize(step === 'reject' ? P.PRODUCTS_VALIDATE : P.PRODUCTS_WRITE)
  if ('error' in auth) return auth.error
  const supabase = await createClient()
  const note = String(fd.get('note') ?? '').trim().slice(0, 500) || null
  let error: { message?: string; code?: string } | null = null
  if (step === 'prototype') ({ error } = await supabase.rpc('product_version_prototype', { p_version: vid.data }))
  else if (step === 'review') ({ error } = await supabase.rpc('product_version_submit_review', { p_version: vid.data, p_note: note }))
  else if (step === 'reject') ({ error } = await supabase.rpc('product_version_reject', { p_version: vid.data, p_reason: note ?? '' }))
  else return { ok: false, message: 'Étape inconnue.' }
  if (error) return dbFail(auth.ctx, step === 'reject' ? P.PRODUCTS_VALIDATE : P.PRODUCTS_WRITE, error)
  refresh(pid.data)
  return { ok: true, message: step === 'prototype' ? 'Version passée en prototype.' : step === 'review' ? 'Demande de revue envoyée.' : 'Version rejetée : retour en brouillon.' }
}
