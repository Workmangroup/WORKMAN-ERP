'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { ArrowDown, ArrowUp, ArrowUpDown, Bookmark, Columns3, Download, Filter, MoreHorizontal, Printer, Search, Trash2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  PAGE_SIZES, matchesFilters, matchesSearch, pageWindow, paginate, sortRows, toCsv, toPrintHtml, toSpreadsheetXml,
  type SortState, type TableState,
} from '@/lib/data/table-utils'

export interface ColumnDef<T> {
  id: string
  label: string
  /** Valeur brute : sert au tri, au filtre, à la recherche et à l'export. */
  value: (row: T) => string | number | null
  /** Rendu visuel (défaut : la valeur brute). */
  render?: (row: T) => ReactNode
  align?: 'left' | 'right'
  filterable?: boolean
  searchable?: boolean
  /** Colonne toujours visible (ex. identifiant). */
  locked?: boolean
  defaultVisible?: boolean
}

export interface RowAction<T> {
  id: string
  label: string
  icon?: ReactNode
  href?: (row: T) => string
  onSelect?: (row: T) => void
  danger?: boolean
}

export interface DataTableProps<T> {
  /** Identifiant stable : sert à sauvegarder les vues de l'utilisateur. */
  tableId: string
  title: string
  rows: T[]
  columns: ColumnDef<T>[]
  rowKey: (row: T) => string
  actions?: RowAction<T>[]
  /** Libellé affiché quand aucune ligne ne correspond. */
  emptyText?: string
  /** Nom de fichier des exports (sans extension). */
  exportName?: string
}

const VIEWS_KEY = (id: string) => `mb-table-views:${id}`

function readViews(id: string): { name: string; state: TableState }[] {
  try { const raw = window.localStorage.getItem(VIEWS_KEY(id)); return raw ? JSON.parse(raw) : [] } catch { return [] }
}
function writeViews(id: string, views: { name: string; state: TableState }[]) {
  try { window.localStorage.setItem(VIEWS_KEY(id), JSON.stringify(views)) } catch { /* stockage indisponible : vues non conservées */ }
}

