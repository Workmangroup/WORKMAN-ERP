import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, Send, XCircle } from 'lucide-react'
import { z } from 'zod'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { cancelOrderAction, sendOrderAction } from '@/features/purchases/actions'
import { AddPoLine, HeaderForm, LinesTable, ReceiveDialog } from '@/features/purchases/components/order-forms'
import { getOrder, materialOptions } from '@/features/purchases/services/purchases.service'
import { PO_STATUS, fmtDay } from '@/features/purchases/status'
import { RpcButton } from '@/features/stock/components/rpc-button'
import { listWarehouses } from '@/features/stock/services/stock.service'
import { formatMoney } from '@/lib/bom/options'
import { P } from '@/lib/rbac/permissions'
import { formatDateTime } from '@/lib/utils'

export const metadata: Metadata = { title: 'Commande fournisseur' }

export default async function PurchaseOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePermission(P.PURCHASES_READ)
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const data = await getOrder(id)
  if (!data) notFound()
  const { order: o, supplier, lines, receipts, request } = data
  const perms = ctx.permissions
  const canWrite = perms.includes(P.PURCHASES_WRITE)
  const canReceive = perms.includes(P.PURCHASES_RECEIVE) && ['sent', 'partial'].includes(o.status)
  const draft = o.status === 'draft'
  const [mats, warehouses] = await Promise.all([draft && canWrite ? materialOptions() : Promise.resolve([]), canReceive && perms.includes(P.STOCK_READ) ? listWarehouses() : Promise.resolve([])])
  const today = new Date().toISOString().slice(0, 10)
  const late = ['sent', 'partial'].includes(o.status) && o.expected_date && o.expected_date.slice(0, 10) < today
  return (
    <>
      <PageHeader title={o.po_no} description={`${supplier?.name ?? 'Fournisseur'} · ${formatMoney(o.total_amount)}`}
        actions={<>
          <Link href="/purchases/orders" className={buttonVariants({ variant: 'command', size: 'sm' })}><ArrowLeft className="h-4 w-4" /> Commandes</Link>
          {supplier && perms.includes(P.SUPPLIERS_READ) && <Link href={`/suppliers/${supplier.id}`} className={buttonVariants({ variant: 'command', size: 'sm' })}>Fournisseur</Link>}
          {draft && canWrite && <RpcButton action={sendOrderAction} fields={{ id: o.id }} variant="command" size="sm" confirm="Envoyer la commande au fournisseur ? Elle ne sera plus modifiable."><Send className="h-4 w-4" /> Envoyer</RpcButton>}
          {canReceive && warehouses.length > 0 && <ReceiveDialog poId={o.id} poNo={o.po_no} lines={lines} warehouses={warehouses} />}
          {['draft', 'sent'].includes(o.status) && canWrite && receipts.length === 0 && <RpcButton action={cancelOrderAction} fields={{ id: o.id }} variant="command" size="sm" className="text-danger-text" confirm="Annuler cette commande ?"><XCircle className="h-4 w-4" /> Annuler</RpcButton>}
        </>} />
      <div className="space-y-4 p-4 sm:p-6">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <Badge tone={PO_STATUS[o.status].tone}>{PO_STATUS[o.status].label}</Badge>
          <span className="text-ink-soft">Date {fmtDay(o.order_date)} · échéance <span className={late ? 'font-semibold text-danger-text' : ''}>{fmtDay(o.expected_date)}{late ? ' (en retard)' : ''}</span>{o.received_date ? ` · soldée le ${fmtDay(o.received_date)}` : ''}{o.sent_at ? ` · envoyée le ${formatDateTime(o.sent_at)}` : ''}</span>
          {request && <Link href={`/purchases/requests/${request.id}`} className="text-brand-600 hover:underline">Demande {request.code}</Link>}
        </div>
        {supplier?.archived && <Alert tone="warning">Fournisseur archivé : la commande ne peut plus être envoyée.</Alert>}
        {canReceive && warehouses.length === 0 && <Alert tone="info">Créez un entrepôt (menu Stock) pour pouvoir réceptionner.</Alert>}
        {o.status === 'cancelled' && <Alert tone="warning">Commande annulée.</Alert>}

        <section className="rounded-md border border-line bg-white shadow-card">
          {draft && canWrite && <HeaderForm id={o.id} expected={o.expected_date} notes={o.notes} />}
          {!draft && o.notes && <p className="border-b border-line px-4 py-2 text-sm text-ink-soft">{o.notes}</p>}
          <LinesTable lines={lines} editable={draft && canWrite} />
          <div className="flex justify-end border-t border-line px-4 py-2 text-sm"><span className="mr-3 text-ink-soft">Total</span><strong className="tabular-nums">{formatMoney(o.total_amount)}</strong></div>
          {draft && canWrite && <AddPoLine poId={o.id} materials={mats} />}
        </section>

        {receipts.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-base font-semibold">Réceptions</h2>
            <ul className="divide-y divide-line rounded-md border border-line bg-white shadow-card">
              {receipts.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
                  <Link href={`/purchases/receipts/${r.id}`} className="font-mono font-semibold text-brand-700 hover:underline">{r.code}</Link>
                  <span className="text-ink-soft">{formatDateTime(r.received_at)}{r.delivery_note ? ` · BL ${r.delivery_note}` : ''}{r.by ? ` · ${r.by}` : ''}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </>
  )
}
