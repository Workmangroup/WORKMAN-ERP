import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, XCircle } from 'lucide-react'
import { z } from 'zod'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { cancelCreditNoteAction, deleteCreditLineAction, updateCreditLineAction } from '@/features/commercial/actions'
import { DocLines, IssueCreditForm, Totals } from '@/features/commercial/components/doc-forms'
import { getCreditNote } from '@/features/commercial/services/commercial.service'
import { CREDIT_STATUS, fmtDay } from '@/features/commercial/status'
import { RpcButton } from '@/features/stock/components/rpc-button'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Avoir' }

export default async function CreditNotePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePermission(P.INVOICES_READ)
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const data = await getCreditNote(id)
  if (!data) notFound()
  const { note: n, invoice, lines } = data
  const draft = n.status === 'draft'
  const canWrite = ctx.permissions.includes(P.INVOICES_WRITE)
  return (
    <>
      <PageHeader title={n.code ?? 'Avoir brouillon'} description={`${n.client_name}${invoice ? ` · facture ${invoice.code ?? ''}` : ''}`}
        actions={<>
          <Link href="/commercial/credit-notes" className={buttonVariants({ variant: 'command', size: 'sm' })}><ArrowLeft className="h-4 w-4" /> Avoirs</Link>
          {invoice && <Link href={`/commercial/invoices/${invoice.id}`} className={buttonVariants({ variant: 'command', size: 'sm' })}>Facture</Link>}
          {draft && canWrite && <RpcButton action={cancelCreditNoteAction} fields={{ id: n.id }} variant="command" size="sm" className="text-danger-text" confirm="Annuler ce brouillon d’avoir ?"><XCircle className="h-4 w-4" /> Annuler le brouillon</RpcButton>}
        </>} />
      <div className="space-y-4 p-4 sm:p-6">
        <div className="flex flex-wrap items-center gap-3 text-sm"><Badge tone={CREDIT_STATUS[n.status].tone}>{CREDIT_STATUS[n.status].label}</Badge><span className="text-ink-soft">Motif : {n.reason}{n.issue_date ? ` · émis le ${fmtDay(n.issue_date)}` : ''}{n.reopen_order ? ' · quantités de la commande rouvertes' : ''}</span></div>
        {draft && <Alert tone="info">Ajustez les quantités à créditer (au plus la quantité facturée non encore créditée), supprimez les lignes sans objet, puis émettez l’avoir.</Alert>}
        <section className="rounded-md border border-line bg-white shadow-card">
          <DocLines lines={lines} editable={draft && canWrite} update={updateCreditLineAction} remove={deleteCreditLineAction} qtyOnly currency={n.currency} />
          <Totals subtotal={n.subtotal} tax={n.tax_amount} total={n.total} rate={n.tax_rate} currency={n.currency} />
          {draft && canWrite && <div className="border-t border-line bg-canvas/50 p-4"><IssueCreditForm id={n.id} hasOrder={Boolean(invoice?.has_order)} /></div>}
        </section>
      </div>
    </>
  )
}
