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
import { articleErrorMessage, isPermissionError } from './errors'
import { articleEditSchema, articleSchema, specSchema } from './schemas'

/** Écritures via la session de l'utilisateur : RLS et RPC (articles.*) font autorité. */

const BUCKET = 'article-photos'
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
  return { ok: false, message: articleErrorMessage(err), values }
}
const raw = (fd: FormData): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [k, v] of fd.entries()) if (typeof v === 'string' && !k.startsWith('$ACTION')) out[k] = v
  return out
}
const obj = (fd: FormData) => Object.fromEntries([...fd.entries()].filter(([k, v]) => typeof v === 'string' && !k.startsWith('$ACTION')))

// ---------------------------------------------------------------------
// Article
// ---------------------------------------------------------------------
export async function createArticleAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.ARTICLES_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const parsed = articleSchema.safeParse(obj(fd))
  if (!parsed.success) return { ok: false, message: 'Veuillez corriger les champs en erreur.', fieldErrors: z.flattenError(parsed.error).fieldErrors, values }
  const supabase = await createClient()
  const { data, error } = await supabase.from('articles').insert(parsed.data).select('id').single()
  if (error) return dbFail(auth.ctx, P.ARTICLES_WRITE, error, values)
  revalidatePath('/articles')
  redirect(`/articles/${data.id}?created=1`)
}

export async function updateArticleAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.ARTICLES_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const id = uuid.safeParse(fd.get('id'))
  if (!id.success) return { ok: false, message: 'Identifiant invalide.', values }
  const parsed = articleEditSchema.safeParse(obj(fd))
  if (!parsed.success) return { ok: false, message: 'Veuillez corriger les champs en erreur.', fieldErrors: z.flattenError(parsed.error).fieldErrors, values }
  const supabase = await createClient()
  const { data, error } = await supabase.from('articles').update(parsed.data).eq('id', id.data).select('id')
  if (error) return dbFail(auth.ctx, P.ARTICLES_WRITE, error, values)
  if (!data?.length) return { ok: false, message: 'Article introuvable ou modification non autorisée.', values }
  revalidatePath('/articles', 'layout')
  redirect(`/articles/${id.data}?updated=1`)
}

export async function deleteArticleAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.ARTICLES_WRITE)
  if ('error' in auth) return auth.error
  const id = uuid.safeParse(fd.get('id'))
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  if (String(fd.get('confirm') ?? '').trim().toUpperCase() !== 'SUPPRIMER') return { ok: false, message: 'Saisissez « SUPPRIMER » pour confirmer.' }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('article_delete', { p_article: id.data })
  if (error) return dbFail(auth.ctx, P.ARTICLES_WRITE, error)
  await removeFiles((data as { bucket: string; path: string }[]) ?? [])
  revalidatePath('/articles')
  redirect('/articles?deleted=1')
}

// ---------------------------------------------------------------------
// Fiche (couleurs, tailles, normes, packaging, lavage) et versions
// ---------------------------------------------------------------------
export async function saveSpecAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.ARTICLES_WRITE)
  if ('error' in auth) return auth.error
  const versionId = uuid.safeParse(fd.get('version_id'))
  const articleId = uuid.safeParse(fd.get('article_id'))
  if (!versionId.success || !articleId.success) return { ok: false, message: 'Données invalides.' }
  let json: unknown
  try { json = JSON.parse(String(fd.get('spec') ?? '')) } catch { return { ok: false, message: 'Fiche illisible.' } }
  const parsed = specSchema.safeParse(json)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return { ok: false, message: `${first.message}${first.path.length ? ` (${first.path.join(' › ')})` : ''}` }
  }
  const note = String(fd.get('change_note') ?? '').trim().slice(0, 500)
  const supabase = await createClient()
  const { data, error } = await supabase.from('article_versions').update({ spec: parsed.data, change_note: note || null }).eq('id', versionId.data).select('id')
  if (error) return dbFail(auth.ctx, P.ARTICLES_WRITE, error)
  if (!data?.length) return { ok: false, message: articleErrorMessage({ message: 'ARTICLE_VERSION_LOCKED' }) }
  revalidatePath(`/articles/${articleId.data}`, 'layout')
  return { ok: true, message: 'Fiche enregistrée.' }
}

export async function newVersionAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.ARTICLES_WRITE)
  if ('error' in auth) return auth.error
  const id = uuid.safeParse(fd.get('article_id'))
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  const note = String(fd.get('note') ?? '').trim().slice(0, 500)
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('article_new_version', { p_article: id.data, p_note: note || null })
  if (error) return dbFail(auth.ctx, P.ARTICLES_WRITE, error)
  revalidatePath(`/articles/${id.data}`, 'layout')
  redirect(`/articles/${id.data}/spec?v=${data}`)
}

export async function validateVersionAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.ARTICLES_VALIDATE)
  if ('error' in auth) return auth.error
  const vid = uuid.safeParse(fd.get('version_id'))
  const aid = uuid.safeParse(fd.get('article_id'))
  if (!vid.success || !aid.success) return { ok: false, message: 'Identifiant invalide.' }
  const supabase = await createClient()
  const { error } = await supabase.rpc('article_validate_version', { p_version: vid.data, p_comment: String(fd.get('comment') ?? '').trim().slice(0, 500) || null })
  if (error) return dbFail(auth.ctx, P.ARTICLES_VALIDATE, error)
  revalidatePath(`/articles/${aid.data}`, 'layout')
  redirect(`/articles/${aid.data}?tab=versions&validated=1`)
}

