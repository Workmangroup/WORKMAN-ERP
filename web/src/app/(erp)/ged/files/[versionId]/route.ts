import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'
import { isInlineMime, kindOfMime } from '@/lib/ged/constants'
import { getAuthContext } from '@/features/auth/services/access.service'
import { getDocument, getVersion } from '@/features/ged/services/ged.service'
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

  const version = await getVersion(versionId)
  if (!version) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })

  const supabase = await createClient()
  const { data: blob, error } = await supabase.storage.from(version.storage_bucket).download(version.storage_path)
  if (error || !blob) return NextResponse.json({ error: 'FILE_UNAVAILABLE' }, { status: 502 })

  const wantsInline = req.nextUrl.searchParams.get('inline') === '1' && isInlineMime(version.mime_type)
  const kind = kindOfMime(version.mime_type)

  if (!wantsInline && req.nextUrl.searchParams.get('download') === '1') {
    const doc = await getDocument(version.document_id)
    if (doc) await logFileAccess(ctx, 'ged.download', { id: doc.id, title: doc.title, client_id: doc.client_id }, version.version_no)
  }

  const headers = new Headers({
    'Content-Type': wantsInline ? version.mime_type : 'application/octet-stream',
    'Content-Length': String(blob.size),
    'Content-Disposition': `${wantsInline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(version.file_name)}`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'no-referrer',
  })
  // Sans contenu actif : un fichier ne peut jamais exécuter de script dans notre origine.
  headers.set('Content-Security-Policy', kind === 'pdf' ? "default-src 'none'; style-src 'unsafe-inline'; img-src data:" : "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; sandbox")
  return new NextResponse(blob.stream(), { headers })
}
