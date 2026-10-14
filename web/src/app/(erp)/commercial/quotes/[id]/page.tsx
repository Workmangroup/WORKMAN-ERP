import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, Copy, FileText, GitBranch, Send, ShieldCheck, ShoppingCart, XCircle } from 'lucide-react'
import { z } from 'zod'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { cancelQuoteAction, deleteQuoteLineAction, duplicateQuoteAction, quoteConvertAction, quoteRequestApprovalAction, quoteReviseAction, sendQuoteAction, updateQuoteLineAction } from '@/features/commercial/actions'
import { AddQuoteLine, DocLines, QuoteDecideDialog, QuoteHeaderForm, Totals } from '@/features/commercial/components/doc-forms'
import { getQuote, listQuoteVersions } from '@/features/commercial/services/commercial.service'
import { QUOTE_STATUS, fmtDay } from '@/features/commercial/status'
import { RpcButton } from '@/features/stock/components/rpc-button'
import { P } from '@/lib/rbac/permissions'
import { formatDateTime } from '@/lib/utils'

export const metadata: Metadata = { title: 'Devis' }

export default async function QuotePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePermission(P.QUOTES_READ)
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const data = await getQuote(id)
  if (!data) notFound()
  const { quote: q, party, lines, order, articles } = data
  const versions = await listQuoteVersions(id)
  const needsAccord = Boolean((q as { requires_approval?: boolean }).requires_approval)
  const perms = ctx.permissions
  const canWrite = perms.includes(P.QUOTES_WRITE)
  const draft = q.status === 'draft'
  const expired = q.status === 'sent' && q.valid_until < new Date().toISOString().slice(0, 10)
  return (
    <>
      <PageHeader title={q.code} description={`${party.name}${party.prospect ? ' (prospect)' : ''} · devis du ${fmtDay(q.quote_date)}`}
        actions={<>
          <Link href="/commercial/quotes" className={buttonVariants({ variant: 'command', size: 'sm' })}><ArrowLeft className="h-4 w-4" /> Devis</Link>
          <Link href={party.href} className={buttonVariants({ variant: 'command', size: 'sm' })}>{party.prospect ? 'Prospect' : 'Client'}</Link>
          {draft && canWrite && <RpcButton action={sendQuoteAction} fields={{ id: q.id }} variant="command" size="sm" confirm="Marquer le devis comme envoyé ? Il ne sera plus modifiable."><Send className="h-4 w-4" /> Envoyer</RpcButton>}
          {q.status === 'sent' && canWrite && !expired && <QuoteDecideDialog id={q.id} code={q.code} />}
          {['draft', 'sent'].includes(q.status) && canWrite && needsAccord && <RpcButton action={quoteRequestApprovalAction} fields={{ id: q.id }} variant="command" size="sm" confirm="Demander l’accord du responsable pour les remises hors seuil ?"><ShieldCheck className="h-4 w-4" /> Demander l’accord</RpcButton>}
          {['sent', 'accepted', 'rejected'].includes(q.status) && canWrite && <RpcButton action={quoteReviseAction} fields={{ id: q.id }} variant="command" size="sm" confirm="Créer une nouvelle version de ce devis ? L’ancienne version sera marquée remplacée."><GitBranch className="h-4 w-4" /> Réviser</RpcButton>}
          {q.status === 'accepted' && canWrite && perms.includes(P.ORDERS_WRITE) && !party.prospect && <RpcButton action={quoteConvertAction} fields={{ id: q.id }} variant="command" size="sm" confirm="Créer la commande client à partir de ce devis ? Un second envoi renvoie la même commande."><ShoppingCart className="h-4 w-4" /> Transformer en commande</RpcButton>}
          <a href={`/commercial/quotes/${q.id}/pdf`} target="_blank" rel="noopener" className={buttonVariants({ variant: 'command', size: 'sm' })}><FileText className="h-4 w-4" /> PDF</a>
          {canWrite && <RpcButton action={duplicateQuoteAction} fields={{ id: q.id }} variant="command" size="sm"><Copy className="h-4 w-4" /> Dupliquer</RpcButton>}
          {['draft', 'sent', 'accepted'].includes(q.status) && canWrite && <RpcButton action={cancelQuoteAction} fields={{ id: q.id }} variant="command" size="sm" className="text-danger-text" confirm="Annuler ce devis ?"><XCircle className="h-4 w-4" /> Annuler</RpcButton>}
        </>} />
      <div className="space-y-4 p-4 sm:p-6">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <Badge tone={QUOTE_STATUS[q.status].tone}>{QUOTE_STATUS[q.status].label}</Badge>
          <span className="text-ink-soft">Valable jusqu’au <span className={expired ? 'font-semibold text-danger-text' : ''}>{fmtDay(q.valid_until)}{expired ? ' (expiré)' : ''}</span> · livraison sous {q.lead_days} j{q.payment_terms ? ` · ${q.payment_terms}` : ''}{q.sent_at ? ` · envoyé le ${formatDateTime(q.sent_at)}` : ''}</span>
          {order && <Link href={`/orders/${order.id}`} className="text-brand-600 hover:underline">Commande {order.code}</Link>}
        </div>
        {needsAccord && ['draft', 'sent'].includes(q.status) && <Alert tone="warning">Remise au-delà du seuil : l’accord du responsable est requis avant l’envoi, l’acceptation ou la conversion.</Alert>}
        {expired && <Alert tone="warning">Ce devis a expiré sans réponse : il ne peut plus être accepté. Dupliquez-le pour le renouveler.</Alert>}
        {q.status === 'accepted' && party.prospect && <Alert tone="info">Devis accepté : convertissez d’abord le prospect en client (fiche prospect) pour créer la commande.</Alert>}
        {q.decided_at && <Alert tone={q.status === 'rejected' ? 'error' : 'success'}>{q.status === 'rejected' ? 'Refusé' : 'Accepté'} le {formatDateTime(q.decided_at)}{q.decision_reason ? ` — « ${q.decision_reason} »` : ''}</Alert>}
        <section className="rounded-md border border-line bg-white shadow-card">
          {draft && canWrite && <QuoteHeaderForm q={q} />}
          {!draft && q.notes && <p className="border-b border-line px-4 py-2 text-sm text-ink-soft">{q.notes}</p>}
          <DocLines lines={lines} editable={draft && canWrite} update={updateQuoteLineAction} remove={deleteQuoteLineAction} currency={q.currency} />
          <Totals subtotal={q.subtotal} tax={q.tax_amount} total={q.total} rate={q.tax_rate} currency={q.currency} />
          {draft && canWrite && <AddQuoteLine quoteId={q.id} articles={articles} canArticle={!party.prospect} />}
        </section>
        <section className="rounded-md border border-line bg-white p-4 shadow-card">
          <h2 className="text-sm font-semibold">Versions</h2>
          <ul className="mt-2 divide-y divide-line text-sm">
            <li className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>Version courante (v{(q as { version_no?: number }).version_no ?? 1}) · <span className="text-ink-soft">{QUOTE_STATUS[q.status].label}</span></span>
              <a href={`/commercial/quotes/${q.id}/pdf`} target="_blank" rel="noopener" className="text-brand-600 hover:underline">PDF</a>
            </li>
            {versions.map((v) => (
              <li key={v.seq} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>Version {v.seq} · {v.label === 'sent' ? 'envoyée' : v.label === 'accepted' ? 'acceptée' : 'demande d’accord'} · {formatDateTime(v.recorded_at)} <span className="font-mono text-xs text-ink-soft">{v.content_hash.slice(0, 12)}</span></span>
                <a href={`/commercial/quotes/${q.id}/pdf?seq=${v.seq}`} target="_blank" rel="noopener" className="text-brand-600 hover:underline">PDF</a>
              </li>
            ))}
            {versions.length === 0 && <li className="py-2 text-ink-soft">Aucune version historisée : elle est créée à l’envoi, à l’acceptation ou à la demande d’accord.</li>}
          </ul>
        </section>
      </div>
    </>
  )
}
