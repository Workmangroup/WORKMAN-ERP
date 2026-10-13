import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { z } from 'zod'
import { Alert } from '@/components/ui/alert'
import { buttonVariants } from '@/components/ui/button'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { ReturnDialog } from '@/features/purchases/components/order-forms'
import { ReceiptInspectForm } from '@/features/purchases/components/receipt-inspection-forms'
import { getReceipt, receiptInspections, storageLocations } from '@/features/purchases/services/purchases.service'
import { formatMoney, formatQty, unitLabel } from '@/lib/bom/options'
import { P } from '@/lib/rbac/permissions'
import { formatDateTime } from '@/lib/utils'

export const metadata: Metadata = { title: 'Réception' }

export default async function ReceiptPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ received?: string; returned?: string }> }) {
  const ctx = await requirePermission(P.PURCHASES_READ)
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const sp = await searchParams
  const data = await getReceipt(id)
  if (!data) notFound()
  const { receipt: r, lines, returns } = data
  const canReturn = ctx.permissions.includes(P.PURCHASES_RECEIVE) && lines.some((l) => l.qty - l.qty_returned > 0)
  const inspections = await receiptInspections(id)
  const canInspect = ctx.permissions.includes(P.QUALITY_WRITE) && ctx.permissions.includes(P.PURCHASES_RECEIVE) && ctx.permissions.includes(P.STOCK_WRITE)
  const pending = lines.filter((l) => !inspections[l.id])
  const locations = canInspect && pending.length > 0 ? await storageLocations(r.warehouse_id) : []
  return (
    <>
      <PageHeader title={r.code} description={`${r.supplier} · commande ${r.po_no} · ${formatDateTime(r.received_at)}`}
        actions={<>
          <Link href={`/purchases/orders/${r.po_id}`} className={buttonVariants({ variant: 'command', size: 'sm' })}><ArrowLeft className="h-4 w-4" /> Commande {r.po_no}</Link>
          {canReturn && <ReturnDialog receiptId={r.id} code={r.code} lines={lines} />}
        </>} />
      <div className="space-y-4 p-4 sm:p-6">
        {sp.received && <Alert tone="success">Réception enregistrée : les quantités sont entrées en stock.</Alert>}
        {sp.returned && <Alert tone="success">Retour enregistré : le stock a été diminué et la commande rouverte pour la quantité retournée.</Alert>}
        <p className="text-sm text-ink-soft">Entrepôt {r.warehouse}{r.delivery_note ? ` · bon de livraison ${r.delivery_note}` : ''}{r.by ? ` · par ${r.by}` : ''}{r.notes ? ` · ${r.notes}` : ''}</p>
        <section className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
          <table className="w-full min-w-[40rem] text-sm">
            <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Composant</th><th className="px-2 py-2 font-semibold">Emplacement</th><th className="px-2 py-2 text-right font-semibold">Reçu</th><th className="px-2 py-2 text-right font-semibold">Retourné</th><th className="px-2 py-2 text-right font-semibold">Prix unit.</th><th className="px-4 py-2 text-right font-semibold">Valeur</th></tr></thead>
            <tbody className="divide-y divide-line">
              {lines.map((l) => (
                <tr key={l.id}>
                  <td className="px-4 py-2"><span className="font-medium">{l.material_name}</span><span className="ml-2 font-mono text-xs text-ink-faint">{l.material_code}</span></td>
                  <td className="px-2 py-2 font-mono text-xs">{l.location}</td><td className="px-2 py-2 text-right tabular-nums">{formatQty(l.qty)} {unitLabel(l.unit)}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-danger-text">{l.qty_returned > 0 ? formatQty(l.qty_returned) : '—'}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{formatMoney(l.unit_price)}</td><td className="px-4 py-2 text-right tabular-nums">{formatMoney(l.qty * l.unit_price)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="space-y-3">
          <h2 className="text-base font-semibold">Contrôle à la réception</h2>
          <p className="text-xs text-ink-soft">Accepté + rejeté = reçu. Le rejet crée un retour fournisseur ; l’accepté quitte la quarantaine vers l’emplacement choisi. Le réceptionnaire ne peut pas contrôler sa propre réception.</p>
          <ul className="divide-y divide-line rounded-md border border-line bg-white shadow-card">
            {lines.map((l) => {
              const d = inspections[l.id]
              return (
                <li key={l.id} className="space-y-2 px-4 py-3 text-sm">
                  <p><span className="font-medium">{l.material_name}</span> · reçu {formatQty(l.qty)} {unitLabel(l.unit)}{d ? ` · accepté ${formatQty(d.qty_accepted)} · rejeté ${formatQty(d.qty_rejected)}${d.reason ? ` · « ${d.reason} »` : ''}` : ' · non contrôlé'}</p>
                  {!d && canInspect && <ReceiptInspectForm lineId={l.id} received={l.qty - l.qty_returned} locations={locations} />}
                </li>
              )
            })}
          </ul>
        </section>
        {returns.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-base font-semibold">Retours fournisseur</h2>
            <ul className="divide-y divide-line rounded-md border border-line bg-white shadow-card">
              {returns.map((x) => (
                <li key={x.id} className="px-4 py-2 text-sm">
                  <p><span className="font-mono font-semibold">{x.code}</span> <span className="text-ink-soft">· {formatDateTime(x.returned_at)} · « {x.reason} »</span></p>
                  <p className="text-xs text-ink-soft">{x.lines.map((l) => `${formatQty(l.qty)} ${unitLabel(l.unit)} ${l.name}`).join(' · ')} — {formatMoney(x.lines.reduce((a, l) => a + l.qty * l.unit_price, 0))}</p>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </>
  )
}
