import type { Metadata } from 'next'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { AlertsList } from '@/features/development/components/alerts-list'
import { DueBadge, RemindButton } from '@/features/development/components/validations-panel'
import { getAlerts, pendingValidations } from '@/features/development/services/development.service'
import { VALIDATION_KIND } from '@/lib/development/options'
import { fmtDay } from '@/features/orders/status'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Validations et alertes — Développement produit' }

export default async function ValidationsPage() {
  const ctx = await requirePermission(P.DEVELOPMENT_READ)
  const [alerts, pending] = await Promise.all([getAlerts(), pendingValidations()])
  const canWrite = ctx.permissions.includes(P.DEVELOPMENT_WRITE)
  return (
    <>
      <PageHeader title="Validations et alertes" description="Réponses du client attendues (échantillons, BAT), retards de projet, prototypes et échantillons. Relancez le client depuis cette page." />
      <div className="space-y-6 p-4 sm:p-6">
        <section aria-labelledby="al" className="space-y-2">
          <h2 id="al" className="text-base font-semibold">Alertes <span className="text-sm font-normal text-ink-soft">({alerts.length})</span></h2>
          <AlertsList alerts={alerts} canWrite={canWrite} />
        </section>
        <section aria-labelledby="pv" className="space-y-2">
          <h2 id="pv" className="text-base font-semibold">Validations en attente du client <span className="text-sm font-normal text-ink-soft">({pending.length})</span></h2>
          {pending.length === 0 ? <p className="rounded-md border border-dashed border-line-strong bg-white p-8 text-center text-sm text-ink-soft">Aucune validation en attente.</p> : (
            <div className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
              <table className="w-full min-w-[48rem] text-sm">
                <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Projet</th><th className="px-2 py-2 font-semibold">Client</th><th className="px-2 py-2 font-semibold">Élément</th><th className="px-2 py-2 font-semibold">Soumis le</th><th className="px-2 py-2 font-semibold">Réponse attendue</th><th className="px-2 py-2 font-semibold">Relances</th>{canWrite && <th className="px-2 py-2" />}</tr></thead>
                <tbody className="divide-y divide-line">
                  {pending.map((v) => (
                    <tr key={v.id}>
                      <td className="px-4 py-2"><Link href={`/development/projects/${v.project_id}?tab=validations`} className="font-semibold text-brand-700 hover:underline"><span className="font-mono text-xs">{v.code}</span> {v.name}</Link></td>
                      <td className="px-2 py-2">{v.client_name}</td>
                      <td className="px-2 py-2"><Badge tone="brand">{VALIDATION_KIND[v.kind]} v{v.version_no}</Badge></td>
                      <td className="whitespace-nowrap px-2 py-2">{fmtDay(v.submitted_on)}</td>
                      <td className="px-2 py-2">{v.due_date ? <><span className="mr-1">{fmtDay(v.due_date)}</span><DueBadge due={v.due_date} /></> : <span className="text-ink-faint">sans échéance</span>}</td>
                      <td className="px-2 py-2 text-ink-soft">{v.reminder_count}{v.last_reminder_on ? ` (le ${fmtDay(v.last_reminder_on)})` : ''}</td>
                      {canWrite && <td className="px-2 py-2 text-right"><RemindButton id={v.id} projectId={v.project_id} /></td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </>
  )
}
