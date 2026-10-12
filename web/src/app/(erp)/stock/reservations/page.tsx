import type { Metadata } from 'next'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { RpcButton } from '@/features/stock/components/rpc-button'
import { StockToolbar } from '@/features/stock/components/stock-toolbar'
import { releaseAction } from '@/features/stock/actions'
import { listReservations, stockContext } from '@/features/stock/services/stock.service'
import { formatQty, unitLabel } from '@/lib/bom/options'
import { RESERVATION_STATUS } from '@/lib/stock/options'
import { P } from '@/lib/rbac/permissions'
import { formatDateTime } from '@/lib/utils'

export const metadata: Metadata = { title: 'Réservations de stock' }

export default async function ReservationsPage({ searchParams }: { searchParams: Promise<{ state?: string }> }) {
  const ctx = await requirePermission(P.STOCK_READ)
  const sp = await searchParams
  const [rows, sc] = await Promise.all([listReservations({ state: sp.state }), stockContext(ctx.permissions)])
  const canWrite = ctx.permissions.includes(P.STOCK_WRITE)
  return (
    <>
      <PageHeader title="Réservations" description="Quantités bloquées pour un ordre de fabrication ou une commande : elles réduisent le disponible sans sortir du stock." />
      <div className="space-y-4 p-4 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <StockToolbar ctx={sc} />
          <div className="flex gap-3 text-sm">
            <Link href="/stock/reservations" className={sp.state !== 'all' ? 'font-semibold text-brand-700' : 'text-ink-soft hover:text-ink'}>Actives</Link>
            <Link href="/stock/reservations?state=all" className={sp.state === 'all' ? 'font-semibold text-brand-700' : 'text-ink-soft hover:text-ink'}>Toutes</Link>
          </div>
        </div>
        {rows.length === 0 ? <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">Aucune réservation.</p> : (
          <div className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
            <table className="w-full min-w-[46rem] text-sm">
              <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Référence</th><th className="px-2 py-2 font-semibold">Composant</th><th className="px-2 py-2 font-semibold">Entrepôt</th><th className="px-2 py-2 text-right font-semibold">Réservé</th><th className="px-2 py-2 text-right font-semibold">Consommé</th><th className="px-2 py-2 font-semibold">Statut</th><th className="px-2 py-2 font-semibold">Créée le</th>{canWrite && <th className="w-28 px-4 py-2" />}</tr></thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => (
                  <tr key={r.id} className="align-top">
                    <td className="px-4 py-2 font-medium">{r.reference}{r.note && <span className="block text-xs font-normal text-ink-soft">{r.note}</span>}</td>
                    <td className="px-2 py-2">{r.material_name}<span className="ml-2 font-mono text-xs text-ink-faint">{r.material_code}</span></td>
                    <td className="px-2 py-2 font-mono text-xs">{r.warehouse_code}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{formatQty(r.qty)} {unitLabel(r.unit)}</td>
                    <td className="px-2 py-2 text-right tabular-nums text-ink-soft">{formatQty(r.qty_consumed)}</td>
                    <td className="px-2 py-2"><Badge tone={RESERVATION_STATUS[r.status].tone}>{RESERVATION_STATUS[r.status].label}</Badge></td>
                    <td className="whitespace-nowrap px-2 py-2 text-xs text-ink-soft">{formatDateTime(r.created_at)}</td>
                    {canWrite && <td className="px-4 py-2 text-right">{r.status === 'active' && <RpcButton action={releaseAction} fields={{ id: r.id }} variant="secondary" size="sm" confirm="Libérer le reste de cette réservation ?">Libérer</RpcButton>}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}
