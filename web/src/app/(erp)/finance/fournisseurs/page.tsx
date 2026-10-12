import type { Metadata } from 'next'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { DisputeDialog, ResolveButton, SupplierInvoiceDialog, SupplierPaymentDialog } from '@/features/finance/components/finance-forms'
import { listSupplierInvoices, listSupplierPayments, suppliersOptions } from '@/features/finance/services/finance.service'
import { formatMoney } from '@/lib/bom/options'
import { P } from '@/lib/rbac/permissions'
import { formatDateTime } from '@/lib/utils'

export const metadata: Metadata = { title: 'Fournisseurs — factures et règlements' }

const STATUS: Record<string, { label: string; tone: 'neutral' | 'brand' | 'success' | 'warning' | 'danger' }> = {
  open: { label: 'À payer', tone: 'neutral' }, partially_paid: { label: 'Partiellement réglée', tone: 'brand' },
  paid: { label: 'Réglée', tone: 'success' }, disputed: { label: 'En litige', tone: 'danger' },
}
const METHOD: Record<string, string> = { transfer: 'Virement', cheque: 'Chèque', lc: 'LC', cash: 'Espèces', card: 'Carte', other: 'Autre' }

export default async function SupplierFinancePage() {
  const ctx = await requirePermission(P.FINANCE_READ)
  const canWrite = ctx.permissions.includes(P.FINANCE_WRITE)
  const [invoices, payments, suppliers] = await Promise.all([listSupplierInvoices(), listSupplierPayments(), canWrite ? suppliersOptions() : Promise.resolve([])])
  return (
    <>
      <PageHeader title="Fournisseurs : factures et règlements" description="Factures fournisseurs à régler, litiges et règlements. Les règlements s’affectent aux factures échues les plus anciennes."
        actions={canWrite && <div className="flex flex-wrap gap-2"><SupplierInvoiceDialog suppliers={suppliers} /><SupplierPaymentDialog suppliers={suppliers} /></div>} />
      <div className="space-y-6 p-4 sm:p-6">
        <section aria-label="Factures fournisseurs" className="space-y-2">
          <h2 className="text-sm font-semibold">Factures</h2>
          {invoices.length === 0 ? <p className="rounded-md border border-dashed border-line-strong bg-white p-8 text-center text-sm text-ink-soft">Aucune facture fournisseur.</p> : (
            <div className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
              <table className="w-full min-w-[52rem] text-sm">
                <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">N° interne</th><th className="px-2 py-2 font-semibold">Fournisseur</th><th className="px-2 py-2 font-semibold">Réf. fournisseur</th><th className="px-2 py-2 font-semibold">Échéance</th><th className="px-2 py-2 text-right font-semibold">Montant</th><th className="px-2 py-2 text-right font-semibold">Reste dû</th><th className="px-2 py-2 font-semibold">Statut</th><th className="px-2 py-2" /></tr></thead>
                <tbody className="divide-y divide-line">{invoices.map((f) => {
                  const st = STATUS[f.status] ?? STATUS.open
                  const balance = f.total - f.paid_amount
                  return (
                    <tr key={f.id} className="align-top">
                      <td className="px-4 py-2 font-mono text-xs">{f.number}</td>
                      <td className="px-2 py-2">{f.supplier_name}</td>
                      <td className="px-2 py-2 text-xs">{f.supplier_ref}</td>
                      <td className="px-2 py-2 text-xs">{formatDateTime(f.due_date)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{formatMoney(f.total)}</td>
                      <td className="px-2 py-2 text-right font-semibold tabular-nums">{formatMoney(balance)}</td>
                      <td className="px-2 py-2"><Badge tone={st.tone}>{st.label}</Badge>{f.dispute_reason && <span className="mt-1 block text-xs text-ink-soft">{f.dispute_reason}</span>}</td>
                      <td className="px-2 py-2 text-right">{canWrite && f.status !== 'paid' && (
                        f.status === 'disputed' ? <ResolveButton invoiceId={f.id} /> : <DisputeDialog invoiceId={f.id} />
                      )}</td>
                    </tr>
                  )
                })}</tbody>
              </table>
            </div>
          )}
        </section>
        <section aria-label="Règlements fournisseurs" className="space-y-2">
          <h2 className="text-sm font-semibold">Règlements</h2>
          {payments.length === 0 ? <p className="rounded-md border border-dashed border-line-strong bg-white p-8 text-center text-sm text-ink-soft">Aucun règlement.</p> : (
            <div className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
              <table className="w-full min-w-[40rem] text-sm">
                <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">N°</th><th className="px-2 py-2 font-semibold">Date</th><th className="px-2 py-2 font-semibold">Fournisseur</th><th className="px-2 py-2 font-semibold">Mode</th><th className="px-2 py-2 font-semibold">Référence</th><th className="px-2 py-2 text-right font-semibold">Montant</th></tr></thead>
                <tbody className="divide-y divide-line">{payments.map((p) => (
                  <tr key={p.id}><td className="px-4 py-2 font-mono text-xs">{p.number}</td><td className="px-2 py-2 text-xs">{formatDateTime(p.paid_on)}</td><td className="px-2 py-2">{p.supplier_name}</td><td className="px-2 py-2">{METHOD[p.method] ?? p.method}</td><td className="px-2 py-2 text-xs text-ink-soft">{p.reference ?? '—'}</td><td className="px-2 py-2 text-right tabular-nums">{formatMoney(p.amount)}</td></tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </>
  )
}
