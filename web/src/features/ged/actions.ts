'use server'

import { randomUUID } from 'node:crypto'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'
import { GED_BUCKET, MAX_FILE_BYTES, extensionOf, fileTypeOf, safeFileName } from '@/lib/ged/constants'
import { getAuthContext } from '@/features/auth/services/access.service'
import type { AuthContextValue, FormState } from '@/features/auth/types'
import { logAccessDenied } from '@/features/rbac/services/audit-write.service'
import { gedErrorMessage, isPermissionError } from './errors'
import { inspectUpload, removeFiles, type StoredFile } from './services/storage.service'

/**
 * Actions de la GED. La session de l'utilisateur est utilisée partout : RLS et RPC (documents.*) font autorité.
 * Le service_role n'intervient que pour effacer des fichiers du Storage après une suppression autorisée en base.
 */

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

async function dbFail(ctx: AuthContextValue, permission: string, err: { message?: string; code?: string; details?: string | null }): Promise<FormState> {
  if (isPermissionError(err)) await logAccessDenied(ctx, permission, { via: 'database' })
  return { ok: false, message: gedErrorMessage(err) }
}

const stem = (name: string) => name.replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[_]+/g, ' ').trim()

// ---------------------------------------------------------------------
// Téléversement direct vers Supabase Storage (URL signée) en deux temps
// ---------------------------------------------------------------------
const prepareSchema = z.object({
  mode: z.enum(['create', 'version']),
  clientId: uuid,
  folderId: uuid.optional(),
  documentId: uuid.optional(),
  fileName: z.string().min(1).max(200),
  size: z.number().int().positive().max(MAX_FILE_BYTES),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
})
export type PrepareInput = z.input<typeof prepareSchema>
export type PrepareResult =
  | { ok: true; documentId: string; versionId: string; path: string; token: string; duplicate: { id: string; title: string } | null }
  | { ok: false; message: string }

export async function prepareUploadAction(input: PrepareInput): Promise<PrepareResult> {
  const auth = await authorize(P.DOCUMENTS_WRITE)
  if ('error' in auth) return { ok: false, message: auth.error?.message ?? 'Action non autorisée.' }
  const parsed = prepareSchema.safeParse(input)
  if (!parsed.success) return { ok: false, message: 'Fichier invalide (25 Mo maximum).' }
  const { mode, clientId, folderId, fileName, sha256 } = parsed.data
  if (!fileTypeOf(fileName)) return { ok: false, message: `Format « .${extensionOf(fileName) || '?'} » non autorisé.` }

  const supabase = await createClient()
  let documentId = parsed.data.documentId
  if (mode === 'create') {
    if (!folderId) return { ok: false, message: 'Dossier manquant.' }
    const { data: folder } = await supabase.from('ged_folders').select('id').eq('id', folderId).eq('client_id', clientId).maybeSingle()
    if (!folder) return { ok: false, message: 'Dossier introuvable.' }
    documentId = randomUUID()
  } else {
    if (!documentId) return { ok: false, message: 'Document manquant.' }
    const { data: doc } = await supabase.from('ged_documents').select('id,deleted_at,client_id').eq('id', documentId).maybeSingle()
    if (!doc || doc.client_id !== clientId) return { ok: false, message: 'Document introuvable.' }
    if (doc.deleted_at) return { ok: false, message: gedErrorMessage({ message: 'GED_TRASHED' }) }
  }

  const versionId = randomUUID()
  const path = `${auth.ctx.profile.company_id}/${clientId}/${documentId}/${versionId}-${safeFileName(fileName)}`
  const { data: signed, error } = await supabase.storage.from(GED_BUCKET).createSignedUploadUrl(path)
  if (error || !signed?.token) return { ok: false, message: 'Envoi refusé (client archivé ou droits insuffisants).' }

  const { data: dups } = await supabase.rpc('ged_find_duplicate', { p_client: clientId, p_sha256: sha256 })
  const dup = (dups as { id: string; title: string }[] | null)?.[0] ?? null
  return { ok: true, documentId: documentId!, versionId, path, token: signed.token, duplicate: dup }
}

