import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'
import { getAuthContext } from '@/features/auth/services/access.service'
import { getDocument } from '@/features/suppliers/services/suppliers.service'

export const dynamic = 'force-dynamic'

/** Téléchargement : contrôle suppliers.read (RLS) puis URL signée de 60 s (jamais de lien public). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string; docId: string }> }) {
  const { id, docId } = await params
  const ctx = await getAuthContext()
  if (!ctx) return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 })
  if (!ctx.permissions.includes(P.SUPPLIERS_READ)) return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 })
  if (!z.uuid().safeParse(id).success || !z.uuid().safeParse(docId).success) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })
  const doc = await getDocument(id, docId)
  if (!doc) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })
  const supabase = await createClient()
  const { data, error } = await supabase.storage.from('supplier-docs').createSignedUrl(doc.storage_path, 60, { download: doc.file_name })
  if (error || !data?.signedUrl) return NextResponse.json({ error: 'FILE_UNAVAILABLE' }, { status: 502 })
  return NextResponse.redirect(data.signedUrl, { status: 302, headers: { 'cache-control': 'no-store' } })
}
