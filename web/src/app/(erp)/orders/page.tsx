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
import { ORDER_STATUS, fmtDay as fmt } from '@/features/orders/status'
import { listOrders } from '@/features/orders/services/orders.service'
import { INVOICE_LINK, money } from '@/features/commercial/status'
import { formatQty } from '@/lib/bom/options'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Commandes' }

export default async function OrdersPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string }> }) {
  const ctx = await requirePermission(P.ORDERS_READ)
  const sp = await searchParams
  const rows = await listOrders(sp)
  return (
    <>
      <PageHeader title="Commandes client" description="Socle des commandes : les commandes confirmées alimentent le calcul des besoins (MRP)."
        actions={ctx.permissions.includes(P.ORDERS_WRITE) && <Link href="/orders/new" className={buttonVariants({ variant: 'command', size: 'sm' })}><Plus className="h-4 w-4" /> Nouvelle commande</Link>} />
      <div className="space-y-4 p-4 sm:p-6">
        <form action="/orders" role="search" className="grid gap-3 rounded-md border border-line bg-white p-4 shadow-card md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto] md:items-end">
          <div className="relative"><Label htmlFor="q">Recherche</Label><Search className="pointer-events-none absolute left-2.5 top-[2.1rem] h-4 w-4 text-ink-faint" /><Input id="q" name="q" defaultValue={sp.q} placeholder="Code CMD, n° du client…" className="pl-8" /></div>
          <div><Label htmlFor="status">Statut</Label><Select id="status" name="status" defaultValue={sp.status ?? ''}><option value="">Tous</option>{Object.entries(ORDER_STATUS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}</Select></div>
          <Button type="submit">Filtrer</Button>
        </form>
        {rows.length === 0 ? <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">Aucune commande.</p> : (
          <div className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
            <table className="w-full min-w-[56rem] text-sm">
              <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Commande</th><th className="px-2 py-2 font-semibold">Client</th><th className="px-2 py-2 font-semibold">N° client</th><th className="px-2 py-2 text-right font-semibold">Lignes</th><th className="px-2 py-2 text-right font-semibold">Quantité</th><th className="px-2 py-2 text-right font-semibold">Total TTC</th><th className="px-2 py-2 font-semibold">1re livraison</th><th className="px-2 py-2 font-semibold">Facturation</th><th className="px-2 py-2 font-semibold">Statut</th></tr></thead>
              <tbody className="divide-y divide-line">
                {rows.map((o) => (
                  <tr key={o.id}>
                    <td className="px-4 py-2"><Link href={`/orders/${o.id}`} className="font-mono font-semibold text-brand-700 hover:underline">{o.code}</Link></td>
                    <td className="px-2 py-2">{o.client_name}</td><td className="px-2 py-2 text-ink-soft">{o.client_ref ?? '—'}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{o.line_count}</td><td className="px-2 py-2 text-right tabular-nums">{formatQty(o.total_qty)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{o.total > 0 ? money(o.total, o.currency) : '—'}</td>
                    <td className="whitespace-nowrap px-2 py-2">{fmt(o.next_due)}</td>
                    <td className="px-2 py-2">{o.status === 'draft' || o.status === 'cancelled' ? '—' : <Badge tone={INVOICE_LINK[o.invoice_status].tone}>{INVOICE_LINK[o.invoice_status].label}</Badge>}</td>
                    <td className="px-2 py-2"><Badge tone={ORDER_STATUS[o.status].tone}>{ORDER_STATUS[o.status].label}</Badge></td>
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
