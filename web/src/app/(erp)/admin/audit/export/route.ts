import { NextResponse, type NextRequest } from 'next/server'
import { getAuthContext } from '@/features/auth/services/access.service'
import { auditToCsv, exportAuditRows } from '@/features/rbac/services/audit-query.service'
import { P } from '@/lib/rbac/permissions'

export const dynamic = 'force-dynamic'

/**
 * Export auditeur CSV (IP et navigateur inclus, 5 000 lignes max). Exige audit.export ; la base journalise l'export.
 * Les refus de la base (droit absent) remontent en 403, sans détail technique.
 */
export async function GET(request: NextRequest) {
  const ctx = await getAuthContext()
  if (!ctx) return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 })
  if (!ctx.permissions.includes(P.AUDIT_EXPORT)) return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 })

  const sp = request.nextUrl.searchParams
  let rows
  try {
    rows = await exportAuditRows({ scope: sp.get('scope') ?? undefined, from: sp.get('from') ?? undefined, to: sp.get('to') ?? undefined })
  } catch {
    return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 })
  }
  const stamp = new Date().toISOString().slice(0, 10)
  return new NextResponse(auditToCsv(rows), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="audit-auditeur-${stamp}.csv"`,
      'cache-control': 'no-store',
    },
  })
}
