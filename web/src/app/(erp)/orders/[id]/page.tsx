import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { AlertTriangle, ArrowLeft, CheckCircle2, Receipt, Trash2 } from 'lucide-react'
import { z } from 'zod'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { confirmOrderAction, deleteOrderLineAction, setOrderStatusAction } from '@/features/orders/actions'
import { orderAddressAction, orderAmendLineAction, orderCancelAction, orderScheduleAction } from '@/features/orders/order-backorder-actions'
import { getOrderVersions, getRemaining } from '@/features/orders/services/backorders.service'
import { ActionForm } from '@/features/commercial/components/crm-forms'
import { formatDateTime } from '@/lib/utils'
import { AddLineForm } from '@/features/orders/components/order-forms'
import { getOrder } from '@/features/orders/services/orders.service'
import { ORDER_STATUS, fmtDay } from '@/features/orders/status'
import { invoiceFromOrderAction } from '@/features/commercial/actions'
import { INVOICE_LINK, money } from '@/features/commercial/status'
import { RpcButton } from '@/features/stock/components/rpc-button'
import { formatQty } from '@/lib/bom/options'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Commande' }

const REMAINING_STATE: Record<string, string> = { draft: 'Brouillon', confirmed: 'Confirmée', partially_delivered: 'Livraison partielle', delivered: 'Livrée', closed_with_cancellation: 'Clôturée avec annulation', cancelled: 'Annulée' }
const VERSION_LABEL: Record<string, string> = { confirmed: 'Confirmation', amended: 'Modification', cancelled: 'Annulation du reliquat' }

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePermission(P.ORDERS_READ)
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const data = await getOrder(id)
  if (!data) notFound()
  const { order: o, lines, articles } = data
  const [remaining, versions] = await Promise.all([getRemaining(id), getOrderVersions(id)])
  const draft = o.status === 'draft'
  const canWrite = ctx.permissions.includes(P.ORDERS_WRITE)
  const canConfirm = ctx.permissions.includes(P.ORDERS_CONFIRM)
  const noBom = lines.filter((l) => !l.has_bom)
  const canInvoice = ctx.permissions.includes(P.INVOICES_WRITE) && ['confirmed', 'delivered'].includes(o.status) && o.invoice_status !== 'full' && lines.some((l) => l.qty > l.qty_invoiced)
  const net = (l: (typeof lines)[number]) => Math.round(l.qty * l.unit_price * (1 - l.discount_pct / 100) * 100) / 100
  return (
    <>
      <PageHeader title={`${o.code} — ${o.client_name}`} description={`${o.client_ref ? `N° client ${o.client_ref} · ` : ''}commande du ${fmtDay(o.order_date)}`}
        actions={<>
          <Link href="/orders" className={buttonVariants({ variant: 'command', size: 'sm' })}><ArrowLeft className="h-4 w-4" /> Commandes</Link>
          {o.quote_id && ctx.permissions.includes(P.QUOTES_READ) && <Link href={`/commercial/quotes/${o.quote_id}`} className={buttonVariants({ variant: 'command', size: 'sm' })}>Devis {o.quote_code ?? ''}</Link>}
          {canInvoice && <RpcButton action={invoiceFromOrderAction} fields={{ order_id: o.id }} variant="command" size="sm" confirm="Créer une facture brouillon avec le reste à facturer ?"><Receipt className="h-4 w-4" /> Facturer</RpcButton>}
          {draft && canConfirm && <RpcButton action={confirmOrderAction} fields={{ id: o.id }} variant="command" size="sm" confirm="Confirmer la commande ? Elle ne sera plus modifiable et alimentera le MRP."><CheckCircle2 className="h-4 w-4" /> Confirmer</RpcButton>}
          {o.status === 'confirmed' && canWrite && <RpcButton action={setOrderStatusAction} fields={{ id: o.id, status: 'delivered' }} variant="command" size="sm" confirm="Marquer la commande comme livrée ? Elle sort du calcul des besoins.">Marquer livrée</RpcButton>}
          {draft && canWrite && <RpcButton action={setOrderStatusAction} fields={{ id: o.id, status: 'cancelled' }} variant="command" size="sm" className="text-danger-text" confirm="Annuler ce brouillon ?">Annuler</RpcButton>}
        </>} />
      <div className="space-y-4 p-4 sm:p-6">
        <div className="flex flex-wrap items-center gap-3 text-sm"><Badge tone={ORDER_STATUS[o.status].tone}>{ORDER_STATUS[o.status].label}</Badge><span className="text-ink-soft">{o.line_count} ligne(s) · {formatQty(o.total_qty)} pièce(s){o.notes ? ` · ${o.notes}` : ''}</span>{o.total > 0 && <span className="text-ink-soft">· {money(o.total, o.currency)} TTC</span>}{o.status !== 'draft' && o.status !== 'cancelled' && <Badge tone={INVOICE_LINK[o.invoice_status].tone}>{INVOICE_LINK[o.invoice_status].label}</Badge>}</div>
        {draft && <Alert tone="info">Brouillon : ignoré par le MRP tant qu’il n’est pas confirmé{canConfirm ? '' : ' (la confirmation exige le droit « Confirmer les commandes »)'}.</Alert>}
        {noBom.length > 0 && o.status !== 'cancelled' && <Alert tone="warning"><AlertTriangle className="mr-1 inline h-4 w-4" />Sans BOM validée, le MRP ne peut pas calculer les besoins de : {noBom.map((l) => l.article_ref).join(', ')}.</Alert>}
        <section className="rounded-md border border-line bg-white shadow-card">
          {lines.length === 0 ? <p className="p-6 text-center text-sm text-ink-soft">Aucune ligne.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[56rem] text-sm">
                <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Article</th><th className="px-2 py-2 text-right font-semibold">Quantité</th><th className="px-2 py-2 text-right font-semibold">Facturé</th><th className="px-2 py-2 text-right font-semibold">PU HT</th><th className="px-2 py-2 text-right font-semibold">Rem.</th><th className="px-2 py-2 text-right font-semibold">Total HT</th><th className="px-2 py-2 font-semibold">Livraison</th><th className="px-2 py-2 font-semibold">Note</th><th className="px-2 py-2 font-semibold">BOM</th>{draft && canWrite && <th className="w-16 px-4 py-2" />}</tr></thead>
                <tbody className="divide-y divide-line">
                  {lines.map((l) => (
                    <tr key={l.id}>
                      <td className="px-4 py-2">{l.article_id ? <><span className="font-mono text-xs font-semibold text-brand-700">{l.article_ref}</span> {l.article_name}</> : <span className="italic">{l.article_name} <span className="text-xs text-ink-soft">(ligne libre)</span></span>}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{formatQty(l.qty)}</td><td className="px-2 py-2 text-right tabular-nums">{formatQty(l.qty_invoiced)}</td><td className="px-2 py-2 text-right tabular-nums">{money(l.unit_price, o.currency)}</td><td className="px-2 py-2 text-right tabular-nums">{l.discount_pct ? `${l.discount_pct} %` : '—'}</td><td className="px-2 py-2 text-right tabular-nums">{money(net(l), o.currency)}</td><td className="whitespace-nowrap px-2 py-2">{fmtDay(l.due_date)}</td><td className="px-2 py-2 text-ink-soft">{l.note ?? ''}</td>
                      <td className="px-2 py-2">{!l.article_id ? '—' : l.has_bom ? <Badge tone="success">Validée</Badge> : <Badge tone="warning">Manquante</Badge>}</td>
                      {draft && canWrite && <td className="px-4 py-2 text-right"><RpcButton action={deleteOrderLineAction} fields={{ id: l.id, order_id: o.id }} variant="ghost" size="sm" aria-label="Supprimer la ligne"><Trash2 className="h-4 w-4 text-danger-text" /></RpcButton></td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {lines.length > 0 && <dl className="grid grid-cols-[1fr_auto] justify-end gap-x-6 gap-y-1 border-t border-line px-4 py-3 text-sm sm:ml-auto sm:max-w-xs"><dt className="text-ink-soft">Total HT</dt><dd className="text-right tabular-nums">{money(o.subtotal, o.currency)}</dd><dt className="text-ink-soft">TVA {o.tax_rate} %</dt><dd className="text-right tabular-nums">{money(o.tax_amount, o.currency)}</dd><dt className="font-semibold">Total TTC</dt><dd className="text-right font-semibold tabular-nums">{money(o.total, o.currency)}</dd></dl>}
          {draft && canWrite && <AddLineForm orderId={o.id} articles={articles} />}
        </section>
        {remaining && (
          <section className="rounded-md border border-line bg-white p-4 shadow-card">
            <h2 className="text-sm font-semibold">Reliquats</h2>
            <p className="mt-1 text-sm">État : <span className="font-semibold">{REMAINING_STATE[remaining.state] ?? remaining.state}</span> · commandé {formatQty(remaining.totals.qty)} · livré {formatQty(remaining.totals.delivered)} · annulé {formatQty(remaining.totals.cancelled)} · <span className="font-semibold">restant {formatQty(remaining.totals.remaining)}</span></p>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[36rem] text-sm">
                <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-3 py-2 font-semibold">Ligne</th><th className="px-2 py-2 text-right font-semibold">Commandé</th><th className="px-2 py-2 text-right font-semibold">Livré</th><th className="px-2 py-2 text-right font-semibold">Annulé</th><th className="px-2 py-2 text-right font-semibold">Restant</th><th className="px-2 py-2 font-semibold">Échéance</th></tr></thead>
                <tbody className="divide-y divide-line">
                  {remaining.lines.map((l) => (
                    <tr key={l.line_id}><td className="px-3 py-2">{l.description}</td><td className="px-2 py-2 text-right tabular-nums">{formatQty(l.qty)}</td><td className="px-2 py-2 text-right tabular-nums">{formatQty(l.delivered)}</td><td className="px-2 py-2 text-right tabular-nums">{formatQty(l.cancelled)}</td><td className="px-2 py-2 text-right font-semibold tabular-nums">{formatQty(l.remaining)}</td><td className="px-2 py-2">{fmtDay(l.due_date)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
        {versions.length > 0 && (
          <section className="rounded-md border border-line bg-white p-4 shadow-card">
            <h2 className="text-sm font-semibold">Engagements (versions)</h2>
            <ul className="mt-2 divide-y divide-line text-sm">
              {versions.map((v) => (
                <li key={v.seq} className="flex flex-wrap items-center gap-3 py-2"><span className="font-semibold">v{v.seq}</span><span>{VERSION_LABEL[v.label] ?? v.label}</span><span className="text-ink-soft">{formatDateTime(v.recorded_at)}</span>{v.reason && <span className="text-ink-soft">— « {v.reason} »</span>}<span className="font-mono text-xs text-ink-soft">{v.content_hash.slice(0, 12)}</span></li>
              ))}
            </ul>
          </section>
        )}
        {o.status === 'confirmed' && canWrite && (
          <section className="rounded-md border border-line bg-white p-4 shadow-card">
            <h2 className="text-sm font-semibold">Modifier une ligne (nouvelle version)</h2>
            <p className="mt-1 text-xs text-ink-soft">La quantité ne descend pas sous ce qui est livré, annulé ou facturé. Le motif est conservé dans l’historique.</p>
            <ul className="mt-3 space-y-3">
              {lines.map((l) => (
                <li key={l.id}><details><summary className="cursor-pointer text-sm text-brand-600">{l.article_name} · qté {formatQty(l.qty)}</summary>
                  <div className="mt-2"><ActionForm action={orderAmendLineAction} submit="Enregistrer la version">
                    <input type="hidden" name="line_id" value={l.id} />
                    <label className="grid gap-1 text-sm">Nouvelle quantité<input name="qty" required inputMode="decimal" defaultValue={String(l.qty)} className="rounded-md border border-line bg-white px-3 py-2 text-sm" /></label>
                    <label className="grid gap-1 text-sm">Nouvelle échéance (facultatif)<input type="date" name="due_date" className="rounded-md border border-line bg-white px-3 py-2 text-sm" /></label>
                    <label className="grid gap-1 text-sm md:col-span-2">Motif<input name="reason" required minLength={5} maxLength={300} className="rounded-md border border-line bg-white px-3 py-2 text-sm" /></label>
                  </ActionForm></div>
                </details></li>
              ))}
            </ul>
          </section>
        )}
        {draft && canWrite && (
          <section className="rounded-md border border-line bg-white p-4 shadow-card">
            <h2 className="text-sm font-semibold">Échéancier par ligne (brouillon)</h2>
            <p className="mt-1 text-xs text-ink-soft">Jusqu’à trois livraisons par ligne ; la somme doit égaler la quantité. Figé à la confirmation.</p>
            <ul className="mt-3 space-y-3">
              {lines.map((l) => (
                <li key={l.id}><details><summary className="cursor-pointer text-sm text-brand-600">{l.article_name} · qté {formatQty(l.qty)}</summary>
                  <div className="mt-2"><ActionForm action={orderScheduleAction} submit="Enregistrer l’échéancier">
                    <input type="hidden" name="line_id" value={l.id} />
                    {[0, 1, 2].map((i) => (
                      <div key={i} className="grid gap-2 md:col-span-2 md:grid-cols-2">
                        <label className="grid gap-1 text-sm">Échéance {i + 1}<input type="date" name="due_date" className="rounded-md border border-line bg-white px-3 py-2 text-sm" /></label>
                        <label className="grid gap-1 text-sm">Quantité {i + 1}<input name="qty" inputMode="decimal" className="rounded-md border border-line bg-white px-3 py-2 text-sm" /></label>
                      </div>
                    ))}
                  </ActionForm></div>
                </details></li>
              ))}
            </ul>
          </section>
        )}
        {(draft || o.status === 'confirmed') && canWrite && (
          <section className="rounded-md border border-line bg-white p-4 shadow-card">
            <h2 className="text-sm font-semibold">Adresse de livraison</h2>
            <div className="mt-3"><ActionForm action={orderAddressAction} submit="Enregistrer l’adresse">
              <input type="hidden" name="id" value={o.id} />
              <label className="grid gap-1 text-sm md:col-span-2">Adresse (5 à 300 caractères)<textarea name="address" rows={2} maxLength={300} className="rounded-md border border-line bg-white px-3 py-2 text-sm" /></label>
            </ActionForm></div>
          </section>
        )}
        {o.status === 'confirmed' && canWrite && (
          <section className="rounded-md border border-line bg-white p-4 shadow-card">
            <h2 className="text-sm font-semibold">Annulation motivée du reliquat</h2>
            <p className="mt-1 text-xs text-ink-soft">Annule ce qui n’est pas encore livré. Ce qui est livré, consommé en production ou facturé reste dans l’historique.</p>
            <div className="mt-3"><ActionForm action={orderCancelAction} submit="Annuler le reliquat">
              <input type="hidden" name="id" value={o.id} />
              <label className="grid gap-1 text-sm md:col-span-2">Motif<input name="reason" required minLength={5} maxLength={300} className="rounded-md border border-line bg-white px-3 py-2 text-sm" /></label>
            </ActionForm></div>
          </section>
        )}
      </div>
    </>
  )
}
