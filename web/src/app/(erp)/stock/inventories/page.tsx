import type { Metadata } from 'next'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { NewInventory } from '@/features/stock/components/inventory-components'
import { listInventories, listWarehouses } from '@/features/stock/services/stock.service'
import { INVENTORY_STATUS } from '@/lib/stock/options'
import { P } from '@/lib/rbac/permissions'
import { formatDateTime } from '@/lib/utils'

export const metadata: Metadata = { title: 'Inventaires' }

export default async function InventoriesPage() {
  const ctx = await requirePermission(P.STOCK_READ)
  const [rows, warehouses] = await Promise.all([listInventories(), listWarehouses()])
  return (
    <>
      <PageHeader title="Inventaires" description="Comptage physique puis validation : les écarts deviennent des mouvements « inventaire » (validation réservée au droit d’ajustement)." />
      <div className="space-y-4 p-4 sm:p-6">
        {ctx.permissions.includes(P.STOCK_WRITE) && <NewInventory warehouses={warehouses} />}
        {rows.length === 0 ? <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">Aucun inventaire.</p> : (
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {rows.map((i) => (
              <li key={i.id}>
                <Link href={`/stock/inventories/${i.id}`} className="block h-full rounded-md border border-line bg-white p-4 shadow-card hover:border-brand-400">
                  <span className="flex items-center justify-between"><span className="font-mono text-sm font-semibold text-brand-700">{i.code}</span><Badge tone={INVENTORY_STATUS[i.status].tone}>{INVENTORY_STATUS[i.status].label}</Badge></span>
                  <span className="mt-1 block text-sm">{i.warehouse_code}{i.location_code ? ` / ${i.location_code}` : ' · tout l’entrepôt'} · {i.line_count} ligne(s)</span>
                  {i.note && <span className="block truncate text-xs text-ink-soft">{i.note}</span>}
                  <span className="mt-1 block text-xs text-ink-faint">Créé le {formatDateTime(i.created_at)}{i.closed_at ? ` · clos le ${formatDateTime(i.closed_at)}` : ''}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  )
}
