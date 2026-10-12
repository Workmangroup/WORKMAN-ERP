import type { Metadata } from 'next'
import { cn } from '@/lib/utils'
import Link from 'next/link'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { agingClients, agingSuppliers } from '@/features/finance/services/finance.service'
import { formatMoney } from '@/lib/bom/options'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Balances âgées' }

const today = () => new Date().toISOString().slice(0, 10)

export default async function AgingPage({ searchParams }: { searchParams: Promise<{ vue?: string; date?: string }> }) {
  await requirePermission(P.FINANCE_READ)
  const sp = await searchParams
  const vue = sp.vue === 'fournisseurs' ? 'fournisseurs' : 'clients'
  const asOf = sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : today()
  const rows = vue === 'clients' ? await agingClients(asOf) : await agingSuppliers(asOf)
  const sum = (k: string) => rows.reduce((s, r) => s + Number((r as unknown as Record<string, number>)[k] ?? 0), 0)
  const chip = (on: boolean) => cn('rounded-full border px-3 py-1', on ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-line bg-white text-ink-soft')
  const cols = [
    { k: 'cur', l: 'À échoir' }, { k: 'd1_30', l: '1-30 j' }, { k: 'd31_60', l: '31-60 j' }, { k: 'd61_90', l: '61-90 j' }, { k: 'd90_plus', l: '> 90 j' }, { k: 'total', l: 'Total' },
  ]
  return (
    <>
      <PageHeader title="Balances âgées" description="Soldes restant dus par tranche de retard à la date choisie. Une facture passe en tranche de retard après son échéance."
        actions={<form className="flex items-center gap-2 text-sm" action="/finance/balances"><input type="hidden" name="vue" value={vue} /><input type="date" name="date" defaultValue={asOf} className="rounded-md border border-line-strong px-2 py-1" /><button className="rounded-md border border-line-strong px-3 py-1" type="submit">Appliquer</button></form>} />
      <div className="space-y-4 p-4 sm:p-6">
        <div className="flex flex-wrap gap-2 text-sm">
          <Link href={`/finance/balances?vue=clients&date=${asOf}`} className={chip(vue === 'clients')}>Clients</Link>
          <Link href={`/finance/balances?vue=fournisseurs&date=${asOf}`} className={chip(vue === 'fournisseurs')}>Fournisseurs</Link>
          <span className="ml-auto text-ink-soft">au {asOf}</span>
        </div>
        {rows.length === 0 ? (
          <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">Aucun solde ouvert.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
            <table className="w-full min-w-[46rem] text-sm">
              <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">{vue === 'clients' ? 'Client' : 'Fournisseur'}</th>{cols.map((c) => <th key={c.k} className="px-2 py-2 text-right font-semibold">{c.l}</th>)}</tr></thead>
              <tbody className="divide-y divide-line">{rows.map((r, i) => {
                const rec = r as unknown as Record<string, string | number>
                return (
                  <tr key={i}>
                    <td className="px-4 py-2">{String(rec.cli_name ?? rec.sup_name)}</td>
                    {cols.map((c) => <td key={c.k} className={cn('px-2 py-2 text-right tabular-nums', c.k === 'd90_plus' && Number(rec[c.k]) > 0 && 'font-semibold text-danger-text', c.k === 'total' && 'font-semibold')}>{formatMoney(Number(rec[c.k]))}</td>)}
                  </tr>
                )
              })}</tbody>
              <tfoot className="border-t border-line bg-canvas font-semibold">
                <tr><td className="px-4 py-2">Total</td>{cols.map((c) => <td key={c.k} className="px-2 py-2 text-right tabular-nums">{formatMoney(sum(c.k))}</td>)}</tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </>
  )
}
