import type { Metadata } from 'next'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { NewPlanDialog, PlanButtons } from '@/features/quality/components/quality-forms'
import { listActions, listPlans } from '@/features/quality/services/quality.service'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Plans d’actions qualité' }

const STATUS: Record<string, { label: string; tone: 'neutral' | 'brand' | 'success' }> = {
  draft: { label: 'Brouillon', tone: 'neutral' }, active: { label: 'Actif', tone: 'brand' }, closed: { label: 'Clos', tone: 'success' },
}

export default async function PlansPage() {
  const ctx = await requirePermission(P.QUALITY_READ)
  const canWrite = ctx.permissions.includes(P.QUALITY_WRITE)
  const [plans, actions] = await Promise.all([listPlans(), listActions({})])
  return (
    <>
      <PageHeader title="Plans d’actions" description="Un plan regroupe des actions correctives ou préventives. Il se clôt lorsque toutes ses actions sont vérifiées ou annulées."
        actions={canWrite && <NewPlanDialog />} />
      <div className="space-y-4 p-4 sm:p-6">
        {plans.length === 0 ? (
          <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">Aucun plan d’actions.</p>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {plans.map((p) => {
              const mine = actions.filter((a) => a.plan_id === p.id)
              const done = mine.filter((a) => a.status === 'verified' || a.status === 'cancelled').length
              const pct = mine.length === 0 ? 0 : Math.round((100 * done) / mine.length)
              return (
                <div key={p.id} className="rounded-md border border-line bg-white p-4 shadow-card">
                  <div className="flex items-start justify-between gap-3">
                    <div><p className="font-mono text-xs text-ink-soft">{p.number}</p><p className="font-semibold">{p.title}</p></div>
                    <Badge tone={STATUS[p.status]?.tone ?? 'neutral'}>{STATUS[p.status]?.label ?? p.status}</Badge>
                  </div>
                  {p.objective && <p className="mt-2 text-sm text-ink-soft">{p.objective}</p>}
                  <p className="mt-2 text-xs text-ink-soft">Du {p.start_date} au {p.target_date} · {mine.length} action(s) · avancement {pct} %</p>
                  <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-canvas"><div className="h-full bg-brand-500" style={{ width: `${pct}%` }} /></div>
                  {canWrite && p.status !== 'closed' && <div className="mt-3"><PlanButtons id={p.id} status={p.status} /></div>}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </>
  )
}