const finalizeSchema = z.object({
  mode: z.enum(['create', 'version']),
  clientId: uuid,
  folderId: uuid.optional(),
  documentId: uuid,
  versionId: uuid,
  path: z.string().min(10).max(600),
  fileName: z.string().min(1).max(200),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  title: z.string().trim().max(160).optional(),
  note: z.string().trim().max(500).optional(),
  articleId: uuid.optional(),
  productId: uuid.optional(),
  productKind: z.enum(['tech_sheet', 'pattern', 'marker', 'grading', 'sample_approval', 'test_report', 'label', 'packaging', 'other']).optional(),
  productRevision: z.string().trim().max(30).optional(),
  devProjectId: uuid.optional(),
  devKind: z.enum(['request', 'tech_pack', 'photo', 'bat', 'sample_report', 'approval', 'other']).optional(),
})
export type FinalizeInput = z.input<typeof finalizeSchema>
export type FinalizeResult = { ok: true; documentId: string; version?: number } | { ok: false; message: string }

export async function finalizeUploadAction(input: FinalizeInput): Promise<FinalizeResult> {
  const auth = await authorize(P.DOCUMENTS_WRITE)
  if ('error' in auth) return { ok: false, message: auth.error?.message ?? 'Action non autorisée.' }
  const parsed = finalizeSchema.safeParse(input)
  if (!parsed.success) return { ok: false, message: 'Données invalides.' }
  const d = parsed.data
  const ft = fileTypeOf(d.fileName)
  if (!ft) return { ok: false, message: 'Format non autorisé.' }

  const expected = `${auth.ctx.profile.company_id}/${d.clientId}/${d.documentId}/${d.versionId}-`
  const orphan: StoredFile = { bucket: GED_BUCKET, path: d.path }
  if (!d.path.startsWith(expected)) return { ok: false, message: 'Chemin de fichier invalide.' }

  const check = await inspectUpload(d.path, d.fileName)
  if (!check.ok) {
    await removeFiles([orphan])
    return { ok: false, message: check.reason }
  }

  const supabase = await createClient()
  if (d.mode === 'create') {
    if (!d.folderId) { await removeFiles([orphan]); return { ok: false, message: 'Dossier manquant.' } }
    const title = (d.title || stem(d.fileName) || 'Document').slice(0, 160)
    const { error } = await supabase.rpc('ged_create_document', {
      p_document: d.documentId, p_folder: d.folderId, p_title: title.length < 2 ? `${title} (doc)` : title,
      p_description: null, p_tags: [], p_valid_until: null, p_version: d.versionId, p_path: d.path,
      p_file_name: d.fileName, p_mime: ft.mime, p_size: check.size, p_sha256: d.sha256, p_note: d.note ?? null,
    })
    if (error) {
      await removeFiles([orphan])
      return { ok: false, message: (await dbFail(auth.ctx, P.DOCUMENTS_WRITE, error))?.message ?? 'Échec.' }
    }
    // Rattachement à un article (module Articles) : l'article doit appartenir au même client (contrôlé en base)
    if (d.articleId) {
      const { error: linkErr } = await supabase.from('ged_documents').update({ article_id: d.articleId }).eq('id', d.documentId)
      if (linkErr) {
        revalidatePath(`/ged/${d.clientId}`)
        return { ok: false, message: `Document créé mais non rattaché à l’article : ${gedErrorMessage(linkErr)}` }
      }
      revalidatePath(`/articles/${d.articleId}`, 'layout')
    }
    // Rattachement à un produit (module PDM) : même client exigé en base
    if (d.productId) {
      const { error: linkErr } = await supabase.from('product_documents').insert({ product_id: d.productId, ged_document_id: d.documentId, kind: d.productKind ?? 'other', revision: d.productRevision || null })
      if (linkErr) {
        revalidatePath(`/ged/${d.clientId}`)
        return { ok: false, message: 'Document créé dans la GED mais non rattaché au produit (rattachez-le depuis la fiche produit).' }
      }
      revalidatePath(`/products/${d.productId}`, 'layout')
    }
    // Pièce jointe d'un projet de développement produit
    if (d.devProjectId) {
      const { error: linkErr } = await supabase.from('development_documents').insert({ project_id: d.devProjectId, ged_document_id: d.documentId, kind: d.devKind ?? 'other' })
      if (linkErr) {
        revalidatePath(`/ged/${d.clientId}`)
        return { ok: false, message: 'Document créé dans la GED mais non rattaché au projet (rattachez-le depuis la fiche projet).' }
      }
      revalidatePath(`/development/projects/${d.devProjectId}`, 'layout')
    }
    revalidatePath(`/ged/${d.clientId}`)
    return { ok: true, documentId: d.documentId }
  }

  const { data, error } = await supabase.rpc('ged_add_version', {
    p_document: d.documentId, p_version: d.versionId, p_path: d.path, p_file_name: d.fileName,
    p_mime: ft.mime, p_size: check.size, p_sha256: d.sha256, p_note: d.note ?? null,
  })
  if (error) {
    await removeFiles([orphan])
    return { ok: false, message: (await dbFail(auth.ctx, P.DOCUMENTS_WRITE, error))?.message ?? 'Échec.' }
  }
  revalidatePath(`/ged/${d.clientId}`, 'layout')
  return { ok: true, documentId: d.documentId, version: data as number }
}

