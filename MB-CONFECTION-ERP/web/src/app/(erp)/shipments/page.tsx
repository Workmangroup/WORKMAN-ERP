import type { Metadata } from 'next'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { NewShipmentDialog } from '@/features/shipping/components/shipping-forms'
import { confirmedOrderOptions, listShipments, warehouseOptions } from '@/features/shipping/services/shipping.service'
import { P } from '@/lib/rbac/permissions'
import { cn, formatDateTime } from '@/lib/utils'

export const metadata: Metadata = { title: 'Expéditions' }

const STATUS: Record<string, { label: string; tone: 'neutral' | 'brand' | 'success' | 'warning' | 'danger' }> = {
  preparing: { label: 'En préparation', tone: 'neutral' }, picking: { label: 'Prélèvement', tone: 'brand' }, packed: { label: 'Colisée', tone: 'brand' },
  shipped: { label: 'Expédiée', tone: 'warning' }, delivered: { label: 'Livrée', tone: 'success' }, cancelled: { label: 'Annulée', tone: 'danger' },
}
const FILTERS = ['preparing', 'picking', 'packed', 'shipped', 'delivered', 'cancelled'] as const

export default async function ShipmentsPage({ searchParams }: { searchParams: Promise<{ statut?: string }> }) {
  const ctx = await requirePermission(P.SHIPMENTS_READ)
  const sp = await searchParams
  const statut = (FILTERS as readonly string[]).includes(sp.statut ?? '') ? (sp.statut as string) : null
  const canWrite = ctx.permissions.includes(P.SHIPMENTS_WRITE)
  const [rows, orders, warehouses] = await Promise.all([
    listShipments(statut), canWrite ? confirmedOrderOptions() : Promise.resolve([]), canWrite ? warehouseOptions() : Promise.resolve([]),
  ])
  const chip = (on: boolean) => cn('rounded-full border px-3 py-1', on ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-line bg-white text-ink-soft')
  return (
    <>
      <PageHeader title="Expéditions" description="Chaque expédition suit ses étapes : préparation, picking, colisage, expédition avec bon de livraison, livraison."
        actions={canWrite && <NewShipmentDialog orders={orders} warehouses={warehouses} />} />
      <div className="space-y-4 p-4 sm:p-6">
        <div className="flex flex-wrap gap-2 text-sm">
          <Link href="/shipments" className={chip(!statut)}>Toutes</Link>
          {FILTERS.map((s) => <Link key={s} href={`/shipments?statut=${s}`} className={chip(statut === s)}>{STATUS[s].label}</Link>)}
        </div>
        {rows.length === 0 ? (
          <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">Aucune expédition dans cette vue.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
            <table className="w-full min-w-[46rem] text-sm">
              <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Expédition</th><th className="px-2 py-2 font-semibold">Statut</th><th className="px-2 py-2 font-semibold">Incoterm / pays</th><th className="px-2 py-2 font-semibold">Transport</th><th className="px-2 py-2 font-semibold">Bon de livraison</th><th className="px-2 py-2 font-semibold">Créée le</th></tr></thead>
              <tbody className="divide-y divide-line">{rows.map((s) => (
                <tr key={s.id} className="hover:bg-canvas">
                  <td className="px-4 py-2"><Link href={`/shipments/${s.id}`} className="font-mono text-xs text-brand-700 hover:underline">{s.number}</Link></td>
                  <td className="px-2 py-2"><Badge tone={STATUS[s.status]?.tone ?? 'neutral'}>{STATUS[s.status]?.label ?? s.status}</Badge></td>
                  <td className="px-2 py-2 text-xs">{s.incoterm ?? '—'} {s.destination_country ? `· ${s.destination_country}` : ''}</td>
                  <td className="px-2 py-2 text-xs">{s.carrier ?? '—'}{s.tracking_number ? <span className="block font-mono text-ink-soft">{s.tracking_number}</span> : null}</td>
                  <td className="px-2 py-2 font-mono text-xs">{s.bl_number ?? '—'}</td>
                  <td className="px-2 py-2 text-xs text-ink-soft">{formatDateTime(s.created_at)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}