export function DataTable<T extends object>({ tableId, title, rows, columns, rowKey, actions = [], emptyText = 'Aucun élément.', exportName }: DataTableProps<T>) {
  const defaults = useMemo<TableState>(() => ({
    search: '', sort: null, filters: {},
    columns: columns.filter((c) => c.defaultVisible !== false).map((c) => c.id),
    pageSize: 25,
  }), [columns])

  const [state, setState] = useState<TableState>(defaults)
  const [page, setPage] = useState(1)
  const [views, setViews] = useState<{ name: string; state: TableState }[]>([])
  const [openPanel, setOpenPanel] = useState<null | 'filters' | 'columns' | 'export' | 'views'>(null)
  const [menuRow, setMenuRow] = useState<string | null>(null)
  const [viewName, setViewName] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => { setViews(readViews(tableId)) }, [tableId])
  useEffect(() => { setPage(1) }, [state.search, state.filters, state.sort, state.pageSize])

  // Fermeture des panneaux au clic extérieur et à Échap.
  useEffect(() => {
    if (!openPanel && !menuRow) return
    const onDown = (e: MouseEvent) => { if (panelRef.current && !panelRef.current.contains(e.target as Node)) { setOpenPanel(null); setMenuRow(null) } }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpenPanel(null); setMenuRow(null) } }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [openPanel, menuRow])

  // Raccourci « / » : place le curseur dans la recherche (hors champ de saisie).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(t.tagName)) { e.preventDefault(); searchRef.current?.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const searchable = columns.filter((c) => c.searchable !== false).map((c) => c.id)
  const visibleCols = columns.filter((c) => state.columns.includes(c.id) || c.locked)
  const filterCols = columns.filter((c) => c.filterable)

  // Valeurs distinctes pour les filtres (sur l'ensemble des lignes, pas seulement la page).
  const distinct = useMemo(() => {
    const out: Record<string, string[]> = {}
    for (const c of filterCols) {
      out[c.id] = [...new Set(rows.map((r) => String(c.value(r) ?? '')).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'fr', { numeric: true }))
    }
    return out
  }, [rows, filterCols])

  const processed = useMemo(() => {
    const filtered = rows.filter((r) => matchesSearch(r, state.search, searchable) && matchesFilters(r, state.filters))
    const byCol = (r: T, id: string) => { const c = columns.find((x) => x.id === id); return c ? c.value(r) : ((r as Record<string, unknown>)[id] as string) }
    const sorted = state.sort
      ? [...filtered].sort((a, b) => {
          const va = byCol(a, state.sort!.col)
          const vb = byCol(b, state.sort!.col)
          const ea = va === null || va === undefined || va === ''
          const eb = vb === null || vb === undefined || vb === ''
          if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1
          const m = state.sort!.dir === 'asc' ? 1 : -1
          if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * m
          return String(va).localeCompare(String(vb), 'fr', { numeric: true }) * m
        })
      : filtered
    return sorted
  }, [rows, state, columns, searchable])

  const slice = paginate(processed, page, state.pageSize)
  const activeFilters = Object.values(state.filters).reduce((n, v) => n + v.length, 0)

  const toggleSort = (id: string) => setState((s) => {
    const next: SortState | null = !s.sort || s.sort.col !== id ? { col: id, dir: 'asc' } : s.sort.dir === 'asc' ? { col: id, dir: 'desc' } : null
    return { ...s, sort: next }
  })
  const toggleFilter = (col: string, value: string) => setState((s) => {
    const cur = s.filters[col] ?? []
    const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value]
    return { ...s, filters: { ...s.filters, [col]: next } }
  })
  const toggleColumn = (id: string) => setState((s) => ({ ...s, columns: s.columns.includes(id) ? s.columns.filter((c) => c !== id) : [...s.columns, id] }))

  const exportRows = processed.map((r) => columns.filter((c) => state.columns.includes(c.id) || c.locked).map((c) => c.value(r)))
  const exportHeaders = columns.filter((c) => state.columns.includes(c.id) || c.locked).map((c) => c.label)
  const baseName = exportName ?? tableId

  const download = (content: string, name: string, type: string) => {
    const blob = new Blob(['﻿', content], { type })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const exportExcel = () => { download(toSpreadsheetXml(title, exportHeaders, exportRows), `${baseName}.xml`, 'application/vnd.ms-excel'); setOpenPanel(null); setMessage(`${exportRows.length} ligne(s) exportée(s) au format Excel.`) }
  const exportCsv = () => { download(toCsv(exportHeaders, exportRows), `${baseName}.csv`, 'text/csv;charset=utf-8'); setOpenPanel(null); setMessage(`${exportRows.length} ligne(s) exportée(s) en CSV.`) }
  const exportPdf = () => {
    const w = window.open('', '_blank', 'width=1100,height=800')
    if (!w) { setMessage('La fenêtre d’impression a été bloquée par le navigateur.'); return }
    w.document.open(); w.document.write(toPrintHtml(title, exportHeaders, exportRows)); w.document.close(); w.focus(); w.print()
    setOpenPanel(null)
  }

  const saveView = () => {
    const name = viewName.trim()
    if (name.length < 2) { setMessage('Donnez un nom à la vue (2 caractères minimum).'); return }
    const next = [...views.filter((v) => v.name !== name), { name, state }]
    setViews(next); writeViews(tableId, next); setViewName(''); setMessage(`Vue « ${name} » enregistrée.`)
  }
  const applyView = (name: string) => { const v = views.find((x) => x.name === name); if (v) setState(v.state) }
  const deleteView = (name: string) => { const next = views.filter((v) => v.name !== name); setViews(next); writeViews(tableId, next) }

  const SortIcon = ({ id }: { id: string }) => {
    if (state.sort?.col !== id) return <ArrowUpDown className="h-3 w-3 opacity-40" aria-hidden />
    return state.sort.dir === 'asc' ? <ArrowUp className="h-3 w-3" aria-hidden /> : <ArrowDown className="h-3 w-3" aria-hidden />
  }

  return (
    <div className="space-y-3" ref={panelRef}>
      {/* Barre d'outils : recherche instantanée, filtres, colonnes, vues, export */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-[14rem] flex-1">
          <span className="sr-only">Rechercher dans {title}</span>
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" aria-hidden />
          <input ref={searchRef} value={state.search} onChange={(e) => setState((s) => ({ ...s, search: e.target.value }))}
            placeholder="Rechercher…  ( / )" className="h-8 w-full rounded-md border border-line-strong bg-surface pl-8 pr-8 text-sm transition-colors duration-150 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500" />
          {state.search && <button type="button" onClick={() => setState((s) => ({ ...s, search: '' }))} className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-faint hover:text-ink" aria-label="Effacer la recherche"><X className="h-3.5 w-3.5" /></button>}
        </label>

        <div className="relative">
          <button type="button" onClick={() => setOpenPanel(openPanel === 'filters' ? null : 'filters')} aria-expanded={openPanel === 'filters'}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line-strong bg-surface px-3 text-sm hover:bg-canvas">
            <Filter className="h-3.5 w-3.5" aria-hidden /> Filtres{activeFilters > 0 && <span className="rounded-full bg-brand-500 px-1.5 text-[11px] text-white">{activeFilters}</span>}
          </button>
          {openPanel === 'filters' && (
            <div className="absolute right-0 z-30 mt-1 max-h-96 w-72 overflow-y-auto rounded-lg border border-line bg-surface p-3 shadow-pop">
              {filterCols.length === 0 && <p className="text-sm text-ink-soft">Aucun filtre disponible.</p>}
              {filterCols.map((c) => (
                <fieldset key={c.id} className="mb-3">
                  <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-faint">{c.label}</legend>
                  <div className="space-y-1">
                    {(distinct[c.id] ?? []).map((v) => (
                      <label key={v} className="flex items-center gap-2 text-sm">
                        <input type="checkbox" checked={(state.filters[c.id] ?? []).includes(v)} onChange={() => toggleFilter(c.id, v)} className="h-3.5 w-3.5 accent-brand-600" />
                        {v}
                      </label>
                    ))}
                  </div>
                </fieldset>
              ))}
              {activeFilters > 0 && <button type="button" onClick={() => setState((s) => ({ ...s, filters: {} }))} className="text-xs text-brand-700 hover:underline">Effacer les filtres</button>}
            </div>
          )}
        </div>

        <div className="relative">
          <button type="button" onClick={() => setOpenPanel(openPanel === 'columns' ? null : 'columns')} aria-expanded={openPanel === 'columns'}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line-strong bg-surface px-3 text-sm hover:bg-canvas">
            <Columns3 className="h-3.5 w-3.5" aria-hidden /> Colonnes
          </button>
          {openPanel === 'columns' && (
            <div className="absolute right-0 z-30 mt-1 w-56 rounded-lg border border-line bg-surface p-3 shadow-pop">
              {columns.map((c) => (
                <label key={c.id} className={cn('flex items-center gap-2 py-1 text-sm', c.locked && 'text-ink-faint')}>
                  <input type="checkbox" disabled={c.locked} checked={c.locked || state.columns.includes(c.id)} onChange={() => toggleColumn(c.id)} className="h-3.5 w-3.5 accent-brand-600" />
                  {c.label}{c.locked && <span className="text-[10px] uppercase">fixe</span>}
                </label>
              ))}
            </div>
          )}
        </div>

        <div className="relative">
          <button type="button" onClick={() => setOpenPanel(openPanel === 'views' ? null : 'views')} aria-expanded={openPanel === 'views'}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line-strong bg-surface px-3 text-sm hover:bg-canvas">
            <Bookmark className="h-3.5 w-3.5" aria-hidden /> Vues{views.length > 0 && <span className="text-ink-faint">({views.length})</span>}
          </button>
          {openPanel === 'views' && (
            <div className="absolute right-0 z-30 mt-1 w-72 rounded-lg border border-line bg-surface p-3 shadow-pop">
              <div className="flex gap-2">
                <input value={viewName} onChange={(e) => setViewName(e.target.value)} placeholder="Nom de la vue" maxLength={40}
                  className="h-8 flex-1 rounded-md border border-line-strong bg-surface px-2 text-sm" />
                <button type="button" onClick={saveView} className="h-8 rounded-md bg-brand-600 px-3 text-sm font-medium text-white hover:bg-brand-700">Enregistrer</button>
              </div>
              <p className="mt-1 text-[11px] text-ink-faint">Recherche, filtres, tri, colonnes et taille de page.</p>
              <ul className="mt-2 divide-y divide-line">
                {views.length === 0 && <li className="py-2 text-sm text-ink-soft">Aucune vue enregistrée.</li>}
                {views.map((v) => (
                  <li key={v.name} className="flex items-center justify-between py-1.5 text-sm">
                    <button type="button" onClick={() => { applyView(v.name); setOpenPanel(null) }} className="truncate text-left font-medium text-brand-700 hover:underline">{v.name}</button>
                    <button type="button" onClick={() => deleteView(v.name)} aria-label={`Supprimer la vue ${v.name}`} className="text-ink-faint hover:text-danger-text"><Trash2 className="h-3.5 w-3.5" /></button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="relative">
          <button type="button" onClick={() => setOpenPanel(openPanel === 'export' ? null : 'export')} aria-expanded={openPanel === 'export'}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line-strong bg-surface px-3 text-sm hover:bg-canvas">
            <Download className="h-3.5 w-3.5" aria-hidden /> Exporter
          </button>
          {openPanel === 'export' && (
            <div className="absolute right-0 z-30 mt-1 w-64 rounded-lg border border-line bg-surface p-1.5 shadow-pop">
              <button type="button" onClick={exportExcel} className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-canvas"><Download className="h-3.5 w-3.5" aria-hidden /> Excel (.xml, ouvrable dans Excel)</button>
              <button type="button" onClick={exportCsv} className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-canvas"><Download className="h-3.5 w-3.5" aria-hidden /> CSV (séparateur « ; »)</button>
              <button type="button" onClick={exportPdf} className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-canvas"><Printer className="h-3.5 w-3.5" aria-hidden /> PDF (impression → « Enregistrer en PDF »)</button>
              <p className="px-3 pb-1 pt-2 text-[11px] text-ink-faint">Exporte les {processed.length} ligne(s) filtrées et triées, pas seulement la page.</p>
            </div>
          )}
        </div>
      </div>

      {(activeFilters > 0 || state.search) && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-ink-soft">
          <span>{processed.length} résultat(s) sur {rows.length}</span>
          {Object.entries(state.filters).flatMap(([col, vals]) => vals.map((v) => (
            <button key={`${col}-${v}`} type="button" onClick={() => toggleFilter(col, v)} className="inline-flex items-center gap-1 rounded-full border border-line bg-surface px-2 py-0.5 hover:border-danger">
              {columns.find((c) => c.id === col)?.label} : {v} <X className="h-3 w-3" aria-hidden />
            </button>
          )))}
        </div>
      )}
      {message && <p role="status" className="text-xs text-brand-700">{message}</p>}

      {/* Tableau */}
      <div className="overflow-x-auto rounded-lg border border-line bg-surface shadow-card">
        <table className="w-full min-w-[48rem] text-sm">
          <caption className="sr-only">{title}</caption>
          <thead className="sticky top-0 z-10 border-b border-line bg-canvas text-xs text-ink-soft">
            <tr>
              {visibleCols.map((c, i) => (
                <th key={c.id} scope="col" aria-sort={state.sort?.col === c.id ? (state.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                  className={cn('whitespace-nowrap px-3 py-2 font-semibold', c.align === 'right' ? 'text-right' : 'text-left', i === 0 && 'sticky left-0 bg-canvas')}>
                  <button type="button" onClick={() => toggleSort(c.id)} className="inline-flex items-center gap-1 hover:text-ink">{c.label} <SortIcon id={c.id} /></button>
                </th>
              ))}
              {actions.length > 0 && <th scope="col" className="w-10 px-2 py-2"><span className="sr-only">Actions</span></th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {slice.rows.length === 0 && (
              <tr><td colSpan={visibleCols.length + (actions.length ? 1 : 0)} className="px-4 py-10 text-center text-ink-soft">
                {rows.length === 0 ? emptyText : 'Aucun résultat avec ces critères.'}
                {(activeFilters > 0 || state.search) && <button type="button" onClick={() => setState((s) => ({ ...s, search: '', filters: {} }))} className="ml-2 text-brand-700 hover:underline">Réinitialiser</button>}
              </td></tr>
            )}
            {slice.rows.map((r) => (
              <tr key={rowKey(r)} className="group transition-colors duration-150 hover:bg-brand-50/50 motion-reduce:transition-none">
                {visibleCols.map((c, i) => (
                  <td key={c.id} className={cn('px-3 py-2.5 align-middle', c.align === 'right' && 'text-right tabular-nums', i === 0 && 'sticky left-0 bg-surface group-hover:bg-brand-50/50')}>
                    {c.render ? c.render(r) : (c.value(r) ?? '—')}
                  </td>
                ))}
                {actions.length > 0 && (
                  <td className="px-2 py-2.5 text-right">
                    <div className="relative inline-block">
                      <button type="button" onClick={() => setMenuRow(menuRow === rowKey(r) ? null : rowKey(r))} aria-haspopup="menu" aria-expanded={menuRow === rowKey(r)}
                        aria-label="Actions rapides" className="rounded-md p-1 text-ink-faint hover:bg-canvas hover:text-ink"><MoreHorizontal className="h-4 w-4" /></button>
                      {menuRow === rowKey(r) && (
                        <div role="menu" className="absolute right-0 z-30 mt-1 w-44 rounded-lg border border-line bg-surface p-1 text-left shadow-pop">
                          {actions.map((a) => a.href ? (
                            <Link key={a.id} role="menuitem" href={a.href(r)} className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm hover:bg-canvas">{a.icon}{a.label}</Link>
                          ) : (
                            <button key={a.id} role="menuitem" type="button" onClick={() => { setMenuRow(null); a.onSelect?.(r) }}
                              className={cn('flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-canvas', a.danger && 'text-danger-text')}>{a.icon}{a.label}</button>
                          ))}
                        </div>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pied : taille de page et pagination intelligente */}
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-ink-soft">
        <div className="flex items-center gap-2">
          <span>{slice.from}–{slice.to} sur {slice.total}</span>
          <label className="flex items-center gap-1">
            Lignes
            <select value={state.pageSize} onChange={(e) => setState((s) => ({ ...s, pageSize: Number(e.target.value) }))} className="h-7 rounded-md border border-line-strong bg-surface px-1">
              {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        </div>
        {slice.pages > 1 && (
          <nav aria-label="Pagination" className="flex items-center gap-1">
            <button type="button" onClick={() => setPage(slice.page - 1)} disabled={slice.page === 1} className="h-7 rounded-md border border-line-strong px-2 disabled:opacity-40">Précédent</button>
            {pageWindow(slice.page, slice.pages).map((p, i) => p === '…'
              ? <span key={`e${i}`} className="px-1">…</span>
              : <button key={p} type="button" onClick={() => setPage(p)} aria-current={p === slice.page ? 'page' : undefined}
                  className={cn('h-7 min-w-7 rounded-md px-2', p === slice.page ? 'bg-brand-600 text-white' : 'border border-line-strong hover:bg-canvas')}>{p}</button>)}
            <button type="button" onClick={() => setPage(slice.page + 1)} disabled={slice.page === slice.pages} className="h-7 rounded-md border border-line-strong px-2 disabled:opacity-40">Suivant</button>
          </nav>
        )}
      </div>
    </div>
  )
}