/** Crée une nouvelle version identique à une version antérieure (copie du fichier, l'historique est conservé). */
export async function restoreVersionAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.DOCUMENTS_WRITE)
  if ('error' in auth) return auth.error
  const id = uuid.safeParse(fd.get('document_id'))
  const versionId = uuid.safeParse(fd.get('version_id'))
  if (!id.success || !versionId.success) return { ok: false, message: 'Données invalides.' }

  const supabase = await createClient()
  const { data: v } = await supabase.from('ged_document_versions').select('*').eq('id', versionId.data).eq('document_id', id.data).maybeSingle()
  if (!v) return { ok: false, message: 'Version introuvable.' }
  const newId = randomUUID()
  const newPath = `${auth.ctx.profile.company_id}/${v.client_id}/${id.data}/${newId}-${safeFileName(v.file_name as string)}`
  const { error: copyErr } = await supabase.storage.from(v.storage_bucket as string).copy(v.storage_path as string, newPath, { destinationBucket: GED_BUCKET })
  if (copyErr) return { ok: false, message: 'Impossible de copier le fichier de cette version.' }

  const { error } = await supabase.rpc('ged_add_version', {
    p_document: id.data, p_version: newId, p_path: newPath, p_file_name: v.file_name, p_mime: v.mime_type,
    p_size: v.size_bytes, p_sha256: v.sha256, p_note: `Restauration de la version ${v.version_no}`,
  })
  if (error) {
    await removeFiles([{ bucket: GED_BUCKET, path: newPath }])
    return dbFail(auth.ctx, P.DOCUMENTS_WRITE, error)
  }
  revalidatePath(`/ged/${v.client_id}`, 'layout')
  return { ok: true, message: `Version ${v.version_no} restaurée comme nouvelle version.` }
}

// ---------------------------------------------------------------------
// Métadonnées d'un document
// ---------------------------------------------------------------------
const metaSchema = z.object({
  id: uuid,
  title: z.string().trim().min(2, 'Titre requis (2 caractères minimum)').max(160),
  description: z.string().trim().max(2000).transform((v) => v || null),
  tags: z.string().transform((v) => v.split(',').map((t) => t.trim()).filter(Boolean)),
  valid_until: z.string().trim().refine((v) => v === '' || /^\d{4}-\d{2}-\d{2}$/.test(v), 'Date invalide').transform((v) => v || null),
  folder_id: uuid,
  article_id: z.string().trim().transform((v) => (v === '' ? null : v)).pipe(uuid.nullable()).optional(),
})

export async function updateDocumentAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.DOCUMENTS_WRITE)
  if ('error' in auth) return auth.error
  const parsed = metaSchema.safeParse(Object.fromEntries([...fd.entries()].filter(([k]) => !k.startsWith('$ACTION'))))
  if (!parsed.success) return { ok: false, message: 'Veuillez corriger les champs en erreur.', fieldErrors: z.flattenError(parsed.error).fieldErrors }
  const { id, article_id, ...rest } = parsed.data
  const changes = article_id === undefined ? rest : { ...rest, article_id }

  const supabase = await createClient()
  const { data, error } = await supabase.from('ged_documents').update(changes).eq('id', id).select('id,client_id')
  if (error) return dbFail(auth.ctx, P.DOCUMENTS_WRITE, error)
  if (!data?.length) return { ok: false, message: 'Document introuvable, en corbeille ou modification non autorisée.' }
  revalidatePath(`/ged/${data[0].client_id}`, 'layout')
  return { ok: true, message: 'Document mis à jour.' }
}

