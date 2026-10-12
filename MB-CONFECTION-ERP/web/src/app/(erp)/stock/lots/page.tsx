import type { Metadata } from 'next'
import Link from 'next/link'
import { Search } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { listLots, listWarehouses } from '@/features/stock/services/stock.service'
import { formatMoney, formatQty, formatUnitPrice, unitLabel } from '@/lib/bom/options'
import { P } from '@/lib/rbac/permissions'
import { formatDateTime } from '@/lib/utils'

export const metadata: Metadata = { title: 'Lots FIFO' }

export default async function LotsPage({ searchParams }: { searchParams: Promise<Partial<Record<'q' | 'warehouse', string>>> }) {
  const ctx = await requirePermission(P.STOCK_READ)
  const sp = await searchParams
  const costs = ctx.permissions.includes(P.COSTS_READ)
  const [lots, warehouses] = await Promise.all([listLots(sp), listWarehouses()])
  // rang FIFO : par composant et entrepôt, le plus ancien sort en premier
  const rank = new Map<string, number>()
  const rows = lots.map((l) => { const k = `${l.material_id}|${l.warehouse_code}`; const r = (rank.get(k) ?? 0) + 1; rank.set(k, r); return { ...l, rank: r } })
  rows.sort((a, b) => a.material_name.localeCompare(b.material_name) || a.warehouse_code.localeCompare(b.warehouse_code) || a.rank - b.rank)
  return (
    <>
      <PageHeader title="Lots FIFO" description="Couches de stock par date de réception : la sortie consomme toujours le lot le plus ancien d’abord." />
      <div className="space-y-4 p-4 sm:p-6">
        <form action="/stock/lots" role="search" className="grid gap-3 rounded-md border border-line bg-white p-4 shadow-card md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto] md:items-end">
          <div className="relative"><Label htmlFor="q">Recherche</Label><Search className="pointer-events-none absolute left-2.5 top-[2.1rem] h-4 w-4 text-ink-faint" /><Input id="q" name="q" defaultValue={sp.q} placeholder="Composant, référence de lot…" className="pl-8" /></div>
          <div><Label htmlFor="warehouse">Entrepôt</Label><Select id="warehouse" name="warehouse" defaultValue={sp.warehouse ?? ''}><option value="">Tous</option>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}</Select></div>
          <div className="flex items-center gap-3"><Button type="submit">Filtrer</Button>{(sp.q || sp.warehouse) && <Link href="/stock/lots" className="text-sm text-brand-600 hover:underline">Réinitialiser</Link>}</div>
        </form>
        {rows.length === 0 ? <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">Aucun lot en stock.</p> : (
          <div className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
            <table className="w-full min-w-[52rem] text-sm">
              <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Composant</th><th className="px-2 py-2 font-semibold">Rang FIFO</th><th className="px-2 py-2 font-semibold">Reçu le</th><th className="px-2 py-2 font-semibold">Référence</th><th className="px-2 py-2 font-semibold">Emplacement</th><th className="px-2 py-2 text-right font-semibold">Reçu</th><th className="px-2 py-2 text-right font-semibold">Restant</th>{costs && <><th className="px-2 py-2 text-right font-semibold">Coût unit.</th><th className="px-4 py-2 text-right font-semibold">Valeur</th></>}</tr></thead>
              <tbody className="divide-y divide-line">
                {rows.map((l) => (
                  <tr key={l.id}>
                    <td className="px-4 py-2"><span className="font-medium">{l.material_name}</span><span className="ml-2 font-mono text-xs text-ink-faint">{l.material_code}</span></td>
                    <td className="px-2 py-2">{l.rank === 1 ? <Badge tone="brand">1er sorti</Badge> : <span className="text-ink-soft">n° {l.rank}</span>}</td>
                    <td className="whitespace-nowrap px-2 py-2 text-xs text-ink-soft">{formatDateTime(l.received_at)}</td>
                    <td className="px-2 py-2 text-xs">{l.reference ?? '—'}</td>
                    <td className="px-2 py-2 font-mono text-xs">{l.warehouse_code}/{l.location_code}</td>
                    <td className="px-2 py-2 text-right tabular-nums text-ink-soft">{formatQty(l.qty_in)}</td>
                    <td className="px-2 py-2 text-right font-semibold tabular-nums">{formatQty(l.qty_remaining)} {unitLabel(l.unit)}</td>
                    {costs && <><td className="px-2 py-2 text-right tabular-nums">{l.unit_cost === null ? '—' : formatUnitPrice(l.unit_cost)}</td><td className="px-4 py-2 text-right tabular-nums">{l.unit_cost === null ? '—' : formatMoney(l.unit_cost * l.qty_remaining)}</td></>}
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
