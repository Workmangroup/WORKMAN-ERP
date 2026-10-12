'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'

const TABS = [
  { href: '/development', label: 'Tableau de bord', exact: true },
  { href: '/development/board', label: 'Kanban' },
  { href: '/development/projects', label: 'Projets' },
  { href: '/development/validations', label: 'Validations et alertes' },
] as const

export function DevNav({ alerts }: { alerts: number }) {
  const path = usePathname()
  return (
    <nav aria-label="Développement produit" className="flex gap-1 overflow-x-auto border-b border-line bg-white px-4 sm:px-6">
      {TABS.map((t) => {
        const active = 'exact' in t ? path === t.href : path.startsWith(t.href)
        return (
          <Link key={t.href} href={t.href} aria-current={active ? 'page' : undefined}
            className={cn('-mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-sm', active ? 'border-brand-500 font-semibold text-brand-700' : 'border-transparent text-ink-soft hover:text-ink')}>
            {t.label}{t.href.endsWith('validations') && alerts > 0 && <span className="ml-1.5 rounded-full bg-danger px-1.5 text-xs font-semibold text-white">{alerts}</span>}
          </Link>
        )
      })}
    </nav>
  )
}