// ---------------------------------------------------------------------
// Validation, corbeille, suppression définitive
// ---------------------------------------------------------------------
async function simpleRpc(
  permission: string,
  fn: string,
  args: Record<string, unknown>,
  okMessage: string,
  clientId?: string,
): Promise<FormState> {
  const auth = await authorize(permission)
  if ('error' in auth) return auth.error
  const supabase = await createClient()
  const { error } = await supabase.rpc(fn, args)
  if (error) return dbFail(auth.ctx, permission, error)
  revalidatePath(clientId ? `/ged/${clientId}` : '/ged', 'layout')
  return { ok: true, message: okMessage }
}

const docRef = z.object({ id: uuid, client_id: uuid })

export async function submitDocumentAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const p = docRef.safeParse({ id: fd.get('id'), client_id: fd.get('client_id') })
  if (!p.success) return { ok: false, message: 'Données invalides.' }
  return simpleRpc(P.DOCUMENTS_WRITE, 'ged_submit', { p_document: p.data.id }, 'Document soumis pour validation.', p.data.client_id)
}

export async function reviewDocumentAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const p = docRef.safeParse({ id: fd.get('id'), client_id: fd.get('client_id') })
  if (!p.success) return { ok: false, message: 'Données invalides.' }
  const approve = fd.get('decision') === 'approve'
  const comment = String(fd.get('comment') ?? '').trim().slice(0, 1000)
  if (!approve && comment.length < 3) return { ok: false, message: 'Un commentaire est obligatoire pour rejeter un document.', fieldErrors: { comment: ['Commentaire requis'] } }
  return simpleRpc(P.DOCUMENTS_VALIDATE, 'ged_review', { p_document: p.data.id, p_approve: approve, p_comment: comment || null },
    approve ? 'Document validé.' : 'Document rejeté.', p.data.client_id)
}

export async function trashDocumentAction(fd: FormData): Promise<void> {
  const p = docRef.safeParse({ id: fd.get('id'), client_id: fd.get('client_id') })
  if (!p.success) return
  await simpleRpc(P.DOCUMENTS_WRITE, 'ged_trash', { p_document: p.data.id }, '', p.data.client_id)
  if (fd.get('redirect') === '1') redirect(`/ged/${p.data.client_id}?trashed=1`)
}

export async function restoreDocumentAction(fd: FormData): Promise<void> {
  const p = docRef.safeParse({ id: fd.get('id'), client_id: fd.get('client_id') })
  if (!p.success) return
  await simpleRpc(P.DOCUMENTS_WRITE, 'ged_restore', { p_document: p.data.id }, '', p.data.client_id)
}

export async function purgeDocumentAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.DOCUMENTS_DELETE)
  if ('error' in auth) return auth.error
  const p = docRef.safeParse({ id: fd.get('id'), client_id: fd.get('client_id') })
  if (!p.success) return { ok: false, message: 'Données invalides.' }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('ged_purge', { p_document: p.data.id })
  if (error) return dbFail(auth.ctx, P.DOCUMENTS_DELETE, error)
  await removeFiles(((data as { bucket: string; path: string }[]) ?? []).map((f) => ({ bucket: f.bucket, path: f.path })))
  revalidatePath(`/ged/${p.data.client_id}`, 'layout')
  return { ok: true, message: 'Document supprimé définitivement.' }
}

export async function emptyTrashAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.DOCUMENTS_DELETE)
  if ('error' in auth) return auth.error
  const clientId = uuid.safeParse(fd.get('client_id'))
  if (!clientId.success) return { ok: false, message: 'Données invalides.' }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('ged_empty_trash', { p_client: clientId.data })
  if (error) return dbFail(auth.ctx, P.DOCUMENTS_DELETE, error)
  const files = ((data as { bucket: string; path: string }[]) ?? [])
  await removeFiles(files)
  revalidatePath(`/ged/${clientId.data}`, 'layout')
  return { ok: true, message: files.length ? 'Corbeille vidée.' : 'La corbeille était vide.' }
}

