import type { Metadata } from 'next'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { NewShipmentDialog } from '@/features/shipping/components/shipping-forms'
import { confirmedOrderOptions, ordersToPrepare, warehouseOptions } from '@/features/shipping/services/shipping.service'
import { P } from '@/lib/rbac/permissions'
import { formatDateTime } from '@/lib/utils'

export const metadata: Metadata = { title: 'Préparation des commandes' }

export default async function PreparationPage() {
  const ctx = await requirePermission(P.SHIPMENTS_READ)
  const canWrite = ctx.permissions.includes(P.SHIPMENTS_WRITE)
  const [todo, orders, warehouses] = await Promise.all([
    ordersToPrepare(), canWrite ? confirmedOrderOptions() : Promise.resolve([]), canWrite ? warehouseOptions() : Promise.resolve([]),
  ])
  return (
    <>
      <PageHeader title="Préparation des commandes" description="Commandes confirmées qui restent à expédier, avec leur taux d’affectation."
        actions={canWrite && <NewShipmentDialog orders={orders} warehouses={warehouses} />} />
      <div className="space-y-4 p-4 sm:p-6">
        {todo.length === 0 ? (
          <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">Toutes les commandes confirmées sont affectées.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
            <table className="w-full min-w-[40rem] text-sm">
              <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Commande</th><th className="px-2 py-2 font-semibold">Client</th><th className="px-2 py-2 text-right font-semibold">Affecté / commandé</th><th className="px-2 py-2 font-semibold">Affectation</th><th className="px-2 py-2 font-semibold">Échéance</th></tr></thead>
              <tbody className="divide-y divide-line">{todo.map((o) => {
                const pct = o.ordered === 0 ? 0 : Math.round((100 * o.allocated) / o.ordered)
                return (
                  <tr key={o.id}>
                    <td className="px-4 py-2 font-mono text-xs">{o.code}</td>
                    <td className="px-2 py-2">{o.client}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{o.allocated} / {o.ordered}</td>
                    <td className="px-2 py-2"><div className="h-1.5 w-32 overflow-hidden rounded-full bg-canvas"><div className="h-full bg-brand-500" style={{ width: `${pct}%` }} /></div></td>
                    <td className="px-2 py-2 text-xs text-ink-soft">{o.due ? formatDateTime(o.due) : '—'}</td>
                  </tr>
                )
              })}</tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}
