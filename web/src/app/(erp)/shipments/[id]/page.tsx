import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, FileText } from 'lucide-react'
import { z } from 'zod'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import {
  AddLineDialog, CancelShipmentDialog, DeliverButton, ExportInvoiceButton, PackDialog, PickDialog, ShipDialog, TrackDialog,
} from '@/features/shipping/components/shipping-forms'
import { eventLabel, getShipment, listEvents, listLines, variantOptions } from '@/features/shipping/services/shipping.service'
import { P } from '@/lib/rbac/permissions'
import { formatMoney } from '@/lib/bom/options'
import { formatDateTime } from '@/lib/utils'

export const metadata: Metadata = { title: 'Expédition' }

const STATUS: Record<string, { label: string; tone: 'neutral' | 'brand' | 'success' | 'warning' | 'danger' }> = {
  preparing: { label: 'En préparation', tone: 'neutral' }, picking: { label: 'Prélèvement', tone: 'brand' }, packed: { label: 'Colisée', tone: 'brand' },
  shipped: { label: 'Expédiée', tone: 'warning' }, delivered: { label: 'Livrée', tone: 'success' }, cancelled: { label: 'Annulée', tone: 'danger' },
}

export default async function ShipmentPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePermission(P.SHIPMENTS_READ)
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const s = await getShipment(id)
  if (!s) notFound()
  const canWrite = ctx.permissions.includes(P.SHIPMENTS_WRITE)
  const [lines, events, variants] = await Promise.all([listLines(id), listEvents(id), canWrite && (s.status === 'preparing' || s.status === 'picking') ? variantOptions() : Promise.resolve([])])
  const allPicked = lines.length > 0 && lines.every((l) => l.qty_picked === l.qty_requested)
  const total = lines.reduce((sum, l) => sum + l.qty_shipped * l.unit_price, 0)
  const open = s.status === 'preparing' || s.status === 'picking'
  return (
    <>
      <PageHeader title={`${s.number}`} description={`Créée le ${formatDateTime(s.created_at)} · commande liée · ${s.currency}`}
        actions={<Link href="/shipments" className={buttonVariants({ variant: 'command', size: 'sm' })}><ArrowLeft className="h-4 w-4" /> Expéditions</Link>} />
      <div className="space-y-4 p-4 sm:p-6">
        <div className="flex flex-wrap items-center gap-3">
          <Badge tone={STATUS[s.status]?.tone ?? 'neutral'}>{STATUS[s.status]?.label ?? s.status}</Badge>
          {s.bl_number && <span className="font-mono text-sm">{s.bl_number}</span>}
          {s.export_invoice_number && <span className="font-mono text-sm">{s.export_invoice_number}</span>}
          {s.cancel_reason && <span className="text-sm text-ink-soft">Annulée : {s.cancel_reason}</span>}
        </div>

        {canWrite && (
          <div className="flex flex-wrap items-center gap-2">
            {open && <AddLineDialog shipmentId={id} variants={variants} />}
            {s.status === 'picking' && allPicked && <PackDialog shipmentId={id} />}
            {s.status === 'packed' && <ShipDialog shipmentId={id} />}
            {s.status === 'shipped' && <TrackDialog shipmentId={id} />}
            {s.status === 'shipped' && <DeliverButton shipmentId={id} />}
            {(s.status === 'shipped' || s.status === 'delivered') && !s.export_invoice_number && <ExportInvoiceButton shipmentId={id} />}
            {(s.status === 'preparing' || s.status === 'picking' || s.status === 'packed') && <CancelShipmentDialog shipmentId={id} />}
          </div>
        )}

        <Card>
          <CardHeader><CardTitle>Lignes</CardTitle></CardHeader>
          <CardContent className="p-0">
            {lines.length === 0 ? <p className="p-6 text-sm text-ink-soft">Aucune ligne. Ajoutez les variantes à expédier.</p> : (
              <div className="overflow-x-auto"><table className="w-full min-w-[40rem] text-sm">
                <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Variante</th><th className="px-2 py-2 text-right font-semibold">Demandé</th><th className="px-2 py-2 text-right font-semibold">Prélevé</th><th className="px-2 py-2 text-right font-semibold">Expédié</th><th className="px-2 py-2 text-right font-semibold">Prix</th><th className="px-2 py-2 text-right font-semibold">Montant</th>{canWrite && open && <th className="px-2 py-2" />}</tr></thead>
                <tbody className="divide-y divide-line">{lines.map((l) => (
                  <tr key={l.id}>
                    <td className="px-4 py-2"><span className="font-mono text-xs text-ink-faint">{l.sku}</span> {l.product} <span className="text-xs text-ink-soft">{l.color ?? ''} {l.size ?? ''}</span></td>
                    <td className="px-2 py-2 text-right tabular-nums">{l.qty_requested}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{l.qty_picked}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{l.qty_shipped}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{formatMoney(l.unit_price)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{formatMoney(l.qty_requested * l.unit_price)}</td>
                    {canWrite && open && <td className="px-2 py-2 text-right">{l.qty_picked < l.qty_requested && <PickDialog lineId={l.id} remaining={l.qty_requested - l.qty_picked} />}</td>}
                  </tr>
                ))}</tbody>
              </table></div>
            )}
          </CardContent>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader><CardTitle>Transport et colis</CardTitle></CardHeader>
            <CardContent className="space-y-1 text-sm">
              <p>Incoterm : {s.incoterm ?? '—'} · Destination : {s.destination_country ?? '—'}</p>
              <p>Transporteur : {s.carrier ?? '—'} · Suivi : <span className="font-mono">{s.tracking_number ?? '—'}</span></p>
              <p>Colis : {s.packages ?? '—'} · Poids brut : {s.gross_weight_kg ?? '—'} kg · Net : {s.net_weight_kg ?? '—'} kg</p>
              {s.status !== 'cancelled' && s.status !== 'preparing' && <p className="pt-2 text-ink-soft">Montant expédié : {formatMoney(total)}</p>}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Documents</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Link href={`/shipments/${id}/documents?doc=packing`} className="flex items-center gap-2 text-brand-700 hover:underline"><FileText className="h-4 w-4" /> Packing list</Link>
              {s.bl_number && <Link href={`/shipments/${id}/documents?doc=bl`} className="flex items-center gap-2 text-brand-700 hover:underline"><FileText className="h-4 w-4" /> Bon de livraison {s.bl_number}</Link>}
              {s.export_invoice_number && <Link href={`/shipments/${id}/documents?doc=export`} className="flex items-center gap-2 text-brand-700 hover:underline"><FileText className="h-4 w-4" /> Facture export {s.export_invoice_number}</Link>}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader><CardTitle>Suivi</CardTitle></CardHeader>
          <CardContent>
            <ol className="space-y-2 text-sm">
              {events.map((e) => (
                <li key={e.id} className="flex flex-wrap gap-x-3 border-l-2 border-line pl-3">
                  <span className="text-xs text-ink-soft">{formatDateTime(e.occurred_at)}</span>
                  <span className="font-semibold">{eventLabel(e.event_type)}</span>
                  {e.location && <span className="text-ink-soft">{e.location}</span>}
                  {e.note && <span className="text-ink-soft">{e.note}</span>}
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      </div>
    </>
  )
}
