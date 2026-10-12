import type { Metadata } from 'next'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { WorkCenterDialog } from '@/features/production/components/production-forms'
import { listWorkCenters } from '@/features/production/services/production.service'
import { kindLabel } from '@/lib/production/options'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Postes de travail' }

export default async function WorkCentersPage() {
  const ctx = await requirePermission(P.PRODUCTION_READ)
  const rows = await listWorkCenters()
  const canPlan = ctx.permissions.includes(P.PRODUCTION_PLAN)
  return (
    <>
      <PageHeader title="Postes de travail" description="Capacité (heures par jour) et rendement de référence : base du calcul de la charge atelier."
        actions={canPlan && <WorkCenterDialog />} />
      <div className="space-y-4 p-4 sm:p-6">
        {rows.length === 0 ? (
          <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">Aucun poste de travail.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
            <table className="w-full min-w-[32rem] text-sm">
              <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Code</th><th className="px-2 py-2 font-semibold">Nom</th><th className="px-2 py-2 font-semibold">Type</th><th className="px-2 py-2 text-right font-semibold">Heures / jour</th><th className="px-2 py-2 text-right font-semibold">Rendement</th><th className="px-2 py-2 font-semibold">État</th></tr></thead>
              <tbody className="divide-y divide-line">{rows.map((w) => (
                <tr key={w.id}><td className="px-4 py-2 font-mono text-xs">{w.code}</td><td className="px-2 py-2">{w.name}</td><td className="px-2 py-2">{kindLabel(w.kind)}</td><td className="px-2 py-2 text-right tabular-nums">{w.hours_per_day}</td><td className="px-2 py-2 text-right tabular-nums">{w.efficiency_pct} %</td><td className="px-2 py-2">{w.active ? <Badge tone="success">Actif</Badge> : <Badge tone="neutral">Inactif</Badge>}</td></tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}
