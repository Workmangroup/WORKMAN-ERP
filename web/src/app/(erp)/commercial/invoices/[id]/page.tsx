import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, FileCheck2, XCircle } from 'lucide-react'
import { z } from 'zod'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { cancelInvoiceAction, deleteInvoiceLineAction, issueInvoiceAction, updateInvoiceLineAction } from '@/features/commercial/actions'
import { AddInvoiceLine, DocLines, InvoiceHeaderForm, NewCreditNoteDialog, PaymentDialog, Totals } from '@/features/commercial/components/doc-forms'
import { getInvoice } from '@/features/commercial/services/commercial.service'
import { CREDIT_STATUS, INVOICE_STATUS, PAY_METHODS, fmtDay, money } from '@/features/commercial/status'
import { RpcButton } from '@/features/stock/components/rpc-button'
import { P } from '@/lib/rbac/permissions'
import { cn } from '@/lib/utils'

export const metadata: Metadata = { title: 'Facture' }

export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePermission(P.INVOICES_READ)
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const data = await getInvoice(id)
  if (!data) notFound()
  const { invoice: i, lines, payments, credit_notes: cns, order } = data
  const perms = ctx.permissions
  const canWrite = perms.includes(P.INVOICES_WRITE)
  const draft = i.status === 'draft'
  const open = ['issued', 'partially_paid'].includes(i.status)
  const overdue = open && i.due_date && i.due_date < new Date().toISOString().slice(0, 10)
  const title = i.code ?? 'Facture brouillon'
  return (
    <>
      <PageHeader title={title} description={`${i.client_name}${order ? ` · commande ${order.code}` : ''}`}
        actions={<>
          <Link href="/commercial/invoices" className={buttonVariants({ variant: 'command', size: 'sm' })}><ArrowLeft className="h-4 w-4" /> Factures</Link>
          <Link href={`/clients/${i.client_id}`} className={buttonVariants({ variant: 'command', size: 'sm' })}>Client</Link>
          {order && perms.includes(P.ORDERS_READ) && <Link href={`/orders/${order.id}`} className={buttonVariants({ variant: 'command', size: 'sm' })}>Commande</Link>}
          {draft && canWrite && <RpcButton action={issueInvoiceAction} fields={{ id: i.id }} variant="command" size="sm" confirm="Émettre la facture ? Elle recevra son numéro définitif et ne sera plus modifiable."><FileCheck2 className="h-4 w-4" /> Émettre</RpcButton>}
          {draft && canWrite && <RpcButton action={cancelInvoiceAction} fields={{ id: i.id }} variant="command" size="sm" className="text-danger-text" confirm="Annuler ce brouillon ? (aucun numéro n’est consommé)"><XCircle className="h-4 w-4" /> Annuler le brouillon</RpcButton>}
          {open && perms.includes(P.PAYMENTS_WRITE) && i.balance > 0 && <PaymentDialog invoiceId={i.id} code={title} balance={i.balance} currency={i.currency} />}
          {['issued', 'partially_paid', 'paid'].includes(i.status) && canWrite && <NewCreditNoteDialog invoiceId={i.id} code={title} />}
        </>} />
      <div className="space-y-4 p-4 sm:p-6">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <Badge tone={INVOICE_STATUS[i.status].tone}>{INVOICE_STATUS[i.status].label}</Badge>
          {i.issue_date && <span className="text-ink-soft">Émise le {fmtDay(i.issue_date)} · échéance <span className={cn(overdue && 'font-semibold text-danger-text')}>{fmtDay(i.due_date)}{overdue ? ' (en retard)' : ''}</span>{i.payment_terms ? ` · ${i.payment_terms}` : ''}</span>}
        </div>
        {draft && <Alert tone="info">Brouillon sans numéro : les quantités ne peuvent pas dépasser le reste à facturer de la commande (contrôlé à l’émission).</Alert>}
        {i.status === 'credited' && <Alert tone="info">Facture entièrement créditée par avoir.</Alert>}
        <section className="rounded-md border border-line bg-white shadow-card">
          {draft && canWrite && <InvoiceHeaderForm i={i} />}
          {!draft && i.notes && <p className="border-b border-line px-4 py-2 text-sm text-ink-soft">{i.notes}</p>}
          <DocLines lines={lines} editable={draft && canWrite} update={updateInvoiceLineAction} remove={deleteInvoiceLineAction} currency={i.currency} />
          <Totals subtotal={i.subtotal} tax={i.tax_amount} total={i.total} rate={i.tax_rate} currency={i.currency}
            extra={!draft && i.status !== 'cancelled' ? (<>
              {i.credited_amount > 0 && <><dt className="text-ink-soft">Avoirs</dt><dd className="text-right tabular-nums">− {money(i.credited_amount, i.currency)}</dd></>}
              <dt className="text-ink-soft">Payé</dt><dd className="text-right tabular-nums">{money(i.paid_amount, i.currency)}</dd>
              <dt className="font-semibold">Solde</dt><dd className="text-right font-semibold tabular-nums">{money(i.balance, i.currency)}</dd></>) : undefined} />
          {draft && canWrite && !order && <AddInvoiceLine invoiceId={i.id} />}
        </section>
        {payments.length > 0 && (
          <section className="space-y-2"><h2 className="text-base font-semibold">Encaissements</h2>
            <ul className="divide-y divide-line rounded-md border border-line bg-white shadow-card">
              {payments.map((p) => <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm"><span>{fmtDay(p.paid_on)} · {PAY_METHODS.find((m) => m.value === p.method)?.label}{p.reference ? ` · ${p.reference}` : ''}</span><span className="font-semibold tabular-nums">{money(p.amount, i.currency)}</span></li>)}
            </ul></section>
        )}
        {cns.length > 0 && (
          <section className="space-y-2"><h2 className="text-base font-semibold">Avoirs</h2>
            <ul className="divide-y divide-line rounded-md border border-line bg-white shadow-card">
              {cns.map((c) => <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm"><Link href={`/commercial/credit-notes/${c.id}`} className="font-mono font-semibold text-brand-700 hover:underline">{c.code ?? 'Brouillon'}</Link><span className="text-ink-soft">{c.reason}</span><span className="tabular-nums">{money(c.total, i.currency)}</span><Badge tone={CREDIT_STATUS[c.status as keyof typeof CREDIT_STATUS].tone}>{CREDIT_STATUS[c.status as keyof typeof CREDIT_STATUS].label}</Badge></li>)}
            </ul></section>
        )}
      </div>
    </>
  )
}
