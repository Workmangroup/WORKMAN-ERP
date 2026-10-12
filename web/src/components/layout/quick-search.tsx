'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Search } from 'lucide-react'
import { useAuth } from '@/features/auth'
import { createClient } from '@/lib/supabase/client'
import { searchPages, visiblePages } from '@/lib/navigation/tree'
import { cn } from '@/lib/utils'

type Item = { key: string; label: string; sub: string; href: string }
type RecordHit = { kind: 'client' | 'supplier' | 'article'; id: string; label: string; sublabel: string | null; href: string }

const KIND_LABEL: Record<RecordHit['kind'], string> = { client: 'Client', supplier: 'Fournisseur', article: 'Article' }

/**
 * Recherche rapide : écrans (filtrés par droits) et fiches (fonction global_search, autorisée côté base).
 * Clavier : Ctrl/⌘ + K pour aller au champ, flèches pour choisir, Entrée pour ouvrir, Échap pour fermer.
 */
export function QuickSearch() {
  const router = useRouter()
  const { permissions } = useAuth()
  const pages = useMemo(() => visiblePages(permissions), [permissions])
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [focused, setFocused] = useState(false)
  const [records, setRecords] = useState<RecordHit[]>([])
  const [recordError, setRecordError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const pageHits = useMemo(() => searchPages(pages, query), [pages, query])

  const items: Item[] = useMemo(() => [
    ...pageHits.map((p) => ({ key: `p-${p.href}`, label: p.label, sub: p.group, href: p.href })),
    ...records.map((r) => ({ key: `r-${r.kind}-${r.id}`, label: r.label, sub: `${KIND_LABEL[r.kind]}${r.sublabel ? ` · ${r.sublabel}` : ''}`, href: r.href })),
  ], [pageHits, records])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  // Fiches : interrogation après une courte pause de saisie (2 caractères minimum)
  useEffect(() => {
    const term = query.trim()
    if (term.length < 2) { setRecords([]); setRecordError(null); return }
    let cancelled = false
    const timer = setTimeout(async () => {
      const { data, error } = await createClient().rpc('global_search', { p_query: term, p_limit: 8 })
      if (cancelled) return
      if (error) { setRecords([]); setRecordError('La recherche de fiches est indisponible pour le moment.'); return }
      setRecordError(null)
      setRecords((data ?? []) as RecordHit[])
    }, 250)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [query])

  useEffect(() => setActive(0), [query])

  const go = (href: string) => {
    setQuery('')
    inputRef.current?.blur()
    router.push(href)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, items.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
    else if (e.key === 'Enter' && items[active]) { e.preventDefault(); go(items[active].href) }
    else if (e.key === 'Escape') { setQuery(''); inputRef.current?.blur() }
  }

  const showList = focused && query.trim().length > 0

  return (
    <div className="relative order-last w-full min-w-0 basis-full sm:order-none sm:basis-auto sm:flex-1 sm:max-w-xl">
      <label className="relative block w-full">
        <span className="sr-only">Rechercher un écran ou une fiche</span>
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-white/70" aria-hidden />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 120)}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded={showList}
          aria-controls="quick-search-list"
          aria-autocomplete="list"
          aria-activedescendant={showList && items[active] ? `qs-${active}` : undefined}
          placeholder="Rechercher un écran ou une fiche…"
          className="h-8 w-full rounded-sm border border-white/30 bg-white/10 pl-8 pr-14 text-sm text-white placeholder:text-white/75 focus:bg-white/15 focus:outline-none focus:ring-2 focus:ring-white/70"
        />
        <kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border border-white/35 px-1.5 text-[10px] text-white/80 sm:block">Ctrl K</kbd>
      </label>

      {showList && (
        <ul id="quick-search-list" role="listbox" aria-label="Résultats de recherche" className="absolute left-0 right-0 top-full z-40 mt-1 max-h-80 overflow-y-auto rounded-md border border-line bg-surface shadow-card">
          {items.length === 0 && !recordError && <li className="px-3 py-2 text-sm text-ink-soft">Aucun résultat pour « {query} ».</li>}
          {recordError && <li role="status" className="px-3 py-2 text-sm text-warn-text">{recordError}</li>}
          {items.map((r, i) => (
            <li
              id={`qs-${i}`}
              key={r.key}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => { e.preventDefault(); go(r.href) }}
              onMouseEnter={() => setActive(i)}
              className={cn('flex cursor-pointer items-center justify-between gap-3 rounded-sm px-3 py-2', i === active ? 'bg-brand-50 text-brand-700' : 'hover:bg-canvas')}
            >
              <span className="min-w-0 truncate font-medium">{r.label}</span>
              <span className="shrink-0 truncate text-xs text-ink-soft">{r.sub}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
