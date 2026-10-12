'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Clock, ExternalLink, Layers, Network, Package, Percent, Search, Shirt } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { formatMoney, formatPct, formatQty, unitLabel } from '@/lib/bom/options'
import { cn } from '@/lib/utils'
import type { TreeItem } from '../tree-model'

const ICON: Record<TreeItem['kind'], React.ElementType> = { root: Shirt, group: Layers, material: Package, bom: Network, operation: Clock, overhead: Percent }

interface Row { item: TreeItem; depth: number; parent: string | null }

/** Ensembles d'identifiants dépliés par défaut : produit et groupes ouverts, sous-ensembles repliés. */
function defaultExpanded(root: TreeItem): Set<string> {
  const s = new Set<string>()
  const walk = (it: TreeItem, depth: number) => {
    if (it.kind === 'root' || (it.kind === 'group' && depth <= 1)) s.add(it.id)
    it.children.forEach((c) => walk(c, depth + 1))
  }
  walk(root, 0)
  return s
}
const allIds = (root: TreeItem) => {
  const s = new Set<string>()
  const walk = (it: TreeItem) => { if (it.children.length) s.add(it.id); it.children.forEach(walk) }
  walk(root)
  return s
}

/** Vue arbre interactive : déplier / replier, recherche, quantités par parent ou par pièce finie, panneau de détail, navigation clavier. */
export function TreeView({ root, costs }: { root: TreeItem; costs: boolean }) {
  const [expanded, setExpanded] = useState<Set<string>>(() => defaultExpanded(root))
  const [selected, setSelected] = useState<string>(root.id)
  const [query, setQuery] = useState('')
  const [cumulative, setCumulative] = useState(false)
  const listRef = useRef<HTMLUListElement>(null)

  const q = query.trim().toLowerCase()
  const matches = useCallback((it: TreeItem) => `${it.label} ${it.code ?? ''} ${it.sub ?? ''}`.toLowerCase().includes(q), [q])
  /** Branches contenant au moins une correspondance (recherche). */
  const keep = useMemo(() => {
    if (!q) return null
    const k = new Set<string>()
    const walk = (it: TreeItem): boolean => {
      let any = matches(it)
      for (const c of it.children) if (walk(c)) any = true
      if (any) k.add(it.id)
      return any
    }
    walk(root)
    return k
  }, [q, root, matches])

  const rows = useMemo(() => {
    const out: Row[] = []
    const walk = (it: TreeItem, depth: number, parent: string | null) => {
      if (keep && !keep.has(it.id)) return
      out.push({ item: it, depth, parent })
      const open = keep ? true : expanded.has(it.id)
      if (open) it.children.forEach((c) => walk(c, depth + 1, it.id))
    }
    walk(root, 0, null)
    return out
  }, [root, expanded, keep])

  const byId = useMemo(() => {
    const m = new Map<string, TreeItem>()
    const walk = (it: TreeItem) => { m.set(it.id, it); it.children.forEach(walk) }
    walk(root)
    return m
  }, [root])
  const current = byId.get(selected) ?? root
  const selVisible = rows.some((r) => r.item.id === current.id)

  const toggle = (id: string) => setExpanded((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const focusRow = (id: string) => setTimeout(() => listRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)?.focus(), 0)

  const onKey = (e: React.KeyboardEvent, i: number) => {
    const r = rows[i]
    const hasKids = r.item.children.length > 0
    const open = keep ? true : expanded.has(r.item.id)
    if (e.key === 'ArrowDown' && rows[i + 1]) { e.preventDefault(); focusRow(rows[i + 1].item.id) }
    else if (e.key === 'ArrowUp' && rows[i - 1]) { e.preventDefault(); focusRow(rows[i - 1].item.id) }
    else if (e.key === 'ArrowRight') { e.preventDefault(); if (hasKids && !open) toggle(r.item.id); else if (hasKids && rows[i + 1]) focusRow(rows[i + 1].item.id) }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); if (hasKids && open && !keep) toggle(r.item.id); else if (r.parent) focusRow(r.parent) }
    else if (e.key === 'Home') { e.preventDefault(); focusRow(rows[0].item.id) }
    else if (e.key === 'End') { e.preventDefault(); focusRow(rows[rows.length - 1].item.id) }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(r.item.id); if (hasKids && !keep) toggle(r.item.id) }
  }

  const qtyOf = (it: TreeItem) => {
    const v = cumulative ? it.totalQty : it.qty
    if (v === undefined) return null
    return `${formatQty(v)} ${it.unit === 'min' ? 'min' : unitLabel(it.unit)}`
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="min-w-0 rounded-md border border-line bg-white shadow-card">
        <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
          <div className="relative min-w-40 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filtrer l’arbre : composant, code, opération…" className="pl-8" aria-label="Filtrer l’arbre" />
          </div>
          <Button variant="secondary" size="sm" onClick={() => setExpanded(allIds(root))} title="Tout déplier"><ChevronsUpDown className="h-4 w-4" /> Tout déplier</Button>
          <Button variant="secondary" size="sm" onClick={() => setExpanded(new Set([root.id]))} title="Tout replier"><ChevronsDownUp className="h-4 w-4" /> Replier</Button>
          <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-soft">
            <input type="checkbox" checked={cumulative} onChange={(e) => setCumulative(e.target.checked)} className="h-4 w-4 accent-brand-500" />
            Besoin par pièce finie
          </label>
        </div>

        {rows.length === 0 ? (
          <p className="p-8 text-center text-sm text-ink-soft">Aucun élément ne correspond à « {query} ».</p>
        ) : (
          <ul ref={listRef} role="tree" aria-label="Arbre de la nomenclature" className="divide-y divide-line/60 py-1">
            {rows.map(({ item, depth }, i) => {
              const Icon = ICON[item.kind]
              const hasKids = item.children.length > 0
              const open = keep ? true : expanded.has(item.id)
              const isSel = item.id === current.id
              const qty = qtyOf(item)
              return (
                <li key={item.id} role="none">
                  <div
                    role="treeitem" data-id={item.id} aria-level={depth + 1} aria-expanded={hasKids ? open : undefined} aria-selected={isSel}
                    tabIndex={isSel || (!selVisible && i === 0) ? 0 : -1}
                    onClick={() => { setSelected(item.id) }}
                    onDoubleClick={() => hasKids && !keep && toggle(item.id)}
                    onKeyDown={(e) => onKey(e, i)}
                    className={cn('group relative flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500',
                      isSel ? 'bg-brand-50' : 'hover:bg-canvas')}
                    style={{ paddingLeft: `${12 + depth * 20}px` }}
                  >
                    {costs && item.share !== null && item.kind !== 'root' && (
                      <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0 bg-brand-100/50" style={{ width: `${Math.min(100, item.share * 100)}%` }} />
                    )}
                    <button type="button" tabIndex={-1} aria-label={open ? 'Replier' : 'Déplier'} disabled={!hasKids || Boolean(keep)}
                      onClick={(e) => { e.stopPropagation(); toggle(item.id) }}
                      className={cn('relative z-10 flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-ink-soft', hasKids ? 'hover:bg-line' : 'invisible')}>
                      {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    </button>
                    <Icon className={cn('relative z-10 h-4 w-4 shrink-0', item.kind === 'bom' || item.kind === 'root' ? 'text-brand-600' : item.kind === 'operation' ? 'text-warn-text' : 'text-ink-soft')} aria-hidden />
                    <span className="relative z-10 min-w-0 flex-1">
                      <span className={cn('truncate', item.kind === 'root' || item.kind === 'group' ? 'font-semibold' : 'font-medium')}>{item.label}</span>
                      {item.code && <span className="ml-2 font-mono text-xs text-ink-faint">{item.code}</span>}
                      {item.sub && <span className="ml-2 text-xs text-ink-soft">{item.sub}</span>}
                      {item.warning && <AlertTriangle className="ml-2 inline h-3.5 w-3.5 text-warn-text" aria-label={item.warning} />}
                    </span>
                    {item.waste ? <Badge className="relative z-10 hidden sm:inline-flex" tone="warning">+{formatPct(item.waste)}</Badge> : null}
                    {qty && <span className="relative z-10 hidden w-28 shrink-0 text-right tabular-nums text-ink-soft sm:block">{qty}</span>}
                    {costs && (
                      <span className={cn('relative z-10 w-24 shrink-0 text-right tabular-nums', item.kind === 'root' ? 'font-semibold' : '', item.missing && 'text-warn-text')}>
                        {item.cost === null ? '—' : formatMoney(item.cost)}
                      </span>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
        {costs && <p className="border-t border-line px-3 py-2 text-xs text-ink-soft">Coûts ramenés à une pièce finie. La barre de fond indique la part du coût de revient.</p>}
      </div>

      <aside aria-live="polite" className="h-fit rounded-md border border-line bg-white p-4 shadow-card lg:sticky lg:top-16">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Détail</p>
        <h3 className="mt-1 text-base font-semibold">{current.label}</h3>
        {current.code && <p className="font-mono text-xs text-ink-soft">{current.code}</p>}
        {current.warning && <p className="mt-2 flex items-center gap-1.5 rounded-sm bg-warn-bg px-2 py-1 text-xs text-warn-text"><AlertTriangle className="h-3.5 w-3.5" /> {current.warning}</p>}
        {current.details.length > 0 ? (
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
            {current.details.map(([k, v]) => (<div key={k} className="contents"><dt className="text-ink-soft">{k}</dt><dd className="text-right font-medium">{v}</dd></div>))}
          </dl>
        ) : (
          <p className="mt-3 text-sm text-ink-soft">{current.children.length} élément(s){costs && current.cost !== null ? ` · ${formatMoney(current.cost)}` : ''}</p>
        )}
        {current.href && <Link href={current.href} className="mt-3 inline-flex items-center gap-1.5 text-sm text-brand-600 hover:underline"><ExternalLink className="h-3.5 w-3.5" /> Ouvrir la nomenclature</Link>}
      </aside>
    </div>
  )
}
