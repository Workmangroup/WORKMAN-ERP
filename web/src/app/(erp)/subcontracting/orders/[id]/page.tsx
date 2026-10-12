import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, Check } from 'lucide-react'
import { z } from 'zod'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { CostsPanel } from '@/features/subcontracting/components/costs-panel'
import { OrderActions, ReceiptsTable, ShipmentsTable } from '@/features/subcontracting/components/order-panel'
import { SubcontractTimeline } from '@/features/subcontracting/components/timeline'
import { getOrder } from '@/features/subcontracting/services/subcontracting.service'
import { ORDER_STATUS, WORKFLOW, daysBetween, serviceLabel, today, workflowStep } from '@/lib/subcontracting/options'
import { formatMoney } from '@/lib/bom/options'
import { P } from '@/lib/rbac/permissions'
import { cn } from '@/lib/utils'
import { fmtDay } from '@/features/orders/status'

export const metadata: Metadata = { title: 'Commande de sous-traitance' }

export default async function SubcontractOrderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ created?: string; closed?: string }> }) {
  const ctx = await requirePermission(P.SUBCONTRACT_READ)
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const sp = await searchParams
  const d = await getOrder(id)
  if (!d) notFound()
  const { order: o, subcontractor, product, shipments, receipts, costs, variants, warehouses, history } = d
  const perms = ctx.permissions
  const canWrite = perms.includes(P.SUBCONTRACT_WRITE)
  const canQc = perms.includes(P.SUBCONTRACT_QC)
  const canCosts = perms.includes(P.SUBCONTRACT_COSTS) || perms.includes(P.COSTS_READ)
  const pending = receipts.filter((r) => r.qc_status === 'pending').length
  const unposted = receipts.filter((r) => r.qc_status !== 'pending' && r.qty_accepted > 0 && !r.stock_posted).length
  const step = workflowStep({ status: o.status, qty_shipped: o.qty_shipped, qty_received: o.qty_received, pending_qc: pending, unposted })
  const late = (o.status === 'sent' || o.status === 'partially_received') && o.due_date && o.due_date < new Date().toISOString().slice(0, 10)
  const lateDays = late ? daysBetween(o.due_date, today()) : null
  const totalCost = costs.reduce((a, c) => a + c.amount, 0)
  const bars = [
    { l: 'Commandées', v: o.qty }, { l: 'Envoyées', v: o.qty_shipped }, { l: 'Reçues', v: o.qty_received }, { l: 'Acceptées', v: o.qty_accepted }, { l: 'Rejetées', v: o.qty_rejected },
  ]
  return (
    <>
      <PageHeader title={`${o.code} — ${serviceLabel(o.service)}`} description={`${subcontractor?.name ?? ''}${product ? ` · ${product.code} ${product.name}` : ''}`}
        actions={<>
          <Link href="/subcontracting/orders" className={buttonVariants({ variant: 'command', size: 'sm' })}><ArrowLeft className="h-4 w-4" /> Commandes</Link>
          {canWrite && subcontractor && <Link href="/subcontracting/subcontractors" className={buttonVariants({ variant: 'command', size: 'sm' })}>Sous-traitants</Link>}
        </>} />
      <div className="space-y-4 p-4 sm:p-6">
        {sp.created && <Alert tone="success">Commande créée en brouillon. Envoyez-la au sous-traitant quand le travail est prêt.</Alert>}
        {o.status === 'closed' && <Alert tone="success">Commande clôturée{o.closed_at ? ` le ${fmtDay(o.closed_at)}` : ''} : retours contrôlés et entrés en stock.</Alert>}
        {o.status === 'cancelled' && <Alert tone="warning">Commande annulée{o.cancel_reason ? ` — « ${o.cancel_reason} »` : ''}.</Alert>}
        {late && <Alert tone="warning">Retour dépassé de {lateDays} jour(s) : prévu le {fmtDay(o.due_date)}.</Alert>}

        <div className="flex flex-wrap items-center gap-3 text-sm">
          <Badge tone={ORDER_STATUS[o.status as keyof typeof ORDER_STATUS].tone}>{ORDER_STATUS[o.status as keyof typeof ORDER_STATUS].label}</Badge>
          <span className="text-ink-soft">Demandée le {fmtDay(o.requested_on)}{o.sent_on ? ` · envoyée le ${fmtDay(o.sent_on)}` : ''}{o.due_date ? ` · retour prévu le ${fmtDay(o.due_date)}` : ''}</span>
        </div>

        <Card>
          <CardContent className="space-y-4 pt-5">
            <ol className="flex w-full items-start gap-1 overflow-x-auto pb-1" aria-label="Parcours de la commande">
              {WORKFLOW.map((w, i) => {
                const done = i < step, current = i === step
                return (
                  <li key={w.id} aria-current={current ? 'step' : undefined} className="flex min-w-[6rem] flex-1 flex-col items-center gap-1 text-center">
                    <div className="flex w-full items-center">
                      <span className={cn('h-0.5 flex-1', i === 0 ? 'bg-transparent' : done || current ? 'bg-brand-500' : 'bg-line')} />
                      <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 text-xs font-semibold', done ? 'border-brand-500 bg-brand-500 text-white' : current ? 'border-brand-500 bg-white text-brand-700 ring-4 ring-brand-100' : 'border-line-strong bg-white text-ink-faint')}>
                        {done ? <Check className="h-3.5 w-3.5" aria-hidden /> : i + 1}
                      </span>
                      <span className={cn('h-0.5 flex-1', i === WORKFLOW.length - 1 ? 'bg-transparent' : done ? 'bg-brand-500' : 'bg-line')} />
                    </div>
                    <span className={cn('text-xs', current ? 'font-semibold text-brand-700' : done ? 'text-ink' : 'text-ink-faint')}>{w.label}</span>
                  </li>
                )
              })}
            </ol>
            <div className="grid gap-3 sm:grid-cols-5">
              {bars.map((b) => (
                <div key={b.l} className="rounded-md bg-canvas p-2 text-center"><p className="text-xs text-ink-soft">{b.l}</p><p className="text-lg font-semibold tabular-nums">{b.v}<span className="text-xs font-normal text-ink-faint"> / {o.qty}</span></p></div>
              ))}
            </div>
            <OrderActions id={o.id} o={o} shipments={shipments} receipts={receipts} variants={variants.map((v) => ({ id: v.id, sku: v.sku }))} warehouses={warehouses.map((w) => ({ id: w.id, name: w.name }))} canWrite={canWrite} canQc={canQc} />
          </CardContent>
        </Card>

        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader><CardTitle>Envois au sous-traitant</CardTitle></CardHeader>
            <CardContent className="p-0"><div className="overflow-x-auto"><ShipmentsTable shipments={shipments} /></div></CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Travail demandé</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p className="font-medium">{o.description}</p>
              <p className="text-ink-soft">Quantité : {o.qty} pièce(s){o.qty_rejected > 0 ? ` · ${o.qty_rejected} rejetée(s)` : ''}</p>
              {subcontractor && <p className="text-ink-soft">Délai habituel du sous-traitant : {subcontractor.default_lead_days} jour(s)</p>}
              {o.notes && <p className="whitespace-pre-wrap rounded-sm bg-canvas p-2">{o.notes}</p>}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader><CardTitle>Retours et contrôle qualité</CardTitle></CardHeader>
          <CardContent className="p-0"><ReceiptsTable orderId={o.id} receipts={receipts} variants={variants.map((v) => ({ id: v.id, sku: v.sku }))} warehouses={warehouses.map((w) => ({ id: w.id, name: w.name }))} canQc={canQc} canStock={canQc && perms.includes(P.VARIANTS_STOCK)} /></CardContent>
        </Card>

        {canCosts && (
          <Card>
            <CardHeader><CardTitle className="flex items-center justify-between"><span>Coûts de sous-traitance</span><span className="text-sm font-normal tabular-nums text-ink-soft">{formatMoney(totalCost)}</span></CardTitle></CardHeader>
            <CardContent><CostsPanel orderId={o.id} costs={costs} shipments={shipments} canWrite={perms.includes(P.SUBCONTRACT_COSTS) && o.status !== 'closed' && o.status !== 'cancelled'} /></CardContent>
          </Card>
        )}

        <Card>
          <CardHeader><CardTitle>Historique</CardTitle></CardHeader>
          <CardContent><SubcontractTimeline rows={history} /></CardContent>
        </Card>
      </div>
    </>
  )
}
