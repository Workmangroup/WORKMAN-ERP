import type { Metadata } from 'next'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { getDashboard } from '@/features/finance/services/finance.service'
import { formatMoney } from '@/lib/bom/options'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Finance' }

export default async function FinanceDashboardPage() {
  await requirePermission(P.FINANCE_READ)
  const d = await getDashboard()
  const kpis = [
    { label: 'Trésorerie', value: formatMoney(d.treasury?.balance ?? 0) },
    { label: 'Créances clients', value: formatMoney(d.receivables ?? 0) },
    { label: 'Créances échues', value: formatMoney(d.receivables_overdue ?? 0), tone: (d.receivables_overdue ?? 0) > 0 ? 'text-danger-text' : '' },
    { label: 'DSO (jours)', value: d.dso_days === null || d.dso_days === undefined ? '—' : `${Number(d.dso_days).toLocaleString('fr-FR')} j` },
    { label: 'Dettes fournisseurs', value: formatMoney(d.payables ?? 0) },
    { label: 'Dettes à échoir sous 14 j', value: formatMoney(d.payables_due_14d ?? 0) },
    { label: 'Fournisseurs en litige', value: formatMoney(d.payables_disputed ?? 0), tone: (d.payables_disputed ?? 0) > 0 ? 'text-warn-text' : '' },
    { label: 'Prévision 4 semaines (net)', value: formatMoney(d.forecast_4w_net ?? 0), tone: (d.forecast_4w_net ?? 0) < 0 ? 'text-danger-text' : '' },
    { label: 'Relances en attente', value: String(d.reminders_pending ?? 0) },
  ]
  return (
    <>
      <PageHeader title="Tableau de bord financier" description="Trésorerie, créances et dettes, délais de paiement et prévisions, calculés à partir des factures, règlements et mouvements." />
      <div className="space-y-4 p-4 sm:p-6">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          {kpis.map((k) => (
            <Card key={k.label}><CardContent className="p-4"><p className="text-xs text-ink-soft">{k.label}</p><p className={`mt-1 text-lg font-semibold tabular-nums ${k.tone ?? ''}`}>{k.value}</p></CardContent></Card>
          ))}
        </div>
        <Card>
          <CardHeader><CardTitle>Principaux clients en retard</CardTitle></CardHeader>
          <CardContent className="p-0">
            {(d.top_overdue_clients ?? []).length === 0 ? <p className="p-6 text-sm text-ink-soft">Aucun retard de paiement.</p> : (
              <ul className="divide-y divide-line">{(d.top_overdue_clients ?? []).map((c) => (
                <li key={c.client} className="flex justify-between px-4 py-2 text-sm"><span>{c.client}</span><span className="font-semibold text-danger-text tabular-nums">{formatMoney(c.overdue)}</span></li>
              ))}</ul>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  )
}
