import type { Metadata } from 'next'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { getDashboard } from '@/features/quality/services/quality.service'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Qualité' }

const KIND: Record<string, string> = { reception: 'Réception', production: 'Production', final: 'Final' }
const SEV: Record<string, string> = { minor: 'Mineure', major: 'Majeure', critical: 'Critique' }
const pct = (v: number | null) => (v === null ? '—' : `${v.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %`)

export default async function QualityDashboardPage() {
  await requirePermission(P.QUALITY_READ)
  const d = await getDashboard()
  const controls = d.controls ?? []
  const totalClosed = controls.reduce((s, c) => s + c.closed, 0)
  const totalAccepted = controls.reduce((s, c) => s + c.accepted, 0)
  const kpis = [
    { label: 'Contrôles ouverts', value: String(d.open_inspections ?? 0) },
    { label: 'Conformité au premier passage', value: pct(totalClosed ? (100 * totalAccepted) / totalClosed : null) },
    { label: 'Non-conformités ouvertes', value: String(d.nc_open ?? 0), tone: (d.nc_open ?? 0) > 0 ? 'text-danger-text' : '' },
    { label: 'Actions en retard', value: String(d.actions_overdue ?? 0), tone: (d.actions_overdue ?? 0) > 0 ? 'text-danger-text' : '' },
    { label: 'Efficacité des actions', value: pct(d.action_effectiveness_pct ?? null) },
  ]
  return (
    <>
      <PageHeader title="Qualité" description="Conformité des contrôles, défauts les plus fréquents, non-conformités et efficacité des actions correctives." />
      <div className="space-y-4 p-4 sm:p-6">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          {kpis.map((k) => (
            <Card key={k.label}><CardContent className="p-4"><p className="text-xs text-ink-soft">{k.label}</p><p className={`mt-1 text-xl font-semibold tabular-nums ${k.tone ?? ''}`}>{k.value}</p></CardContent></Card>
          ))}
        </div>

        <Card>
          <CardHeader><CardTitle>Contrôles par type</CardTitle></CardHeader>
          <CardContent className="p-0">
            {controls.length === 0 ? <p className="p-6 text-sm text-ink-soft">Aucun contrôle fermé.</p> : (
              <div className="overflow-x-auto"><table className="w-full min-w-[40rem] text-sm">
                <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Type</th><th className="px-2 py-2 text-right font-semibold">Fermés</th><th className="px-2 py-2 text-right font-semibold">Acceptés</th><th className="px-2 py-2 text-right font-semibold">Sous réserve</th><th className="px-2 py-2 text-right font-semibold">Rejetés</th><th className="px-2 py-2 text-right font-semibold">Premier passage</th><th className="px-2 py-2 text-right font-semibold">Défauts par unité</th></tr></thead>
                <tbody className="divide-y divide-line">{controls.map((c) => (
                  <tr key={c.kind}><td className="px-4 py-2">{KIND[c.kind] ?? c.kind}</td><td className="px-2 py-2 text-right tabular-nums">{c.closed}</td><td className="px-2 py-2 text-right tabular-nums">{c.accepted}</td><td className="px-2 py-2 text-right tabular-nums">{c.conditional}</td><td className="px-2 py-2 text-right tabular-nums">{c.rejected}</td><td className="px-2 py-2 text-right tabular-nums">{pct(c.first_pass_pct)}</td><td className="px-2 py-2 text-right tabular-nums">{c.defects_per_unit ?? '—'}</td></tr>
                ))}</tbody>
              </table></div>
            )}
          </CardContent>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader><CardTitle>Défauts les plus fréquents</CardTitle></CardHeader>
            <CardContent className="p-0">
              {(d.pareto ?? []).length === 0 ? <p className="p-6 text-sm text-ink-soft">Aucun défaut constaté.</p> : (
                <ul className="divide-y divide-line">{(d.pareto ?? []).map((p) => (
                  <li key={p.code} className="flex items-center justify-between gap-3 px-4 py-2 text-sm"><span><span className="font-mono text-xs">{p.code}</span> {p.label ?? ''} <span className="text-xs text-ink-faint">{p.category}</span></span><span className="font-semibold tabular-nums">{Number(p.qty)}</span></li>
                ))}</ul>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Non-conformités ouvertes par gravité</CardTitle></CardHeader>
            <CardContent>
              {Object.keys(d.nc_by_severity ?? {}).length === 0 ? <p className="text-sm text-ink-soft">Aucune non-conformité ouverte.</p> : (
                <div className="flex flex-wrap gap-2">{Object.entries(d.nc_by_severity ?? {}).map(([s, n]) => (
                  <Badge key={s} tone={s === 'critical' ? 'danger' : s === 'major' ? 'warning' : 'neutral'}>{SEV[s] ?? s} : {n}</Badge>
                ))}</div>
              )}
              <p className="mt-4 text-sm text-ink-soft">Plans d’actions : {Object.entries(d.plans ?? {}).map(([s, n]) => `${s} ${n}`).join(' · ') || 'aucun'}</p>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  )
}
