import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'
import { getAuthContext } from '@/features/auth/services/access.service'
import { getPhoto } from '@/features/articles/services/articles.service'

export const dynamic = 'force-dynamic'

/** Photo d'article : contrôle articles.read (RLS) puis redirection vers une URL signée courte (jamais de lien public). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ photoId: string }> }) {
  const { photoId } = await params
  const ctx = await getAuthContext()
  if (!ctx) return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 })
  if (!ctx.permissions.includes(P.ARTICLES_READ)) return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 })
  if (!z.uuid().safeParse(photoId).success) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })
  const photo = await getPhoto(photoId)
  if (!photo) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })
  const supabase = await createClient()
  const { data, error } = await supabase.storage.from('article-photos').createSignedUrl(photo.storage_path, 120)
  if (error || !data?.signedUrl) return NextResponse.json({ error: 'FILE_UNAVAILABLE' }, { status: 502 })
  return NextResponse.redirect(data.signedUrl, { status: 302, headers: { 'cache-control': 'private, max-age=60' } })
}
