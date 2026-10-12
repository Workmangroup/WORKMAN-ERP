import type { Metadata } from 'next'
import Link from 'next/link'
import { Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { OverviewTable } from '@/features/stock/components/stock-toolbar'
import { listOverview, stockContext, stockValue } from '@/features/stock/services/stock.service'
import { MATERIAL_CATEGORIES, formatMoney } from '@/lib/bom/options'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Stocks' }

export default async function StockPage({ searchParams }: { searchParams: Promise<Partial<Record<'q' | 'warehouse' | 'category' | 'alerts', string>>> }) {
  const ctx = await requirePermission(P.STOCK_READ)
  const sp = await searchParams
  const [rows, sc, value] = await Promise.all([
    listOverview({ q: sp.q, warehouse: sp.warehouse, category: sp.category, alerts: sp.alerts === '1' }),
    stockContext(ctx.permissions),
    ctx.permissions.includes(P.COSTS_READ) ? stockValue() : Promise.resolve(null),
  ])
  const all = await listOverview({})
  const alerts = all.filter((r) => r.below_safety).length
  const refs = new Set(all.filter((r) => r.on_hand > 0).map((r) => r.material_id)).size
  const hasFilters = Boolean(sp.q || sp.warehouse || sp.category || sp.alerts)

  return (
    <>
      <PageHeader title="Stocks" description="Disponible = en stock − réservé. Les alertes signalent un disponible sous le stock de sécurité." />
      <div className="space-y-4 p-4 sm:p-6">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {([['Références en stock', String(refs), false], ['Entrepôts actifs', String(sc.warehouses.filter((w) => !w.archived_at).length), false], ['Sous le stock de sécurité', String(alerts), alerts > 0], ...(value !== null ? [['Valeur du stock (FIFO)', formatMoney(value), false] as const] : [])] as const).map(([k, v, warn]) => (
            <div key={k} className={`rounded-md border p-3 shadow-card ${warn ? 'border-warn/40 bg-warn-bg' : 'border-line bg-white'}`}>
              <p className="text-xs text-ink-soft">{k}</p><p className="text-xl font-semibold tabular-nums">{v}</p>
            </div>
          ))}
        </div>

        <form action="/stock" role="search" className="space-y-3 rounded-md border border-line bg-white p-4 shadow-card">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
            <Input name="q" defaultValue={sp.q} placeholder="Rechercher un composant (code, désignation)…" className="pl-8" aria-label="Rechercher un composant" />
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <div><Label htmlFor="warehouse">Entrepôt</Label><Select id="warehouse" name="warehouse" defaultValue={sp.warehouse ?? ''}><option value="">Tous</option>{sc.warehouses.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}</Select></div>
            <div><Label htmlFor="category">Catégorie</Label><Select id="category" name="category" defaultValue={sp.category ?? ''}><option value="">Toutes</option>{MATERIAL_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</Select></div>
            <div><Label htmlFor="alerts">Alertes</Label><Select id="alerts" name="alerts" defaultValue={sp.alerts ?? ''}><option value="">Toutes les lignes</option><option value="1">Sous le seuil uniquement</option></Select></div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit">Filtrer</Button>
            {hasFilters && <Link href="/stock" className="text-sm text-brand-600 hover:underline">Réinitialiser</Link>}
            <span className="ml-auto text-sm text-ink-soft">{rows.length} ligne(s)</span>
          </div>
        </form>

        <OverviewTable rows={rows} ctx={sc} />
      </div>
    </>
  )
}
