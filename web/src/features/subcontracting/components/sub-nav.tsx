'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'

const TABS = [
  { href: '/subcontracting', label: 'Tableau de bord', exact: true },
  { href: '/subcontracting/orders', label: 'Commandes' },
  { href: '/subcontracting/subcontractors', label: 'Sous-traitants' },
  { href: '/subcontracting/performance', label: 'Performance et délais' },
] as const

export function SubNav() {
  const path = usePathname()
  return (
    <nav aria-label="Sous-traitance" className="flex gap-1 overflow-x-auto border-b border-line bg-white px-4 sm:px-6">
      {TABS.map((t) => {
        const active = 'exact' in t ? path === t.href : path.startsWith(t.href)
        return <Link key={t.href} href={t.href} aria-current={active ? 'page' : undefined} className={cn('-mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-sm', active ? 'border-brand-500 font-semibold text-brand-700' : 'border-transparent text-ink-soft hover:text-ink')}>{t.label}</Link>
      })}
    </nav>
  )
}
