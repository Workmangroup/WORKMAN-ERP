import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { getAuthContext } from '@/features/auth/services/access.service'
import { logAccessDenied } from '@/features/rbac/services/audit-write.service'
import { buildQuotePdf, type QuoteDocSnapshot } from '@/lib/pdf/quote-pdf'
import { P } from '@/lib/rbac/permissions'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

/**
 * PDF d'un devis : version courante, ou version historisée avec ?seq=N.
 * Le contenu vient de quote_document (RLS et droits côté base) ; l'accès est refusé par défaut.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getAuthContext()
  if (!ctx) return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 })
  if (!ctx.permissions.includes(P.QUOTES_READ)) {
    await logAccessDenied(ctx, P.QUOTES_READ, { via: 'route', route: 'quote-pdf' })
    return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 })
  }
  const { id } = await params
  if (!z.uuid().safeParse(id).success) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })

  const rawSeq = request.nextUrl.searchParams.get('seq')
  const seq = rawSeq === null ? null : z.coerce.number().int().min(1).safeParse(rawSeq)
  if (seq !== null && !seq.success) return NextResponse.json({ error: 'BAD_VERSION' }, { status: 400 })

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('quote_document', { p_quote: id, p_seq: seq === null ? null : seq.data })
  if (error || !data) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })

  const doc = data as { snapshot: QuoteDocSnapshot; seq: number | null; label: string; hash: string }
  const party = await partyName(supabase, id)
  const pdf = buildQuotePdf({ ...doc, party })
  const file = doc.snapshot.code.replace(/[^A-Za-z0-9_-]/g, '') || 'devis'
  const suffix = doc.seq === null ? '' : `-v${doc.seq}`
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="${file}${suffix}.pdf"`,
      'cache-control': 'no-store',
    },
  })
}

/** Nom du client ou du prospect, lu sous RLS : une ligne absente donne un libellé neutre. */
async function partyName(supabase: Awaited<ReturnType<typeof createClient>>, quoteId: string): Promise<string> {
  const { data: q } = await supabase.from('quotes').select('client_id,prospect_id').eq('id', quoteId).maybeSingle()
  if (q?.client_id) {
    const { data } = await supabase.from('clients').select('name').eq('id', q.client_id as string).maybeSingle()
    if (data?.name) return String(data.name)
  }
  if (q?.prospect_id) {
    const { data } = await supabase.from('prospects').select('company_name').eq('id', q.prospect_id as string).maybeSingle()
    if (data?.company_name) return `${data.company_name} (prospect)`
  }
  return 'Client'
}
