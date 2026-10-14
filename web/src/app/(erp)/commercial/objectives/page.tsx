import type { Metadata } from 'next'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { ActionForm } from '@/features/commercial/components/crm-forms'
import { objectiveCreateAction } from '@/features/commercial/crm-actions'
import { clientsForObjectives, listObjectives } from '@/features/commercial/services/objectives.service'
import { fmtDay, money } from '@/features/commercial/status'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Objectifs commerciaux' }

const inputCls = 'rounded-md border border-line bg-white px-3 py-2 text-sm'

export default async function ObjectivesPage() {
  const ctx = await requirePermission(P.OBJECTIVES_READ)
  const canWrite = ctx.permissions.includes(P.OBJECTIVES_WRITE)
  const [rows, clients] = await Promise.all([listObjectives(), canWrite ? clientsForObjectives() : Promise.resolve([])])
  return (
    <>
      <PageHeader title="Objectifs commerciaux" description="Chaque objectif est daté, exprimé en devise de base et comparé au CA de même périmètre et de même période (factures émises moins avoirs émis, taux validés)." />
      <div className="space-y-4 p-4 sm:p-6">
        {canWrite && (
          <section className="rounded-md border border-line bg-white p-4 shadow-card">
            <h2 className="text-sm font-semibold">Nouvel objectif</h2>
            <div className="mt-3">
              <ActionForm action={objectiveCreateAction} submit="Enregistrer l’objectif">
                <label className="grid gap-1 text-sm">Périmètre
                  <select name="scope" required className={inputCls}><option value="company">Société entière</option><option value="client">Un client</option></select>
                </label>
                <label className="grid gap-1 text-sm">Client (si périmètre « client »)
                  <select name="client_id" className={inputCls}><option value="">—</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
                </label>
                <label className="grid gap-1 text-sm">Libellé<input name="label" required minLength={2} maxLength={120} className={inputCls} /></label>
                <label className="grid gap-1 text-sm">Montant cible (devise de base)<input name="target" required inputMode="decimal" className={inputCls} /></label>
                <label className="grid gap-1 text-sm">Début de période<input type="date" name="period_start" required className={inputCls} /></label>
                <label className="grid gap-1 text-sm">Fin de période<input type="date" name="period_end" required className={inputCls} /></label>
              </ActionForm>
            </div>
          </section>
        )}
        {rows.length === 0 ? (
          <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">Aucun objectif.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
            <table className="w-full min-w-[48rem] text-sm">
              <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr>
                <th className="px-4 py-2 font-semibold">Objectif</th><th className="px-2 py-2 font-semibold">Périmètre</th><th className="px-2 py-2 font-semibold">Période</th>
                <th className="px-2 py-2 text-right font-semibold">Cible</th><th className="px-2 py-2 text-right font-semibold">CA réalisé (HT)</th><th className="px-2 py-2 text-right font-semibold">Atteinte</th>
              </tr></thead>
              <tbody className="divide-y divide-line">
                {rows.map((o) => {
                  const base = o.currency
                  const caVisible = o.realised_net_ht !== null
                  return (
                    <tr key={o.objective_id}>
                      <td className="px-4 py-2 font-semibold">{o.label}</td>
                      <td className="px-2 py-2">{o.scope === 'client' ? o.client_name ?? '—' : 'Société entière'}</td>
                      <td className="whitespace-nowrap px-2 py-2">{fmtDay(o.period_start)} → {fmtDay(o.period_end)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{money(o.target, base)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {caVisible ? money(o.realised_net_ht as number, base) : <span className="text-xs text-ink-soft">non visible (droit factures)</span>}
                        {caVisible && (o.excluded_no_rate ?? 0) > 0 && <span className="block text-xs text-warning-text">{o.excluded_no_rate} facture(s) sans taux validé exclue(s)</span>}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">{caVisible && o.percent !== null ? `${o.percent} %` : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}
