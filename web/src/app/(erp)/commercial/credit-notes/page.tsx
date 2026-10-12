import type { Metadata } from 'next'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { listCreditNotes } from '@/features/commercial/services/commercial.service'
import { CREDIT_STATUS, fmtDay, money } from '@/features/commercial/status'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Avoirs' }

export default async function CreditNotesPage() {
  await requirePermission(P.INVOICES_READ)
  const rows = await listCreditNotes()
  return (
    <>
      <PageHeader title="Avoirs" description="Corrections de factures émises (retour, remise, erreur). Un avoir se crée depuis la facture concernée ; son numéro est attribué à l’émission." />
      <div className="p-4 sm:p-6">
        {rows.length === 0 ? <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">Aucun avoir.</p> : (
          <div className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
            <table className="w-full min-w-[46rem] text-sm">
              <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Avoir</th><th className="px-2 py-2 font-semibold">Facture</th><th className="px-2 py-2 font-semibold">Client</th><th className="px-2 py-2 font-semibold">Émis le</th><th className="px-2 py-2 font-semibold">Motif</th><th className="px-2 py-2 text-right font-semibold">Total TTC</th><th className="px-2 py-2 font-semibold">Statut</th></tr></thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="px-4 py-2"><Link href={`/commercial/credit-notes/${r.id}`} className="font-mono font-semibold text-brand-700 hover:underline">{r.code ?? 'Brouillon'}</Link></td>
                    <td className="px-2 py-2"><Link href={`/commercial/invoices/${r.invoice_id}`} className="font-mono text-xs hover:underline">{r.invoice_code ?? '—'}</Link></td>
                    <td className="px-2 py-2">{r.client_name}</td><td className="whitespace-nowrap px-2 py-2">{fmtDay(r.issue_date)}</td><td className="max-w-xs truncate px-2 py-2 text-ink-soft">{r.reason}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{money(r.total, r.currency)}</td><td className="px-2 py-2"><Badge tone={CREDIT_STATUS[r.status].tone}>{CREDIT_STATUS[r.status].label}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}
