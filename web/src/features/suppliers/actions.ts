'use server'

import { randomUUID } from 'node:crypto'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'
import { safeFileName } from '@/lib/ged/constants'
import { getAuthContext } from '@/features/auth/services/access.service'
import type { AuthContextValue, FormState } from '@/features/auth/types'
import { logAccessDenied } from '@/features/rbac/services/audit-write.service'
import { removeFiles } from '@/features/ged/services/storage.service'
import { isPermissionError, supplierErrorMessage } from './errors'
import { ALLOWED_MIME, MAX_FILE_BYTES, formToObject, supplierContactSchema, supplierDocumentSchema, supplierSchema } from './schemas'

/** Écritures via la session de l'utilisateur : la RLS (suppliers.*) et les RPC font autorité. */

const BUCKET = 'supplier-docs'
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
  return { ok: false, message: supplierErrorMessage(err), values }
}

const raw = (fd: FormData): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [k, v] of fd.entries()) if (typeof v === 'string' && !k.startsWith('$ACTION')) out[k] = v
  return out
}
const invalid = (e: z.ZodError, values: Record<string, string>): FormState => ({
  ok: false, message: 'Veuillez corriger les champs en erreur.', fieldErrors: z.flattenError(e).fieldErrors, values,
})

// --- Fournisseur ------------------------------------------------------------------
export async function createSupplierAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.SUPPLIERS_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const parsed = supplierSchema.safeParse(formToObject(fd))
  if (!parsed.success) return invalid(parsed.error, values)
  const supabase = await createClient()
  const { data, error } = await supabase.from('suppliers').insert(parsed.data).select('id').single()
  if (error) return dbFail(auth.ctx, P.SUPPLIERS_WRITE, error, values)
  revalidatePath('/suppliers')
  redirect(`/suppliers/${data.id}?created=1`)
}

export async function updateSupplierAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.SUPPLIERS_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const id = uuid.safeParse(fd.get('id'))
  if (!id.success) return { ok: false, message: 'Identifiant invalide.', values }
  const parsed = supplierSchema.safeParse(formToObject(fd))
  if (!parsed.success) return invalid(parsed.error, values)
  const { code: _code, ...changes } = parsed.data
  void _code
  const supabase = await createClient()
  const { data, error } = await supabase.from('suppliers').update(changes).eq('id', id.data).select('id')
  if (error) return dbFail(auth.ctx, P.SUPPLIERS_WRITE, error, values)
  if (!data?.length) return { ok: false, message: 'Fournisseur introuvable ou modification non autorisée.', values }
  revalidatePath('/suppliers', 'layout')
  redirect(`/suppliers/${id.data}?updated=1`)
}

async function rpcRedirect(fd: FormData, fn: string, flag: string, reasonKey?: string): Promise<FormState> {
  const auth = await authorize(P.SUPPLIERS_DELETE)
  if ('error' in auth) return auth.error
  const id = uuid.safeParse(fd.get('id'))
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  const args: Record<string, unknown> = { p_supplier: id.data }
  if (reasonKey) args.p_reason = String(fd.get(reasonKey) ?? '').trim().slice(0, 300) || null
  const supabase = await createClient()
  const { error } = await supabase.rpc(fn, args)
  if (error) return dbFail(auth.ctx, P.SUPPLIERS_DELETE, error)
  revalidatePath('/suppliers', 'layout')
  redirect(`/suppliers/${id.data}?${flag}=1`)
}
export async function archiveSupplierAction(_p: FormState, fd: FormData) { return rpcRedirect(fd, 'supplier_archive', 'archived', 'reason') }
export async function restoreSupplierAction(_p: FormState, fd: FormData) { return rpcRedirect(fd, 'supplier_restore', 'restored') }

export async function deleteSupplierAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.SUPPLIERS_DELETE)
  if ('error' in auth) return auth.error
  const id = uuid.safeParse(fd.get('id'))
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  if (String(fd.get('confirm') ?? '').trim().toUpperCase() !== 'SUPPRIMER') return { ok: false, message: 'Saisissez « SUPPRIMER » pour confirmer la suppression définitive.' }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('supplier_delete', { p_supplier: id.data })
  if (error) return dbFail(auth.ctx, P.SUPPLIERS_DELETE, error)
  await removeFiles(((data as { bucket: string; path: string }[]) ?? []))
  revalidatePath('/suppliers')
  redirect('/suppliers?deleted=1')
}

