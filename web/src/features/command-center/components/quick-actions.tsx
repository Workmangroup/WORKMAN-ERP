'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { Plus, Star } from 'lucide-react'
import { cn } from '@/lib/utils'

const KEY = 'mb-command-favorites:v1'

function readFavorites(): string[] {
  try {
    const v = JSON.parse(window.localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** Raccourcis en un clic ; l’étoile place un raccourci en tête (enregistré dans ce navigateur). */
export function QuickActions({ actions }: { actions: { href: string; label: string }[] }) {
  const [favs, setFavs] = useState<string[]>([])
  useEffect(() => { setFavs(readFavorites()) }, [])

  const toggle = (href: string) => {
    const next = favs.includes(href) ? favs.filter((h) => h !== href) : [...favs, href]
    setFavs(next)
    try { window.localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* sans effet */ }
  }
  const sorted = [...actions].sort((a, b) => Number(favs.includes(b.href)) - Number(favs.includes(a.href)))

  return (
    <ul className="grid gap-2 sm:grid-cols-2">
      {sorted.map((a) => {
        const fav = favs.includes(a.href)
        return (
          <li key={a.href} className="flex items-center gap-2 rounded-md border border-line bg-canvas pr-2 transition-colors duration-150 hover:border-brand-500 motion-reduce:transition-none">
            <Link href={a.href} className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2.5 text-sm font-medium">
              <Plus className="h-4 w-4 shrink-0 text-brand-600" aria-hidden />
              <span className="truncate">{a.label}</span>
            </Link>
            <button type="button" onClick={() => toggle(a.href)} aria-pressed={fav} aria-label={`${fav ? 'Retirer' : 'Ajouter'} « ${a.label} » aux favoris`}
              className={cn('inline-flex h-7 w-7 items-center justify-center rounded-md', fav ? 'text-warn-text' : 'text-ink-faint hover:text-ink')}>
              <Star className="h-4 w-4" fill={fav ? 'currentColor' : 'none'} aria-hidden />
            </button>
          </li>
        )
      })}
    </ul>
  )
}
