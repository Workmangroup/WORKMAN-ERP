import type { Metadata } from 'next'
import Link from 'next/link'
import { Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { RunDialog } from '@/features/mrp/components/run-dialog'
import { deleteRunAction } from '@/features/mrp/actions'
import { listRuns } from '@/features/mrp/services/mrp.service'
import { RpcButton } from '@/features/stock/components/rpc-button'
import { P } from '@/lib/rbac/permissions'
import { formatDateTime } from '@/lib/utils'

export const metadata: Metadata = { title: 'Simulations MRP' }

export default async function RunsPage() {
  const ctx = await requirePermission(P.MRP_READ)
  const canWrite = ctx.permissions.includes(P.MRP_WRITE)
  const runs = await listRuns()
  return (
    <>
      <PageHeader title="Simulations MRP" description="Chaque simulation est figée : comparez des hypothèses (prévisions, brouillons, délais) sans toucher au stock ni aux commandes." actions={canWrite && <RunDialog />} />
      <div className="p-4 sm:p-6">
        {runs.length === 0 ? <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">Aucune simulation.</p> : (
          <div className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
            <table className="w-full min-w-[52rem] text-sm">
              <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Simulation</th><th className="px-2 py-2 font-semibold">Date</th><th className="px-2 py-2 font-semibold">Hypothèses</th><th className="px-2 py-2 font-semibold">Alertes</th><th className="px-2 py-2 text-right font-semibold">Suggestions</th>{canWrite && <th className="w-16 px-4 py-2" />}</tr></thead>
              <tbody className="divide-y divide-line">
                {runs.map((r) => (
                  <tr key={r.id} className="align-top">
                    <td className="px-4 py-2"><Link href={`/mrp/runs/${r.id}`} className="font-semibold text-brand-700 hover:underline"><span className="font-mono">{r.code}</span> — {r.name}</Link></td>
                    <td className="whitespace-nowrap px-2 py-2 text-xs text-ink-soft">{formatDateTime(r.created_at)}</td>
                    <td className="px-2 py-2 text-xs text-ink-soft">{r.params.horizon_days} j · prod. {r.params.offset_days} j{r.params.include_forecasts ? ' · prévisions' : ''}{r.params.include_draft_orders ? ' · brouillons' : ''}{r.params.use_safety ? '' : ' · sans sécurité'}</td>
                    <td className="px-2 py-2"><span className="flex flex-wrap gap-1">{r.summary.critical > 0 && <Badge tone="danger">{r.summary.critical} imminente(s)</Badge>}{r.summary.high > 0 && <Badge tone="warning">{r.summary.high} prévue(s)</Badge>}{r.summary.low > 0 && <Badge tone="brand">{r.summary.low} sécurité</Badge>}{r.summary.critical + r.summary.high + r.summary.low === 0 && <Badge tone="success">Aucune</Badge>}</span></td>
                    <td className="px-2 py-2 text-right tabular-nums">{r.summary.suggestions}</td>
                    {canWrite && <td className="px-4 py-2 text-right"><RpcButton action={deleteRunAction} fields={{ id: r.id }} variant="ghost" size="sm" confirm={`Supprimer la simulation ${r.code} ?`} aria-label={`Supprimer ${r.code}`}><Trash2 className="h-4 w-4 text-danger-text" /></RpcButton></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}
