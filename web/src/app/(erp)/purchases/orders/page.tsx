import type { Metadata } from 'next'
import Link from 'next/link'
import { Plus, Search } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { listOrders, supplierOptions } from '@/features/purchases/services/purchases.service'
import { PO_STATUS, fmtDay } from '@/features/purchases/status'
import { formatMoney, formatQty } from '@/lib/bom/options'
import { P } from '@/lib/rbac/permissions'
import { cn } from '@/lib/utils'

export const metadata: Metadata = { title: 'Commandes fournisseur' }

export default async function OrdersPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; supplier?: string; request?: string }> }) {
  const ctx = await requirePermission(P.PURCHASES_READ)
  const sp = await searchParams
  const [rows, suppliers] = await Promise.all([listOrders(sp), supplierOptions()])
  const today = new Date().toISOString().slice(0, 10)
  return (
    <>
      <PageHeader title="Commandes fournisseur" description="Bons de commande : brouillon → envoyée → reçue (partiellement ou totalement)."
        actions={ctx.permissions.includes(P.PURCHASES_WRITE) && <Link href="/purchases/orders/new" className={buttonVariants({ variant: 'command', size: 'sm' })}><Plus className="h-4 w-4" /> Commande directe</Link>} />
      <div className="space-y-4 p-4 sm:p-6">
        <form action="/purchases/orders" role="search" className="grid gap-3 rounded-md border border-line bg-white p-4 shadow-card md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end">
          {sp.request && <input type="hidden" name="request" value={sp.request} />}
          <div className="relative"><Label htmlFor="q">Recherche</Label><Search className="pointer-events-none absolute left-2.5 top-[2.1rem] h-4 w-4 text-ink-faint" /><Input id="q" name="q" defaultValue={sp.q} placeholder="N° de commande, notes…" className="pl-8" /></div>
          <div><Label htmlFor="supplier">Fournisseur</Label><Select id="supplier" name="supplier" defaultValue={sp.supplier ?? ''}><option value="">Tous</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></div>
          <div><Label htmlFor="status">Statut</Label><Select id="status" name="status" defaultValue={sp.status ?? ''}><option value="">Tous</option>{Object.entries(PO_STATUS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}</Select></div>
          <Button type="submit">Filtrer</Button>
        </form>
        {sp.request && <p className="text-sm text-ink-soft">Commandes issues de la demande sélectionnée. <Link href="/purchases/orders" className="text-brand-600 hover:underline">Voir toutes</Link></p>}
        {rows.length === 0 ? <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">Aucune commande.</p> : (
          <div className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
            <table className="w-full min-w-[52rem] text-sm">
              <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Commande</th><th className="px-2 py-2 font-semibold">Fournisseur</th><th className="px-2 py-2 font-semibold">Date</th><th className="px-2 py-2 font-semibold">Échéance</th><th className="px-2 py-2 text-right font-semibold">Avancement</th><th className="px-2 py-2 text-right font-semibold">Montant</th><th className="px-2 py-2 font-semibold">Statut</th></tr></thead>
              <tbody className="divide-y divide-line">
                {rows.map((o) => {
                  const late = ['sent', 'partial'].includes(o.status) && o.expected_date && o.expected_date.slice(0, 10) < today
                  return (
                    <tr key={o.id}>
                      <td className="px-4 py-2"><Link href={`/purchases/orders/${o.id}`} className="font-mono font-semibold text-brand-700 hover:underline">{o.po_no}</Link></td>
                      <td className="px-2 py-2">{o.supplier_name}</td><td className="whitespace-nowrap px-2 py-2">{fmtDay(o.order_date)}</td>
                      <td className={cn('whitespace-nowrap px-2 py-2', late && 'font-semibold text-danger-text')}>{fmtDay(o.expected_date)}{late && <span className="block text-xs">En retard</span>}</td>
                      <td className="px-2 py-2 text-right tabular-nums text-ink-soft">{o.status === 'draft' || o.status === 'cancelled' ? '—' : `${formatQty(o.received)} / ${formatQty(o.ordered)}`}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{formatMoney(o.total_amount)}</td>
                      <td className="px-2 py-2"><Badge tone={PO_STATUS[o.status].tone}>{PO_STATUS[o.status].label}</Badge></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}
