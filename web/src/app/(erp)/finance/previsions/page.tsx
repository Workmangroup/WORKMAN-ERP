import type { Metadata } from 'next'
import Link from 'next/link'
import { Card, CardContent } from '@/components/ui/card'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { treasuryForecast, treasuryPosition } from '@/features/finance/services/finance.service'
import { formatMoney } from '@/lib/bom/options'
import { P } from '@/lib/rbac/permissions'
import { cn, formatDateTime } from '@/lib/utils'

export const metadata: Metadata = { title: 'Prévisions de trésorerie' }

const today = () => new Date().toISOString().slice(0, 10)

export default async function ForecastPage({ searchParams }: { searchParams: Promise<{ semaines?: string; taux?: string }> }) {
  await requirePermission(P.FINANCE_READ)
  const sp = await searchParams
  const weeks = Math.min(26, Math.max(1, Number.parseInt(sp.semaines ?? '13', 10) || 13))
  const pct = Math.min(100, Math.max(0, Number.parseFloat(sp.taux ?? '100') || 100))
  const from = today()
  const [start, rows] = await Promise.all([treasuryPosition(from), treasuryForecast(from, weeks, pct)])
  const minBalance = rows.reduce((m, r) => Math.min(m, r.projected_balance), start.balance)
  return (
    <>
      <PageHeader title="Prévisions de trésorerie" description="Encaissements attendus (soldes clients par échéance, retards dans la première semaine) et décaissements (factures fournisseurs non litigieuses), semaine par semaine." />
      <div className="space-y-4 p-4 sm:p-6">
        <form className="flex flex-wrap items-end gap-3 text-sm" action="/finance/previsions">
          <label className="flex flex-col gap-1">Horizon (semaines)<input name="semaines" type="number" min={1} max={26} defaultValue={weeks} className="w-28 rounded-md border border-line-strong px-2 py-1" /></label>
          <label className="flex flex-col gap-1">Taux d’encaissement (%)<input name="taux" type="number" min={0} max={100} defaultValue={pct} className="w-32 rounded-md border border-line-strong px-2 py-1" /></label>
          <button type="submit" className="rounded-md border border-line-strong px-3 py-1.5">Recalculer</button>
          <span className="text-ink-soft">Trésorerie de départ : <span className="font-semibold tabular-nums">{formatMoney(start.balance)}</span></span>
          <span className={cn('text-ink-soft', minBalance < 0 && 'font-semibold text-danger-text')}>Point bas prévu : <span className="tabular-nums">{formatMoney(minBalance)}</span></span>
        </form>
        <div className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
          <table className="w-full min-w-[40rem] text-sm">
            <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Semaine</th><th className="px-2 py-2 text-right font-semibold">Encaissements</th><th className="px-2 py-2 text-right font-semibold">Décaissements</th><th className="px-2 py-2 text-right font-semibold">Net</th><th className="px-2 py-2 text-right font-semibold">Solde prévu</th></tr></thead>
            <tbody className="divide-y divide-line">{rows.map((r) => (
              <tr key={r.week_no} className={cn(r.projected_balance < 0 && 'bg-danger-bg')}>
                <td className="px-4 py-2">S{r.week_no} · {formatDateTime(r.week_start)}</td>
                <td className="px-2 py-2 text-right tabular-nums text-success-text">{formatMoney(r.receipts)}</td>
                <td className="px-2 py-2 text-right tabular-nums text-danger-text">{formatMoney(r.payments)}</td>
                <td className={cn('px-2 py-2 text-right tabular-nums', r.net < 0 && 'text-danger-text')}>{formatMoney(r.net)}</td>
                <td className={cn('px-2 py-2 text-right font-semibold tabular-nums', r.projected_balance < 0 && 'text-danger-text')}>{formatMoney(r.projected_balance)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        <Card><CardContent className="p-4 text-xs text-ink-soft">
          Les prévisions reprennent les soldes ouverts à la date du jour. Elles ne tiennent pas compte des encaissements ni des règlements futurs non encore saisis. <Link href="/finance/balances" className="text-brand-700 hover:underline">Voir les balances âgées</Link>.
        </CardContent></Card>
      </div>
    </>
  )
}
