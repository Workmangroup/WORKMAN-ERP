import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'
import { getAuthContext } from '@/features/auth/services/access.service'
import { getDocument } from '@/features/ged/services/ged.service'
import { downloadDenied, fileResponse, type ServableVersion } from '@/features/ged/services/download'
import { logFileAccess } from '@/features/ged/services/storage.service'

export const dynamic = 'force-dynamic'

/**
 * Sert un fichier de la GED (aperçu intégré ou téléchargement) après contrôle des droits (RLS).
 * Le fichier transite par l'application : pas de lien public, en-têtes de sécurité maîtrisés
 * (les URL signées Supabase imposent une CSP « sandbox » qui bloque l'aperçu PDF dans une iframe).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ versionId: string }> }) {
  const { versionId } = await params
  const ctx = await getAuthContext()
  if (!ctx) return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 })
  if (!ctx.permissions.includes(P.DOCUMENTS_READ)) return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 })
  if (!z.uuid().safeParse(versionId).success) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })

  // Droits du document parent et état de publication revérifiés en base à chaque appel (ged_download_check)
  const supabase = await createClient()
  const { data: rows, error: checkError } = await supabase.rpc('ged_download_check', { p_version: versionId })
  if (checkError || !rows?.[0]) return downloadDenied(checkError)
  const version = rows[0] as ServableVersion & { document_id: string; title: string }

  const { data: blob, error } = await supabase.storage.from(version.storage_bucket).download(version.storage_path)
  if (error || !blob) return NextResponse.json({ error: 'FILE_UNAVAILABLE' }, { status: 502 })

  const wantsInline = req.nextUrl.searchParams.get('inline') === '1'
  if (!wantsInline && req.nextUrl.searchParams.get('download') === '1') {
    const doc = await getDocument(version.document_id)
    if (doc) await logFileAccess(ctx, 'ged.download', { id: doc.id, title: doc.title, client_id: doc.client_id }, version.version_no)
  }
  return fileResponse(blob, version, wantsInline)
}
