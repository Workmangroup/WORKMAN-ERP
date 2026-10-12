'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Search } from 'lucide-react'
import { useAuth } from '@/features/auth'
import { searchPages, visiblePages } from '@/lib/navigation/tree'
import { cn } from '@/lib/utils'

/** Recherche rapide des pages (Ctrl/⌘ + K). Ne parcourt que les écrans auxquels l'utilisateur a accès. */
export function QuickSearch() {
  const router = useRouter()
  const { permissions } = useAuth()
  const pages = useMemo(() => visiblePages(permissions), [permissions])
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [focused, setFocused] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const results = useMemo(() => searchPages(pages, query), [pages, query])

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

  useEffect(() => setActive(0), [query])

  const go = (href: string) => {
    setQuery('')
    inputRef.current?.blur()
    router.push(href)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
    else if (e.key === 'Enter' && results[active]) { e.preventDefault(); go(results[active].href) }
    else if (e.key === 'Escape') { setQuery(''); inputRef.current?.blur() }
  }

  const showList = focused && query.trim().length > 0

  return (
    <div className="relative mx-auto hidden w-full max-w-xl md:block">
      <label className="relative block w-full">
        <span className="sr-only">Rechercher une page</span>
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-white/60" aria-hidden />
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
          placeholder="Rechercher une page…"
          className="h-8 w-full rounded-sm border border-white/20 bg-white/10 pl-8 pr-14 text-sm text-white placeholder:text-white/60 focus:bg-white/15 focus:outline-none focus:ring-1 focus:ring-white/60 transition-colors duration-150 motion-reduce:transition-none"
        />
        <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-white/25 px-1.5 text-[10px] text-white/70">Ctrl K</kbd>
      </label>

      {showList && (
        <ul id="quick-search-list" role="listbox" className="absolute left-0 right-0 top-full z-40 mt-1 max-h-80 overflow-y-auto rounded-md border border-line bg-surface p-1 text-sm text-ink shadow-pop">
          {results.length === 0 && <li className="px-3 py-2 text-ink-soft">Aucune page ne correspond à « {query} ».</li>}
          {results.map((r, i) => (
            <li
              key={r.href}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => { e.preventDefault(); go(r.href) }}
              onMouseEnter={() => setActive(i)}
              className={cn('flex cursor-pointer items-center justify-between gap-3 rounded-sm px-3 py-2', i === active ? 'bg-brand-50 text-brand-700' : 'hover:bg-canvas')}
            >
              <span className="font-medium">{r.label}</span>
              <span className="truncate text-xs text-ink-faint">{r.group}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
