import { NextResponse, type NextRequest } from 'next/server'
import { getAuthContext } from '@/features/auth/services/access.service'
import { auditToCsv, queryAudit } from '@/features/rbac/services/audit-query.service'
import { P } from '@/lib/rbac/permissions'

export const dynamic = 'force-dynamic'

/** Export CSV du journal d'audit (mêmes filtres que la page, 5 000 lignes max). Exige audit.read. */
export async function GET(request: NextRequest) {
  const ctx = await getAuthContext()
  if (!ctx) return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 })
  if (!ctx.permissions.includes(P.AUDIT_READ)) return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 })

  const sp = request.nextUrl.searchParams
  const { rows } = await queryAudit(
    { scope: sp.get('scope') ?? undefined, actor: sp.get('actor') ?? undefined, from: sp.get('from') ?? undefined, to: sp.get('to') ?? undefined },
    { all: true },
  )
  const stamp = new Date().toISOString().slice(0, 10)
  return new NextResponse(auditToCsv(rows), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="audit-${stamp}.csv"`,
      'cache-control': 'no-store',
    },
  })
}
