import type { Metadata } from 'next'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { WarehousesManager } from '@/features/stock/components/warehouses-manager'
import { listWarehouses } from '@/features/stock/services/stock.service'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Entrepôts' }

export default async function WarehousesPage() {
  const ctx = await requirePermission(P.STOCK_READ)
  const warehouses = await listWarehouses()
  return (
    <>
      <PageHeader title="Entrepôts et emplacements" description="Un entrepôt se compose d’emplacements (allées, racks, zones de réception). L’archivage exige un entrepôt ou un emplacement vide." />
      <div className="p-4 sm:p-6"><WarehousesManager warehouses={warehouses} canWrite={ctx.permissions.includes(P.STOCK_WRITE)} /></div>
    </>
  )
}
