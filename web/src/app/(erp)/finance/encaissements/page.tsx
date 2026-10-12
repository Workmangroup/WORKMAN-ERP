import type { Metadata } from 'next'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { ReceiptDialog } from '@/features/finance/components/finance-forms'
import { clientsOptions, listReceipts } from '@/features/finance/services/finance.service'
import { formatMoney } from '@/lib/bom/options'
import { P } from '@/lib/rbac/permissions'
import { formatDateTime } from '@/lib/utils'

export const metadata: Metadata = { title: 'Encaissements' }

const METHOD: Record<string, string> = { transfer: 'Virement', cheque: 'Chèque', lc: 'LC', cash: 'Espèces', card: 'Carte', other: 'Autre' }

export default async function ReceiptsPage() {
  const ctx = await requirePermission(P.FINANCE_READ)
  const canWrite = ctx.permissions.includes(P.FINANCE_WRITE) && ctx.permissions.includes(P.PAYMENTS_WRITE)
  const [rows, clients] = await Promise.all([listReceipts(), canWrite ? clientsOptions() : Promise.resolve([])])
  const total = rows.reduce((s, r) => s + r.amount, 0)
  return (
    <>
      <PageHeader title="Encaissements" description={`Journal des encaissements clients : ${formatMoney(total)} sur les ${rows.length} dernier(s) enregistrements.`}
        actions={canWrite && <ReceiptDialog clients={clients} />} />
      <div className="space-y-4 p-4 sm:p-6">
        {rows.length === 0 ? (
          <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">Aucun encaissement.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
            <table className="w-full min-w-[40rem] text-sm">
              <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Date</th><th className="px-2 py-2 font-semibold">Client</th><th className="px-2 py-2 font-semibold">Facture</th><th className="px-2 py-2 font-semibold">Mode</th><th className="px-2 py-2 font-semibold">Référence</th><th className="px-2 py-2 text-right font-semibold">Montant</th></tr></thead>
              <tbody className="divide-y divide-line">{rows.map((r) => (
                <tr key={r.id}>
                  <td className="px-4 py-2 text-xs text-ink-soft">{formatDateTime(r.paid_on)}</td>
                  <td className="px-2 py-2">{r.client_name}</td>
                  <td className="px-2 py-2 font-mono text-xs">{r.invoice_code ?? '—'}</td>
                  <td className="px-2 py-2">{METHOD[r.method] ?? r.method}</td>
                  <td className="px-2 py-2 text-xs text-ink-soft">{r.reference ?? '—'}</td>
                  <td className="px-2 py-2 text-right font-semibold tabular-nums text-success-text">{formatMoney(r.amount)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}