// --- Contacts ------------------------------------------------------------------------
export async function saveSupplierContactAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.SUPPLIERS_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const sid = uuid.safeParse(fd.get('supplier_id'))
  if (!sid.success) return { ok: false, message: 'Fournisseur invalide.', values }
  const id = fd.get('id') ? uuid.safeParse(fd.get('id')) : null
  if (id && !id.success) return { ok: false, message: 'Contact invalide.', values }
  const parsed = supplierContactSchema.safeParse(formToObject(fd, ['is_primary']))
  if (!parsed.success) return invalid(parsed.error, values)
  const supabase = await createClient()
  const { error } = id
    ? await supabase.from('supplier_contacts').update(parsed.data).eq('id', id.data!).eq('supplier_id', sid.data)
    : await supabase.from('supplier_contacts').insert({ ...parsed.data, supplier_id: sid.data })
  if (error) return dbFail(auth.ctx, P.SUPPLIERS_WRITE, error, values)
  revalidatePath(`/suppliers/${sid.data}`)
  return { ok: true, message: id ? 'Contact mis à jour.' : 'Contact ajouté.' }
}

export async function deleteSupplierContactAction(fd: FormData): Promise<void> {
  const auth = await authorize(P.SUPPLIERS_WRITE)
  if ('error' in auth) return
  const id = uuid.safeParse(fd.get('id'))
  const sid = uuid.safeParse(fd.get('supplier_id'))
  if (!id.success || !sid.success) return
  const supabase = await createClient()
  await supabase.from('supplier_contacts').delete().eq('id', id.data).eq('supplier_id', sid.data)
  revalidatePath(`/suppliers/${sid.data}`)
}

// --- Documents (Storage privé `supplier-docs`) ------------------------------------------
function matchesSignature(mime: string, b: Uint8Array): boolean {
  const starts = (...bytes: number[]) => bytes.every((v, i) => b[i] === v)
  switch (mime) {
    case 'application/pdf': return starts(0x25, 0x50, 0x44, 0x46)
    case 'image/png': return starts(0x89, 0x50, 0x4e, 0x47)
    case 'image/jpeg': return starts(0xff, 0xd8, 0xff)
    case 'image/webp': return starts(0x52, 0x49, 0x46, 0x46) && b[8] === 0x57 && b[9] === 0x45
    case 'application/msword':
    case 'application/vnd.ms-excel': return starts(0xd0, 0xcf, 0x11, 0xe0)
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': return starts(0x50, 0x4b)
    default: return !b.slice(0, 32).includes(0)
  }
}

export async function uploadSupplierDocumentAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.SUPPLIERS_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const sid = uuid.safeParse(fd.get('supplier_id'))
  if (!sid.success) return { ok: false, message: 'Fournisseur invalide.', values }
  const meta = supplierDocumentSchema.safeParse(formToObject(fd))
  if (!meta.success) return invalid(meta.error, values)

  const file = fd.get('file')
  const fe = (m: string): FormState => ({ ok: false, message: m, fieldErrors: { file: [m] }, values })
  if (!(file instanceof File) || file.size === 0) return fe('Sélectionnez un fichier.')
  if (file.size > MAX_FILE_BYTES) return fe('Fichier trop volumineux (10 Mo maximum).')
  if (!(ALLOWED_MIME as readonly string[]).includes(file.type)) return fe('Format non autorisé (PDF, images, Word, Excel, texte).')
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (!matchesSignature(file.type, bytes)) return fe('Le contenu du fichier ne correspond pas à son format.')

  const path = `${auth.ctx.profile.company_id}/${sid.data}/${randomUUID()}-${safeFileName(file.name)}`
  const supabase = await createClient()
  const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, bytes, { contentType: file.type, upsert: false })
  if (upErr) return { ok: false, message: /row-level|policy|not authorized/i.test(upErr.message) ? 'Vous n’avez pas la permission d’ajouter un document.' : 'Échec de l’envoi du fichier.', values }
  const { error } = await supabase.from('supplier_documents').insert({
    supplier_id: sid.data, title: meta.data.title, doc_type: meta.data.doc_type, valid_until: meta.data.valid_until, notes: meta.data.notes,
    file_name: file.name.slice(0, 200), mime_type: file.type, size_bytes: file.size, storage_path: path,
  })
  if (error) {
    await removeFiles([{ bucket: BUCKET, path }]) // pas de fichier orphelin
    return dbFail(auth.ctx, P.SUPPLIERS_WRITE, error, values)
  }
  revalidatePath(`/suppliers/${sid.data}`)
  return { ok: true, message: 'Document ajouté.' }
}

export async function deleteSupplierDocumentAction(fd: FormData): Promise<void> {
  const auth = await authorize(P.SUPPLIERS_WRITE)
  if ('error' in auth) return
  const id = uuid.safeParse(fd.get('id'))
  const sid = uuid.safeParse(fd.get('supplier_id'))
  if (!id.success || !sid.success) return
  const supabase = await createClient()
  const { data: doc } = await supabase.from('supplier_documents').select('storage_path').eq('id', id.data).eq('supplier_id', sid.data).maybeSingle()
  if (!doc) return
  const { error } = await supabase.from('supplier_documents').delete().eq('id', id.data)
  if (!error) await removeFiles([{ bucket: BUCKET, path: doc.storage_path as string }])
  revalidatePath(`/suppliers/${sid.data}`)
}