export async function discardDraftAction(fd: FormData): Promise<void> {
  const auth = await authorize(P.ARTICLES_WRITE)
  if ('error' in auth) return
  const vid = uuid.safeParse(fd.get('version_id'))
  const aid = uuid.safeParse(fd.get('article_id'))
  if (!vid.success || !aid.success) return
  const supabase = await createClient()
  await supabase.rpc('article_discard_draft', { p_version: vid.data })
  revalidatePath(`/articles/${aid.data}`, 'layout')
  redirect(`/articles/${aid.data}?tab=versions`)
}

// ---------------------------------------------------------------------
// Photos (Storage privé `article-photos`)
// ---------------------------------------------------------------------
export async function uploadPhotoAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.ARTICLES_WRITE)
  if ('error' in auth) return auth.error
  const aid = uuid.safeParse(fd.get('article_id'))
  const cid = uuid.safeParse(fd.get('client_id'))
  if (!aid.success || !cid.success) return { ok: false, message: 'Données invalides.' }
  const view = String(fd.get('view') ?? 'front')
  const caption = String(fd.get('caption') ?? '').trim().slice(0, 200)

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

    const path = `${auth.ctx.profile.company_id}/${cid.data}/${aid.data}/${randomUUID()}-${safeFileName(file.name)}`
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, bytes, { contentType: ft.mime, upsert: false })
    if (upErr) { errors.push(`${file.name} : envoi refusé`); continue }
    const { error } = await supabase.from('article_photos').insert({
      article_id: aid.data, storage_path: path, file_name: file.name.slice(0, 200), mime_type: ft.mime, size_bytes: file.size,
      view: ['front', 'back', 'side', 'detail', 'label', 'packaging', 'other'].includes(view) ? view : 'front', caption: caption || null,
    })
    if (error) { await removeFiles([{ bucket: BUCKET, path }]); errors.push(`${file.name} : ${articleErrorMessage(error)}`); continue }
    added++
  }
  revalidatePath(`/articles/${aid.data}`, 'layout')
  if (added === 0) return { ok: false, message: errors[0] ?? 'Aucune photo ajoutée.' }
  return { ok: true, message: `${added} photo(s) ajoutée(s).${errors.length ? ` Ignorées : ${errors.join(' ; ')}` : ''}` }
}

export async function setMainPhotoAction(fd: FormData): Promise<void> {
  const auth = await authorize(P.ARTICLES_WRITE)
  if ('error' in auth) return
  const id = uuid.safeParse(fd.get('id'))
  const aid = uuid.safeParse(fd.get('article_id'))
  if (!id.success || !aid.success) return
  const supabase = await createClient()
  await supabase.from('article_photos').update({ is_main: true }).eq('id', id.data).eq('article_id', aid.data)
  revalidatePath(`/articles/${aid.data}`, 'layout')
}

export async function deletePhotoAction(fd: FormData): Promise<void> {
  const auth = await authorize(P.ARTICLES_WRITE)
  if ('error' in auth) return
  const id = uuid.safeParse(fd.get('id'))
  const aid = uuid.safeParse(fd.get('article_id'))
  if (!id.success || !aid.success) return
  const supabase = await createClient()
  const { data: photo } = await supabase.from('article_photos').select('storage_path').eq('id', id.data).eq('article_id', aid.data).maybeSingle()
  if (!photo) return
  const { error } = await supabase.from('article_photos').delete().eq('id', id.data)
  if (!error) await removeFiles([{ bucket: BUCKET, path: photo.storage_path as string }])
  revalidatePath(`/articles/${aid.data}`, 'layout')
}

// ---------------------------------------------------------------------
// Relation avec la GED : rattacher / détacher des documents
// ---------------------------------------------------------------------
export async function linkDocumentsAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.DOCUMENTS_WRITE)
  if ('error' in auth) return auth.error
  const aid = uuid.safeParse(fd.get('article_id'))
  const ids = z.array(uuid).max(100).safeParse(fd.getAll('doc').map(String))
  if (!aid.success || !ids.success || ids.data.length === 0) return { ok: false, message: 'Sélectionnez au moins un document.' }
  const supabase = await createClient()
  const { data, error } = await supabase.from('ged_documents').update({ article_id: aid.data }).in('id', ids.data).select('id')
  if (error) return dbFail(auth.ctx, P.DOCUMENTS_WRITE, error)
  revalidatePath(`/articles/${aid.data}`, 'layout')
  return { ok: true, message: `${data?.length ?? 0} document(s) rattaché(s).` }
}

export async function unlinkDocumentAction(fd: FormData): Promise<void> {
  const auth = await authorize(P.DOCUMENTS_WRITE)
  if ('error' in auth) return
  const id = uuid.safeParse(fd.get('id'))
  const aid = uuid.safeParse(fd.get('article_id'))
  if (!id.success || !aid.success) return
  const supabase = await createClient()
  await supabase.from('ged_documents').update({ article_id: null }).eq('id', id.data).eq('article_id', aid.data)
  revalidatePath(`/articles/${aid.data}`, 'layout')
}
