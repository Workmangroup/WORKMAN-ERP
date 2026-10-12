'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ChevronRight } from 'lucide-react'
import { breadcrumbTrail } from '@/lib/navigation/tree'

/** Fil d'Ariane déduit de l'arbre de navigation (aucune page à modifier). Le dernier élément est la page courante. */
export function Breadcrumbs() {
  const pathname = usePathname() ?? '/'
  const trail = breadcrumbTrail(pathname)
  if (trail.length < 2) return null
  return (
    <nav aria-label="Fil d’Ariane" className="border-b border-line bg-white px-4 py-2 text-sm sm:px-6">
      <ol className="flex flex-wrap items-center gap-1 text-ink-soft">
        {trail.map((c, i) => {
          const last = i === trail.length - 1
          return (
            <li key={`${c.label}-${i}`} className="flex items-center gap-1">
              {i > 0 && <ChevronRight className="h-3.5 w-3.5 text-ink-faint" aria-hidden />}
              {c.href && !last ? (
                <Link href={c.href} className="rounded-sm hover:text-ink hover:underline">{c.label}</Link>
              ) : (
                <span aria-current={last ? 'page' : undefined} className={last ? 'font-medium text-ink' : undefined}>{c.label}</span>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
