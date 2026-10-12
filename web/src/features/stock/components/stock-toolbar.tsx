'use client'

import { ArrowLeftRight, ArrowDownToLine, ArrowUpFromLine, Bell, Lock, SlidersHorizontal } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatQty, label, MATERIAL_CATEGORIES, unitLabel } from '@/lib/bom/options'
import { cn } from '@/lib/utils'
import type { OverviewRow } from '../types'
import { useStockDialogs, type StockContext } from './stock-dialogs'

function Buttons({ ctx, open }: { ctx: StockContext; open: ReturnType<typeof useStockDialogs>['open'] }) {
  if (!ctx.canWrite && !ctx.canAdjust) return null
  return (
    <div className="flex flex-wrap gap-2">
      {ctx.canWrite && <>
        <Button size="sm" onClick={() => open('in')}><ArrowDownToLine className="h-4 w-4" /> Entrée</Button>
        <Button size="sm" variant="secondary" onClick={() => open('out')}><ArrowUpFromLine className="h-4 w-4" /> Sortie</Button>
        <Button size="sm" variant="secondary" onClick={() => open('transfer')}><ArrowLeftRight className="h-4 w-4" /> Transfert</Button>
        <Button size="sm" variant="secondary" onClick={() => open('reserve')}><Lock className="h-4 w-4" /> Réserver</Button>
      </>}
      {ctx.canAdjust && <Button size="sm" variant="secondary" onClick={() => open('adjustment')}><SlidersHorizontal className="h-4 w-4" /> Ajustement</Button>}
    </div>
  )
}

/** Barre d'actions seule (pages Mouvements, Réservations). */
export function StockToolbar({ ctx }: { ctx: StockContext }) {
  const { open, element } = useStockDialogs(ctx)
  return <><Buttons ctx={ctx} open={open} />{element}</>
}

/** Vue d'ensemble : en stock / réservé / disponible / sécurité par composant et entrepôt, avec actions par ligne. */
export function OverviewTable({ rows, ctx }: { rows: OverviewRow[]; ctx: StockContext }) {
  const { open, element } = useStockDialogs(ctx)
  return (
    <div className="space-y-3">
      <Buttons ctx={ctx} open={open} />
      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">Aucun stock ne correspond. Enregistrez une entrée pour commencer.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
          <table className="w-full min-w-[52rem] text-sm">
            <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft">
              <tr>
                <th className="px-4 py-2 font-semibold">Composant</th><th className="px-2 py-2 font-semibold">Entrepôt</th>
                <th className="px-2 py-2 text-right font-semibold">En stock</th><th className="px-2 py-2 text-right font-semibold">Réservé</th>
                <th className="px-2 py-2 text-right font-semibold">Disponible</th><th className="px-2 py-2 text-right font-semibold">Sécurité</th>
                <th className="px-2 py-2 font-semibold">État</th>{ctx.canWrite && <th className="w-40 px-4 py-2" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => (
                <tr key={`${r.material_id}|${r.warehouse_id}`} className={cn(r.below_safety && 'bg-warn-bg/40')}>
                  <td className="px-4 py-2"><span className="font-medium">{r.material_name}</span><span className="ml-2 font-mono text-xs text-ink-faint">{r.material_code}</span><span className="block text-xs text-ink-soft">{label(MATERIAL_CATEGORIES, r.category)}</span></td>
                  <td className="px-2 py-2"><span className="font-mono text-xs">{r.warehouse_code}</span> <span className="text-ink-soft">{r.warehouse_name}</span></td>
                  <td className="px-2 py-2 text-right tabular-nums">{formatQty(r.on_hand)} {unitLabel(r.material_unit)}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-ink-soft">{formatQty(r.reserved)}</td>
                  <td className={cn('px-2 py-2 text-right font-semibold tabular-nums', r.available < 0 && 'text-danger-text')}>{formatQty(r.available)}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-ink-soft">{formatQty(r.safety_qty)}</td>
                  <td className="px-2 py-2">{r.below_safety ? <Badge tone="warning"><Bell className="mr-1 h-3 w-3" aria-hidden />Sous le seuil</Badge> : r.on_hand > 0 ? <Badge tone="success">OK</Badge> : <Badge>Vide</Badge>}</td>
                  {ctx.canWrite && (
                    <td className="px-4 py-2">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => open('in', { material_id: r.material_id, warehouse_id: r.warehouse_id })}>Entrée</Button>
                        <Button variant="ghost" size="sm" onClick={() => open('safety', { material_id: r.material_id, warehouse_id: r.warehouse_id, qty: r.safety_qty })}>Seuil</Button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {element}
    </div>
  )
}
