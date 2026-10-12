import 'server-only'
import { createAdminClient, hasServiceRole } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { GED_BUCKET, MAX_FILE_BYTES, extensionOf, matchesMagic } from '@/lib/ged/constants'
import { requestInfo } from '@/features/auth/services/audit.service'
import type { AuthContextValue } from '@/features/auth/types'

export interface StoredFile {
  bucket: string
  path: string
}

/** Supprime des fichiers du Storage (service_role : aucune politique DELETE côté utilisateur). */
export async function removeFiles(files: StoredFile[]): Promise<{ ok: boolean }> {
  if (files.length === 0) return { ok: true }
  if (!hasServiceRole()) {
    console.error('[ged] SUPABASE_SERVICE_ROLE_KEY absente : fichiers non supprimés du Storage', files.length)
    return { ok: false }
  }
  const admin = createAdminClient()
  const byBucket = new Map<string, string[]>()
  for (const f of files) byBucket.set(f.bucket, [...(byBucket.get(f.bucket) ?? []), f.path])
  let ok = true
  for (const [bucket, paths] of byBucket) {
    const { error } = await admin.storage.from(bucket).remove(paths)
    if (error) { ok = false; console.error('[ged] suppression Storage :', error.message) }
  }
  return { ok }
}

/**
 * Vérifie un objet fraîchement téléversé : taille réelle, extension autorisée, signature du fichier.
 * Lecture partielle (Range) via une URL signée de courte durée.
 */
export async function inspectUpload(path: string, fileName: string): Promise<{ ok: true; size: number } | { ok: false; reason: string }> {
  const ext = extensionOf(fileName)
  const supabase = await createClient()
  const { data, error } = await supabase.storage.from(GED_BUCKET).createSignedUrl(path, 60)
  if (error || !data?.signedUrl) return { ok: false, reason: 'Le fichier n’a pas été trouvé dans le stockage.' }

  const res = await fetch(data.signedUrl, { headers: { Range: 'bytes=0-63' }, cache: 'no-store' })
  if (!res.ok && res.status !== 206) return { ok: false, reason: 'Le fichier n’a pas été trouvé dans le stockage.' }
  const range = res.headers.get('content-range') // "bytes 0-63/12345"
  const size = range ? Number(range.split('/')[1]) : Number(res.headers.get('content-length') ?? 0)
  const head = new Uint8Array(await res.arrayBuffer())
  if (!Number.isFinite(size) || size <= 0) return { ok: false, reason: 'Fichier vide.' }
  if (size > MAX_FILE_BYTES) return { ok: false, reason: 'Fichier trop volumineux (25 Mo maximum).' }
  if (!matchesMagic(ext, head)) return { ok: false, reason: 'Le contenu du fichier ne correspond pas à son format.' }
  return { ok: true, size }
}

/** Journalise une consultation / un téléchargement (best-effort, via service_role). */
export async function logFileAccess(ctx: AuthContextValue, action: 'ged.download', doc: { id: string; title: string; client_id: string }, version: number) {
  if (!hasServiceRole()) return
  try {
    const { ip, userAgent } = await requestInfo()
    await createAdminClient().from('audit_logs').insert({
      company_id: ctx.profile.company_id, actor_id: ctx.user.id, actor_email: ctx.user.email, action,
      entity_type: 'document', entity_id: doc.id, entity_label: doc.title,
      metadata: { client_id: doc.client_id, version }, source: 'app', ip, user_agent: userAgent,
    })
  } catch (err) {
    console.error('[ged audit]', err)
  }
}