// ---------------------------------------------------------------------
// Dossiers
// ---------------------------------------------------------------------
const folderSchema = z.object({
  client_id: uuid,
  parent_id: z.string().transform((v) => (v === '' ? null : v)).pipe(uuid.nullable()),
  name: z.string().trim().min(1, 'Nom requis').max(80, '80 caractères maximum').refine((v) => !/[\\/]/.test(v), 'Les caractères « / » et « \\ » sont interdits'),
})

export async function createFolderAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.DOCUMENTS_WRITE)
  if ('error' in auth) return auth.error
  const p = folderSchema.safeParse({ client_id: fd.get('client_id'), parent_id: fd.get('parent_id') ?? '', name: fd.get('name') })
  if (!p.success) return { ok: false, message: 'Nom de dossier invalide.', fieldErrors: z.flattenError(p.error).fieldErrors }
  const supabase = await createClient()
  const { error } = await supabase.from('ged_folders').insert({ client_id: p.data.client_id, parent_id: p.data.parent_id, name: p.data.name })
  if (error) return dbFail(auth.ctx, P.DOCUMENTS_WRITE, error)
  revalidatePath(`/ged/${p.data.client_id}`, 'layout')
  return { ok: true, message: 'Dossier créé.' }
}

export async function renameFolderAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.DOCUMENTS_WRITE)
  if ('error' in auth) return auth.error
  const id = uuid.safeParse(fd.get('id'))
  const clientId = uuid.safeParse(fd.get('client_id'))
  const name = folderSchema.shape.name.safeParse(fd.get('name'))
  if (!id.success || !clientId.success || !name.success) return { ok: false, message: 'Nom de dossier invalide.' }
  const supabase = await createClient()
  const { data, error } = await supabase.from('ged_folders').update({ name: name.data }).eq('id', id.data).select('id')
  if (error) return dbFail(auth.ctx, P.DOCUMENTS_WRITE, error)
  if (!data?.length) return { ok: false, message: 'Dossier introuvable.' }
  revalidatePath(`/ged/${clientId.data}`, 'layout')
  return { ok: true, message: 'Dossier renommé.' }
}

export async function deleteFolderAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.DOCUMENTS_WRITE)
  if ('error' in auth) return auth.error
  const id = uuid.safeParse(fd.get('id'))
  const clientId = uuid.safeParse(fd.get('client_id'))
  if (!id.success || !clientId.success) return { ok: false, message: 'Données invalides.' }
  const supabase = await createClient()
  const { error } = await supabase.from('ged_folders').delete().eq('id', id.data)
  if (error) return dbFail(auth.ctx, P.DOCUMENTS_WRITE, error)
  revalidatePath(`/ged/${clientId.data}`, 'layout')
  redirect(`/ged/${clientId.data}`)
}

// ---------------------------------------------------------------------
// Commentaires
// ---------------------------------------------------------------------
export async function addCommentAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.DOCUMENTS_READ)
  if ('error' in auth) return auth.error
  const id = uuid.safeParse(fd.get('document_id'))
  const clientId = uuid.safeParse(fd.get('client_id'))
  const body = z.string().trim().min(1, 'Commentaire vide').max(2000).safeParse(fd.get('body'))
  if (!id.success || !clientId.success) return { ok: false, message: 'Données invalides.' }
  if (!body.success) return { ok: false, message: 'Le commentaire est vide ou trop long (2 000 caractères).' }
  const supabase = await createClient()
  const { error } = await supabase.from('ged_comments').insert({ document_id: id.data, body: body.data })
  if (error) return dbFail(auth.ctx, P.DOCUMENTS_READ, error)
  revalidatePath(`/ged/${clientId.data}/${id.data}`)
  return { ok: true, message: 'Commentaire publié.' }
}

export async function deleteCommentAction(fd: FormData): Promise<void> {
  const auth = await authorize(P.DOCUMENTS_READ)
  if ('error' in auth) return
  const id = uuid.safeParse(fd.get('id'))
  const clientId = uuid.safeParse(fd.get('client_id'))
  const docId = uuid.safeParse(fd.get('document_id'))
  if (!id.success || !clientId.success || !docId.success) return
  const supabase = await createClient()
  await supabase.rpc('ged_delete_comment', { p_comment: id.data })
  revalidatePath(`/ged/${clientId.data}/${docId.data}`)
}
