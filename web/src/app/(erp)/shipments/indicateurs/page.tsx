import type { Metadata } from 'next'
import { Card, CardContent } from '@/components/ui/card'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { getDashboard } from '@/features/shipping/services/shipping.service'
import { formatMoney } from '@/lib/bom/options'
import { ORDER_STATUS_LABEL } from '@/lib/shipping/options'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Indicateurs logistiques' }

const pct = (v: number | null) => (v === null ? '—' : `${v.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %`)
const num = (v: number | null, unit: string) => (v === null ? '—' : `${v.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} ${unit}`)

export default async function ShippingIndicatorsPage() {
  await requirePermission(P.SHIPMENTS_READ)
  const d = await getDashboard()
  const kpis = [
    { label: 'Livraisons à temps', value: pct(d.on_time_pct) },
    { label: 'Taux de remplissage', value: pct(d.fill_rate_pct) },
    { label: 'Délai moyen de préparation', value: num(d.avg_lead_time_days, 'j') },
    { label: 'Expéditions ouvertes', value: String(d.open ?? 0) },
    { label: 'Ouvertes en retard', value: String(d.late_open ?? 0), tone: (d.late_open ?? 0) > 0 ? 'text-danger-text' : '' },
    { label: 'Colis expédiés', value: String(d.packages_total ?? 0) },
    { label: 'Poids brut moyen', value: num(d.avg_gross_kg_per_shipment, 'kg') },
    { label: 'Incidents non résolus', value: String(d.exceptions_open ?? 0), tone: (d.exceptions_open ?? 0) > 0 ? 'text-danger-text' : '' },
    { label: 'Factures export', value: String(d.exports_invoiced ?? 0) },
    { label: 'Montant export', value: formatMoney(d.export_total ?? 0) },
  ]
  const statuses = Object.entries(d.by_status ?? {})
  return (
    <>
      <PageHeader title="Indicateurs logistiques" description="Respect des délais, remplissage des commandes, délais de préparation, colisage, incidents et facturation export." />
      <div className="space-y-4 p-4 sm:p-6">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          {kpis.map((k) => (
            <Card key={k.label}><CardContent className="p-4"><p className="text-xs text-ink-soft">{k.label}</p><p className={`mt-1 text-xl font-semibold tabular-nums ${k.tone ?? ''}`}>{k.value}</p></CardContent></Card>
          ))}
        </div>
        <Card>
          <CardContent className="space-y-2 p-4 text-sm">
            <p className="font-semibold">Expéditions par statut</p>
            {statuses.length === 0 ? <p className="text-ink-soft">Aucune expédition.</p> : (
              <ul className="flex flex-wrap gap-3">{statuses.map(([s, n]) => <li key={s}>{ORDER_STATUS_LABEL[s] ?? s} : <span className="font-semibold">{n}</span></li>)}</ul>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  )
}
