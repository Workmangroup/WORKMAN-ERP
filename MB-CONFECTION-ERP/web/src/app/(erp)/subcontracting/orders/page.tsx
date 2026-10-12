import type { Metadata } from 'next'
import Link from 'next/link'
import { AlertTriangle, Plus, Search } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { listOrders, subcontractorOptions } from '@/features/subcontracting/services/subcontracting.service'
import { ORDER_STATUS, serviceLabel } from '@/lib/subcontracting/options'
import { P } from '@/lib/rbac/permissions'
import { fmtDay } from '@/features/orders/status'

export const metadata: Metadata = { title: 'Commandes de sous-traitance' }

type SP = Partial<Record<'q' | 'status' | 'sub' | 'late', string>>

export default async function OrdersPage({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await requirePermission(P.SUBCONTRACT_READ)
  const sp = await searchParams
  const [rows, subs] = await Promise.all([listOrders({ status: sp.status, sub: sp.sub, q: sp.q, late: sp.late === '1' }), subcontractorOptions()])
  const canWrite = ctx.permissions.includes(P.SUBCONTRACT_WRITE)
  return (
    <>
      <PageHeader title="Commandes de sous-traitance" description="Chaque commande suit son parcours : envoi, réception, contrôle qualité, entrée en stock, clôture."
        actions={canWrite && <Link href="/subcontracting/orders/new" className={buttonVariants({ variant: 'command', size: 'sm' })}><Plus className="h-4 w-4" /> Nouvelle commande</Link>} />
      <div className="space-y-4 p-4 sm:p-6">
        <form action="/subcontracting/orders" role="search" className="grid gap-3 rounded-md border border-line bg-white p-4 shadow-card md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end">
          <div className="relative"><Label htmlFor="q">Recherche</Label><Search className="pointer-events-none absolute left-2.5 top-[2.1rem] h-4 w-4 text-ink-faint" /><Input id="q" name="q" defaultValue={sp.q} placeholder="Code SC-, travail demandé…" className="pl-8" /></div>
          <div><Label htmlFor="status">Statut</Label><Select id="status" name="status" defaultValue={sp.status ?? ''}><option value="">Tous</option>{Object.entries(ORDER_STATUS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}</Select></div>
          <div><Label htmlFor="sub">Sous-traitant</Label><Select id="sub" name="sub" defaultValue={sp.sub ?? ''}><option value="">Tous</option>{subs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></div>
          <div><Label htmlFor="late">Échéance</Label><Select id="late" name="late" defaultValue={sp.late ?? ''}><option value="">Toutes</option><option value="1">En retard uniquement</option></Select></div>
          <Button type="submit">Filtrer</Button>
        </form>
        {rows.length === 0 ? <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">Aucune commande.</p> : (
          <div className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
            <table className="w-full min-w-[60rem] text-sm">
              <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Commande</th><th className="px-2 py-2 font-semibold">Sous-traitant</th><th className="px-2 py-2 font-semibold">Prestation</th><th className="px-2 py-2 font-semibold">Travail</th><th className="px-2 py-2 text-right font-semibold">Pièces</th><th className="px-2 py-2 font-semibold">Retour prévu</th><th className="px-2 py-2 font-semibold">Statut</th></tr></thead>
              <tbody className="divide-y divide-line">
                {rows.map((o) => {
                  const late = (o.status === 'sent' || o.status === 'partially_received') && o.due_date && o.due_date < new Date().toISOString().slice(0, 10)
                  return (
                    <tr key={o.id}>
                      <td className="px-4 py-2"><Link href={`/subcontracting/orders/${o.id}`} className="font-mono font-semibold text-brand-700 hover:underline">{o.code}</Link>{o.product_code && <span className="block font-mono text-xs text-ink-soft">{o.product_code}</span>}</td>
                      <td className="px-2 py-2">{o.subcontractor}</td>
                      <td className="px-2 py-2">{serviceLabel(o.service)}</td>
                      <td className="max-w-xs truncate px-2 py-2 text-ink-soft">{o.description}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{o.qty_received} / {o.qty}</td>
                      <td className={`whitespace-nowrap px-2 py-2 ${late ? 'font-semibold text-danger-text' : ''}`}>{late && <AlertTriangle className="mr-1 inline h-3.5 w-3.5" aria-hidden />}{fmtDay(o.due_date)}</td>
                      <td className="px-2 py-2"><Badge tone={ORDER_STATUS[o.status as keyof typeof ORDER_STATUS].tone}>{ORDER_STATUS[o.status as keyof typeof ORDER_STATUS].label}</Badge></td>
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
