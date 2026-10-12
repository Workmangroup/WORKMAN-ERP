import type { Metadata } from 'next'
import Link from 'next/link'
import { ChevronLeft, ChevronRight, Search } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { StockToolbar } from '@/features/stock/components/stock-toolbar'
import { PAGE_SIZE, listMovements, stockContext } from '@/features/stock/services/stock.service'
import { formatMoney, formatQty, unitLabel } from '@/lib/bom/options'
import { MOVEMENT_TYPES } from '@/lib/stock/options'
import { P } from '@/lib/rbac/permissions'
import { cn, formatDateTime } from '@/lib/utils'

export const metadata: Metadata = { title: 'Mouvements de stock' }

type SP = Partial<Record<'type' | 'q' | 'warehouse' | 'from' | 'to' | 'page', string>>

export default async function MovementsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await requirePermission(P.STOCK_READ)
  const sp = await searchParams
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1)
  const costs = ctx.permissions.includes(P.COSTS_READ)
  const [{ rows, total }, sc] = await Promise.all([listMovements({ ...sp, page }), stockContext(ctx.permissions)])
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const hasFilters = Boolean(sp.type || sp.q || sp.warehouse || sp.from || sp.to)
  const qs = (n: number) => {
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries({ type: sp.type, q: sp.q, warehouse: sp.warehouse, from: sp.from, to: sp.to, page: n })) if (v !== undefined && v !== '') p.set(k, String(v))
    return `/stock/movements?${p.toString()}`
  }

  return (
    <>
      <PageHeader title="Mouvements de stock" description="Historique complet et immuable : chaque mouvement détaille les lots FIFO consommés ou créés." />
      <div className="space-y-4 p-4 sm:p-6">
        <StockToolbar ctx={sc} />
        <form action="/stock/movements" role="search" className="space-y-3 rounded-md border border-line bg-white p-4 shadow-card">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
            <Input name="q" defaultValue={sp.q} placeholder="Composant (code, désignation)…" className="pl-8" aria-label="Rechercher par composant" />
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <div><Label htmlFor="type">Type</Label><Select id="type" name="type" defaultValue={sp.type ?? ''}><option value="">Tous</option>{Object.entries(MOVEMENT_TYPES).map(([k, t]) => <option key={k} value={k}>{t.label}</option>)}</Select></div>
            <div><Label htmlFor="warehouse">Entrepôt</Label><Select id="warehouse" name="warehouse" defaultValue={sp.warehouse ?? ''}><option value="">Tous</option>{sc.warehouses.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}</Select></div>
            <div><Label htmlFor="from">Du</Label><Input id="from" name="from" type="date" defaultValue={sp.from} /></div>
            <div><Label htmlFor="to">Au</Label><Input id="to" name="to" type="date" defaultValue={sp.to} /></div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit">Filtrer</Button>
            {hasFilters && <Link href="/stock/movements" className="text-sm text-brand-600 hover:underline">Réinitialiser</Link>}
            <span className="ml-auto text-sm text-ink-soft">{total} mouvement(s)</span>
          </div>
        </form>

        {rows.length === 0 ? (
          <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">Aucun mouvement.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
            <table className="w-full min-w-[60rem] text-sm">
              <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft">
                <tr><th className="px-4 py-2 font-semibold">Date</th><th className="px-2 py-2 font-semibold">Type</th><th className="px-2 py-2 font-semibold">Composant</th><th className="px-2 py-2 text-right font-semibold">Quantité</th><th className="px-2 py-2 font-semibold">De → vers</th><th className="px-2 py-2 font-semibold">Référence</th><th className="px-2 py-2 font-semibold">Par</th>{costs && <th className="px-4 py-2 text-right font-semibold">Valeur</th>}</tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((m) => {
                  const sign = m.direction === 'in' ? '+' : m.direction === 'out' ? '−' : '⇄'
                  return (
                    <tr key={m.id} className="align-top">
                      <td className="whitespace-nowrap px-4 py-2 text-xs text-ink-soft">{formatDateTime(m.created_at)}<span className="block font-mono text-[10px] text-ink-faint">#{m.seq}</span></td>
                      <td className="px-2 py-2"><Badge tone={MOVEMENT_TYPES[m.type].tone}>{MOVEMENT_TYPES[m.type].label}</Badge></td>
                      <td className="px-2 py-2"><span className="font-medium">{m.material_name}</span><span className="ml-2 font-mono text-xs text-ink-faint">{m.material_code}</span>
                        {m.allocations.length > 0 && (
                          <details className="mt-1 text-xs text-ink-soft"><summary className="cursor-pointer text-brand-600">Détail FIFO ({m.allocations.length} lot{m.allocations.length > 1 ? 's' : ''})</summary>
                            <ul className="mt-1 space-y-0.5">{m.allocations.map((a, i) => <li key={i}>{formatQty(a.qty)} {unitLabel(m.unit)} · lot du {formatDateTime(a.received_at)}{a.lot_ref ? ` · ${a.lot_ref}` : ''}</li>)}</ul>
                          </details>)}
                      </td>
                      <td className={cn('whitespace-nowrap px-2 py-2 text-right font-semibold tabular-nums', m.direction === 'in' ? 'text-success-text' : m.direction === 'out' ? 'text-danger-text' : '')}>{sign} {formatQty(m.qty)} {unitLabel(m.unit)}</td>
                      <td className="px-2 py-2 font-mono text-xs">{m.direction === 'move' ? `${m.warehouse_code}${m.location_code ? `/${m.location_code}` : ''} → ${m.to_warehouse_code}/${m.to_location_code}` : `${m.warehouse_code}${m.location_code ? `/${m.location_code}` : ''}`}</td>
                      <td className="px-2 py-2 text-xs">{m.reference ?? ''}{m.reason && <span className="block text-ink-soft">{m.reason}</span>}</td>
                      <td className="px-2 py-2 text-xs text-ink-soft">{m.actor ?? '—'}</td>
                      {costs && <td className="px-4 py-2 text-right tabular-nums">{m.total_cost === null ? '—' : formatMoney(m.total_cost)}</td>}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {totalPages > 1 && (
          <div className="flex items-center justify-between text-sm text-ink-soft">
            <span>Page {Math.min(page, totalPages)} / {totalPages}</span>
            <div className="flex gap-2">
              {page > 1 && <Link href={qs(page - 1)} className={buttonVariants({ variant: 'secondary', size: 'sm' })}><ChevronLeft className="h-4 w-4" /> Précédent</Link>}
              {page < totalPages && <Link href={qs(page + 1)} className={buttonVariants({ variant: 'secondary', size: 'sm' })}>Suivant <ChevronRight className="h-4 w-4" /></Link>}
            </div>
          </div>
        )}
      </div>
    </>
  )
}
