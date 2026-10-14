import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getAuthContext } from '@/features/auth/services/access.service'
import { downloadDenied, fileResponse, type ServableVersion } from '@/features/ged/services/download'

export const dynamic = 'force-dynamic'

/**
 * Lien temporaire de téléchargement. Le jeton ne suffit pas : la personne doit être connectée et avoir les droits du document
 * au moment de l'ouverture (vérifié en base par ged_link_resolve, qui contrôle aussi l'expiration et la révocation).
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const ctx = await getAuthContext()
  if (!ctx) return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 })
  if (!/^[0-9a-f]{64}$/.test(token)) return NextResponse.json({ error: 'LINK_INVALID', message: 'Ce lien n’existe pas.' }, { status: 404 })

  const supabase = await createClient()
  const { data: rows, error: resolveError } = await supabase.rpc('ged_link_resolve', { p_token: token })
  if (resolveError || !rows?.[0]) return downloadDenied(resolveError)
  const version = rows[0] as ServableVersion

  const { data: blob, error } = await supabase.storage.from(version.storage_bucket).download(version.storage_path)
  if (error || !blob) return NextResponse.json({ error: 'FILE_UNAVAILABLE' }, { status: 502 })
  return fileResponse(blob, version, false)
}
