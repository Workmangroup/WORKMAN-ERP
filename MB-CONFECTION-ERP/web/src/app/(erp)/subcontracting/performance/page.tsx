import type { Metadata } from 'next'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { getPerformance } from '@/features/subcontracting/services/subcontracting.service'
import { serviceLabel } from '@/lib/subcontracting/options'
import { formatMoney } from '@/lib/bom/options'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Performance des sous-traitants' }

const pct = (v: number | null) => (v === null ? '—' : `${v} %`)
const days = (v: number | null) => (v === null ? '—' : `${v} j`)

export default async function PerformancePage() {
  const ctx = await requirePermission(P.SUBCONTRACT_READ)
  const rows = await getPerformance()
  const withCost = ctx.permissions.includes(P.SUBCONTRACT_COSTS) || ctx.permissions.includes(P.COSTS_READ)
  const scored = rows.filter((r) => r.delivered > 0)
  const best = [...scored].sort((a, b) => (b.on_time / b.delivered) - (a.on_time / a.delivered) || (a.rejection_rate ?? 0) - (b.rejection_rate ?? 0))[0]
  return (
    <>
      <PageHeader title="Performance et délais" description="Ponctualité, délai de traitement, qualité des retours et coût par pièce, par sous-traitant." />
      <div className="space-y-4 p-4 sm:p-6">
        {best && <p className="text-sm text-ink-soft">Meilleure ponctualité : <strong className="text-ink">{best.name}</strong> ({best.on_time} / {best.delivered} livrées à l’heure{best.rejection_rate !== null ? `, rejet ${best.rejection_rate} %` : ''}).</p>}
        {rows.length === 0 ? <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">Aucun sous-traitant.</p> : (
          <div className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
            <table className="w-full min-w-[60rem] text-sm">
              <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr>
                <th className="px-4 py-2 font-semibold">Sous-traitant</th><th className="px-2 py-2 font-semibold">Prestations</th><th className="px-2 py-2 text-right font-semibold">Commandes</th><th className="px-2 py-2 text-right font-semibold">Pièces reçues</th>
                <th className="px-2 py-2 text-right font-semibold">Ponctualité</th><th className="px-2 py-2 text-right font-semibold">Délai moyen</th><th className="px-2 py-2 text-right font-semibold">Retard moyen</th><th className="px-2 py-2 text-right font-semibold">Rejet</th>
                {withCost && <><th className="px-2 py-2 text-right font-semibold">Coût total</th><th className="px-2 py-2 text-right font-semibold">Coût / pièce</th></>}
              </tr></thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => {
                  const ot = r.delivered > 0 ? Math.round((1000 * r.on_time) / r.delivered) / 10 : null
                  return (
                    <tr key={r.id} className={r.active ? '' : 'text-ink-faint'}>
                      <td className="px-4 py-2"><span className="font-mono text-xs text-ink-soft">{r.code}</span><span className="block font-semibold">{r.name}</span>{!r.active && <Badge tone="neutral">Désactivé</Badge>}</td>
                      <td className="px-2 py-2"><span className="flex flex-wrap gap-1">{r.services.map((s) => <Badge key={s} tone="brand">{serviceLabel(s)}</Badge>)}</span></td>
                      <td className="px-2 py-2 text-right tabular-nums">{r.orders}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{r.qty_received}</td>
                      <td className={`px-2 py-2 text-right tabular-nums ${ot !== null && ot < 90 ? 'font-semibold text-warn-text' : ''}`}>{pct(ot)}<span className="block text-xs text-ink-faint">{r.on_time} / {r.delivered}</span></td>
                      <td className="px-2 py-2 text-right tabular-nums">{days(r.avg_lead_days)}<span className="block text-xs text-ink-faint">délai habituel {r.default_lead_days} j</span></td>
                      <td className={`px-2 py-2 text-right tabular-nums ${r.avg_delay_days && r.avg_delay_days > 0 ? 'text-warn-text' : ''}`}>{days(r.avg_delay_days)}</td>
                      <td className={`px-2 py-2 text-right tabular-nums ${r.rejection_rate !== null && r.rejection_rate > 5 ? 'font-semibold text-danger-text' : ''}`}>{pct(r.rejection_rate)}</td>
                      {withCost && <><td className="px-2 py-2 text-right tabular-nums">{r.cost_total === null ? '—' : formatMoney(r.cost_total)}</td><td className="px-2 py-2 text-right tabular-nums">{r.cost_per_piece === null ? '—' : formatMoney(r.cost_per_piece)}</td></>}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-ink-faint">Ponctualité : commandes reçues ou clôturées dont le dernier retour est à la date prévue ou avant. Délai moyen : de l’envoi à la clôture (ou au dernier retour). Rejet : pièces rejetées sur les pièces contrôlées.</p>
      </div>
    </>
  )
}
