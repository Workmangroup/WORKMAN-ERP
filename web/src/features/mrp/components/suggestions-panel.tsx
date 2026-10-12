'use client'

import { Check, Download, RotateCcw, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatMoney, formatQty, unitLabel } from '@/lib/bom/options'
import { cn } from '@/lib/utils'
import { RpcButton } from '@/features/stock/components/rpc-button'
import { decideSuggestionAction } from '../actions'
import type { Suggestion } from '../types'

const STATUS = { proposed: { label: 'À traiter', tone: 'warning' }, accepted: { label: 'Acceptée', tone: 'success' }, rejected: { label: 'Rejetée', tone: 'neutral' } } as const
const fmt = (d: string) => new Intl.DateTimeFormat('fr-FR', { timeZone: 'UTC' }).format(new Date(`${d.slice(0, 10)}T00:00:00Z`))

function exportCsv(rows: Suggestion[], asOf: string) {
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
  const head = ['Fournisseur', 'Code', 'Composant', 'Quantité', 'Unité', 'Besoin le', 'Commander avant', 'En retard', 'Statut']
  const lines = rows.map((r) => [r.supplier_name ?? 'À définir', r.material_code, r.material_name, String(r.qty).replace('.', ','), unitLabel(r.unit), r.need_date, r.release_date, r.late ? 'oui' : 'non', STATUS[r.status].label].map(esc).join(';'))
  const blob = new Blob(['﻿' + [head.map(esc).join(';'), ...lines].join('\r\n')], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob); a.download = `suggestions-achat-${asOf}.csv`; a.click()
  URL.revokeObjectURL(a.href)
}

/** Suggestions d'achat groupées par fournisseur : à accepter ou rejeter (valeur estimée avec costs.read). */
export function SuggestionsPanel({ rows, asOf, canWrite, costs }: { rows: Suggestion[]; asOf: string; canWrite: boolean; costs: boolean }) {
  if (rows.length === 0) return <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">Aucune suggestion d’achat : les besoins sont couverts.</p>
  const groups = new Map<string, Suggestion[]>()
  for (const r of rows) { const k = r.supplier_name ?? '— Fournisseur à définir —'; groups.set(k, [...(groups.get(k) ?? []), r]) }
  const total = costs ? rows.reduce((a, r) => a + (r.unit_cost === null ? 0 : r.unit_cost * r.qty), 0) : null
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-soft">{rows.length} ligne(s) · {rows.filter((r) => r.late).length} en retard{total !== null ? ` · valeur estimée ${formatMoney(total)}` : ''}</p>
        <Button variant="secondary" size="sm" onClick={() => exportCsv(rows, asOf)}><Download className="h-4 w-4" /> Exporter en CSV</Button>
      </div>
      {[...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([sup, list]) => {
        const value = costs ? list.reduce((a, r) => a + (r.unit_cost === null ? 0 : r.unit_cost * r.qty), 0) : null
        return (
          <section key={sup} className="rounded-md border border-line bg-white shadow-card">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5">
              <h3 className="font-semibold">{sup}</h3>
              <span className="text-xs text-ink-soft">{list.length} ligne(s){value !== null ? ` · ${formatMoney(value)}` : ''}</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[46rem] text-sm">
                <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Composant</th><th className="px-2 py-2 text-right font-semibold">Quantité</th><th className="px-2 py-2 font-semibold">Besoin le</th><th className="px-2 py-2 font-semibold">Commander avant</th>{costs && <th className="px-2 py-2 text-right font-semibold">Valeur</th>}<th className="px-2 py-2 font-semibold">Statut</th>{canWrite && <th className="px-4 py-2" />}</tr></thead>
                <tbody className="divide-y divide-line">
                  {list.map((r) => (
                    <tr key={r.id} className={cn('align-top', r.late && r.status === 'proposed' && 'bg-danger-bg/30')}>
                      <td className="px-4 py-2"><span className="font-medium">{r.material_name}</span><span className="ml-2 font-mono text-xs text-ink-faint">{r.material_code}</span></td>
                      <td className="px-2 py-2 text-right font-semibold tabular-nums">{formatQty(r.qty)} {unitLabel(r.unit)}</td>
                      <td className="whitespace-nowrap px-2 py-2">{fmt(r.need_date)}</td>
                      <td className="whitespace-nowrap px-2 py-2">{fmt(r.release_date)}{r.late && <Badge tone="danger" className="ml-2">En retard</Badge>}</td>
                      {costs && <td className="px-2 py-2 text-right tabular-nums">{r.unit_cost === null ? '—' : formatMoney(r.unit_cost * r.qty)}</td>}
                      <td className="px-2 py-2"><Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>{r.note && <span className="block text-xs text-ink-soft">{r.note}</span>}</td>
                      {canWrite && (
                        <td className="px-4 py-2">
                          <div className="flex justify-end gap-1">
                            {r.status !== 'accepted' && <RpcButton action={decideSuggestionAction} fields={{ id: r.id, status: 'accepted' }} variant="secondary" size="sm"><Check className="h-4 w-4" /> Accepter</RpcButton>}
                            {r.status !== 'rejected' && <RpcButton action={decideSuggestionAction} fields={{ id: r.id, status: 'rejected' }} variant="ghost" size="sm"><X className="h-4 w-4" /> Rejeter</RpcButton>}
                            {r.status !== 'proposed' && <RpcButton action={decideSuggestionAction} fields={{ id: r.id, status: 'proposed' }} variant="ghost" size="sm" aria-label="Remettre à l’étude" title="Remettre à l’étude"><RotateCcw className="h-4 w-4" /></RpcButton>}
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )
      })}
      <p className="text-xs text-ink-soft">Les suggestions ne créent pas de commande d’achat : le module Achats les reprendra. « Commander avant » = date de besoin − délai d’approvisionnement.</p>
    </div>
  )
}
