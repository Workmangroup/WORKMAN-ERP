import type { Metadata } from 'next'
import Link from 'next/link'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { getDashboard } from '@/features/production/services/production.service'
import { ORDER_STATUS, orderStatusLabel } from '@/lib/production/options'
import { P } from '@/lib/rbac/permissions'
import { formatDateTime } from '@/lib/utils'

export const metadata: Metadata = { title: 'Production' }

const pct = (v: number | null) => (v === null ? '—' : `${v.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %`)
const num = (v: number | null, unit: string) => (v === null ? '—' : `${v.toLocaleString('fr-FR', { maximumFractionDigits: 2 })} ${unit}`)

export default async function ProductionDashboardPage() {
  await requirePermission(P.PRODUCTION_READ)
  const d = await getDashboard()
  const kpis = [
    { label: 'Ordres ouverts', value: String(d.open) },
    { label: 'En retard', value: String(d.late), tone: d.late > 0 ? 'text-danger-text' : '' },
    { label: 'Rendement global', value: pct(d.yield_pct) },
    { label: 'Productivité', value: num(d.productivity, 'pièces / h') },
    { label: 'Ordres clôturés', value: String(d.closed) },
  ]
  return (
    <>
      <PageHeader title="Production" description="Charge atelier, rendement, productivité et retards, calculés à partir des ordres et du suivi saisi." />
      <div className="space-y-4 p-4 sm:p-6">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          {kpis.map((k) => (
            <Card key={k.label}><CardContent className="p-4"><p className="text-xs text-ink-soft">{k.label}</p><p className={`mt-1 text-xl font-semibold tabular-nums ${k.tone ?? ''}`}>{k.value}</p></CardContent></Card>
          ))}
        </div>
        <div className="flex flex-wrap gap-2 text-sm">
          {Object.entries(ORDER_STATUS).map(([s, meta]) => (
            <Link key={s} href={`/production/ordres?statut=${s}`}><Badge tone={meta.tone}>{meta.label} : {d.by_status[s] ?? 0}</Badge></Link>
          ))}
        </div>

        <Card>
          <CardHeader><CardTitle>Charge atelier</CardTitle></CardHeader>
          <CardContent className="p-0">
            {d.workload.length === 0 ? <p className="p-6 text-sm text-ink-soft">Aucun poste actif. Créez des postes de travail pour voir la charge.</p> : (
              <div className="overflow-x-auto"><table className="w-full min-w-[46rem] text-sm">
                <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr>
                  <th className="px-4 py-2 font-semibold">Poste</th><th className="px-2 py-2 text-right font-semibold">Heures ouvertes</th><th className="px-2 py-2 text-right font-semibold">Capacité / jour</th><th className="px-2 py-2 text-right font-semibold">Charge</th><th className="px-2 py-2 text-right font-semibold">Rendement</th><th className="px-2 py-2 text-right font-semibold">Productivité</th>
                </tr></thead>
                <tbody className="divide-y divide-line">{d.workload.map((w) => (
                  <tr key={w.work_center_id}>
                    <td className="px-4 py-2"><span className="font-mono text-xs">{w.code}</span> {w.name}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{w.open_hours.toLocaleString('fr-FR')} h</td>
                    <td className="px-2 py-2 text-right tabular-nums">{w.capacity_hours_per_day.toLocaleString('fr-FR')} h</td>
                    <td className="px-2 py-2 text-right tabular-nums">{w.load_days === null ? '—' : `${w.load_days.toLocaleString('fr-FR')} j`} {w.overloaded && <Badge tone="danger">Surchargé</Badge>}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{pct(w.yield_pct)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{num(w.productivity, 'pc/h')}</td>
                  </tr>))}</tbody>
              </table></div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Retards</CardTitle></CardHeader>
          <CardContent className="p-0">
            {d.late_orders.length === 0 ? <p className="p-6 text-sm text-ink-soft">Aucun ordre en retard.</p> : (
              <div className="overflow-x-auto"><table className="w-full min-w-[40rem] text-sm">
                <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Ordre</th><th className="px-2 py-2 font-semibold">Article</th><th className="px-2 py-2 font-semibold">Statut</th><th className="px-2 py-2 font-semibold">Poste</th><th className="px-2 py-2 font-semibold">Fin prévue</th><th className="px-2 py-2 text-right font-semibold">Retard</th></tr></thead>
                <tbody className="divide-y divide-line">{d.late_orders.map((o) => (
                  <tr key={o.id}>
                    <td className="px-4 py-2"><Link href={`/production/ordres/${o.id}`} className="font-mono text-xs text-brand-700 hover:underline">{o.number}</Link></td>
                    <td className="px-2 py-2">{o.article}</td>
                    <td className="px-2 py-2">{orderStatusLabel(o.status)}</td>
                    <td className="px-2 py-2">{o.work_center ?? '—'}</td>
                    <td className="px-2 py-2 text-xs text-ink-soft">{formatDateTime(o.planned_end)}</td>
                    <td className="px-2 py-2 text-right font-semibold text-danger-text tabular-nums">{o.late_days} j</td>
                  </tr>))}</tbody>
              </table></div>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  )
}
