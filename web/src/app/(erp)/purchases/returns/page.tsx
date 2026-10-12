import type { Metadata } from 'next'
import Link from 'next/link'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { listReturns } from '@/features/purchases/services/purchases.service'
import { fmtDay } from '@/features/purchases/status'
import { formatMoney } from '@/lib/bom/options'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Retours fournisseur' }

export default async function ReturnsPage() {
  await requirePermission(P.PURCHASES_READ)
  const rows = await listReturns()
  return (
    <>
      <PageHeader title="Retours fournisseur" description="Marchandise renvoyée au fournisseur : sortie de stock automatique, commande rouverte. Un retour se saisit depuis la fiche de la réception concernée." />
      <div className="p-4 sm:p-6">
        {rows.length === 0 ? <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">Aucun retour.</p> : (
          <div className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
            <table className="w-full min-w-[46rem] text-sm">
              <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Retour</th><th className="px-2 py-2 font-semibold">Réception</th><th className="px-2 py-2 font-semibold">Commande</th><th className="px-2 py-2 font-semibold">Fournisseur</th><th className="px-2 py-2 font-semibold">Date</th><th className="px-2 py-2 font-semibold">Motif</th><th className="px-4 py-2 text-right font-semibold">Valeur</th></tr></thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="px-4 py-2 font-mono font-semibold">{r.code}</td>
                    <td className="px-2 py-2"><Link href={`/purchases/receipts/${r.receipt_id}`} className="font-mono text-xs text-brand-700 hover:underline">{r.receipt_code}</Link></td>
                    <td className="px-2 py-2 font-mono text-xs">{r.po_no}</td><td className="px-2 py-2">{r.supplier_name}</td><td className="whitespace-nowrap px-2 py-2">{fmtDay(r.returned_at)}</td>
                    <td className="max-w-xs truncate px-2 py-2 text-ink-soft">{r.reason}</td><td className="px-4 py-2 text-right tabular-nums">{formatMoney(r.amount)}</td>
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
