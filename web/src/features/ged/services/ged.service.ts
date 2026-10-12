import 'server-only'
import { createClient } from '@/lib/supabase/server'
import { EXPIRY_WARNING_DAYS } from '@/lib/ged/constants'
import type { AuditRow } from '@/features/rbac/types'
import type { ClientStats, GedComment, GedDocument, GedFilters, GedFolder, GedVersion } from '../types'
import { AUDIT_READ_COLUMNS } from '@/features/rbac/audit-columns'

export const PAGE_SIZE = 25
const clean = (v: string | undefined) => (v ?? '').replace(/[%,()*\\:"]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)

export async function listFolders(clientId: string): Promise<GedFolder[]> {
  const supabase = await createClient()
  const { data } = await supabase
    .from('ged_folders')
    .select('id,client_id,parent_id,name,system_key,sort_order')
    .eq('client_id', clientId)
    .order('sort_order')
    .order('name')
  return (data ?? []) as GedFolder[]
}

/** Nombre de documents (hors corbeille) par dossier, et taille de la corbeille. */
export async function folderCounts(clientId: string): Promise<{ byFolder: Map<string, number>; trash: number }> {
  const supabase = await createClient()
  const { data } = await supabase.from('ged_documents').select('folder_id,deleted_at').eq('client_id', clientId).limit(10000)
  const byFolder = new Map<string, number>()
  let trash = 0
  for (const d of data ?? []) {
    if (d.deleted_at) trash++
    else byFolder.set(d.folder_id as string, (byFolder.get(d.folder_id as string) ?? 0) + 1)
  }
  return { byFolder, trash }
}

export async function clientStats(): Promise<Map<string, ClientStats>> {
  const supabase = await createClient()
  const { data } = await supabase.rpc('ged_client_stats')
  const map = new Map<string, ClientStats>()
  for (const r of (data ?? []) as Record<string, unknown>[]) {
    map.set(r.client_id as string, {
      client_id: r.client_id as string,
      documents: Number(r.documents), pending: Number(r.pending), expiring: Number(r.expiring),
      trashed: Number(r.trashed), size_bytes: Number(r.size_bytes),
    })
  }
  return map
}

export async function listClientsLite(): Promise<{ id: string; name: string; code: string; archived_at: string | null }[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('clients').select('id,name,code,archived_at').order('name').limit(2000)
  return (data ?? []) as { id: string; name: string; code: string; archived_at: string | null }[]
}

/** Recherche / listing de documents (par client, dossier, corbeille, mot-clé, statut, validité). */
export async function searchDocuments(f: GedFilters): Promise<{ rows: GedDocument[]; total: number }> {
  const supabase = await createClient()
  const page = Math.max(1, f.page ?? 1)
  let q = supabase.from('ged_documents').select('*', { count: 'exact' })

  q = f.trash ? q.not('deleted_at', 'is', null) : q.is('deleted_at', null)
  if (f.clientId) q = q.eq('client_id', f.clientId)
  if (f.folderId) q = q.eq('folder_id', f.folderId)
  if (f.folderIds?.length) q = q.in('folder_id', f.folderIds)
  if (f.folderKey) {
    const { data: folders } = await supabase.from('ged_folders').select('id').eq('system_key', f.folderKey)
    q = q.in('folder_id', (folders ?? []).map((x) => x.id as string).concat('00000000-0000-0000-0000-000000000000'))
  }
  if (f.status && ['draft', 'pending_review', 'validated', 'rejected'].includes(f.status)) q = q.eq('status', f.status)
  if (f.expiring) {
    const limit = new Date(Date.now() + EXPIRY_WARNING_DAYS * 86_400_000).toISOString().slice(0, 10)
    q = q.not('valid_until', 'is', null).lte('valid_until', limit)
  }
  const term = clean(f.q)
  if (term) {
    const tag = term.toLowerCase().replace(/\s+/g, '-')
    q = q.or([`title.ilike.%${term}%`, `description.ilike.%${term}%`, `file_name.ilike.%${term}%`, `tags.cs.{${tag}}`].join(','))
  }
  q = q.order(f.trash ? 'deleted_at' : 'updated_at', { ascending: false }).range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1)

  const { data, count, error } = await q
  if (error) throw new Error(error.message)
  return { rows: (data ?? []) as GedDocument[], total: count ?? 0 }
}

export async function getDocument(id: string): Promise<GedDocument | null> {
  const supabase = await createClient()
  const { data } = await supabase.from('ged_documents').select('*').eq('id', id).maybeSingle()
  return (data as GedDocument | null) ?? null
}

export async function getVersion(id: string): Promise<GedVersion | null> {
  const supabase = await createClient()
  const { data } = await supabase.from('ged_document_versions').select('*').eq('id', id).maybeSingle()
  return (data as GedVersion | null) ?? null
}

export async function listVersions(documentId: string): Promise<GedVersion[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('ged_document_versions').select('*').eq('document_id', documentId).order('version_no', { ascending: false })
  return (data ?? []) as GedVersion[]
}

export async function listComments(documentId: string): Promise<GedComment[]> {
  const supabase = await createClient()
  const { data } = await supabase
    .from('ged_comments')
    .select('id,document_id,author_id,body,created_at,deleted_at')
    .eq('document_id', documentId)
    .is('deleted_at', null)
    .order('created_at')
  return (data ?? []) as GedComment[]
}

/** Activité récente de l'espace documentaire d'un client. */
export async function clientActivity(clientId: string, limit = 60): Promise<AuditRow[]> {
  const supabase = await createClient()
  const { data } = await supabase
    .from('audit_logs')
    .select(AUDIT_READ_COLUMNS)
    .in('entity_type', ['document', 'folder'])
    .contains('metadata', { client_id: clientId })
    .order('created_at', { ascending: false })
    .limit(limit)
  return (data ?? []) as unknown as AuditRow[]
}

export async function documentHistory(documentId: string, limit = 100): Promise<AuditRow[]> {
  const supabase = await createClient()
  const { data } = await supabase
    .from('audit_logs')
    .select(AUDIT_READ_COLUMNS)
    .eq('entity_type', 'document')
    .eq('entity_id', documentId)
    .order('created_at', { ascending: false })
    .limit(limit)
  return (data ?? []) as unknown as AuditRow[]
}
