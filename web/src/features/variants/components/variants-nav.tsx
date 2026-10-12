'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'

const TABS = [{ href: '/variants', label: 'Produits et variantes', exact: true }, { href: '/variants/catalog', label: 'Catalogue tailles et couleurs' }] as const

export function VariantsNav() {
  const path = usePathname()
  return (
    <nav aria-label="Variantes textile" className="flex gap-1 overflow-x-auto border-b border-line bg-white px-4 sm:px-6">
      {TABS.map((t) => {
        const active = 'exact' in t ? path === t.href || (path.startsWith('/variants/') && !path.startsWith('/variants/catalog')) : path.startsWith(t.href)
        return <Link key={t.href} href={t.href} aria-current={active ? 'page' : undefined} className={cn('-mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-sm', active ? 'border-brand-500 font-semibold text-brand-700' : 'border-transparent text-ink-soft hover:text-ink')}>{t.label}</Link>
      })}
    </nav>
  )
}
