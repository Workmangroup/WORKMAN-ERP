'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'

const TABS = [
  { href: '/stock', label: 'Stocks' },
  { href: '/stock/movements', label: 'Mouvements' },
  { href: '/stock/requests', label: 'Demandes et journal' },
  { href: '/stock/lots', label: 'Lots FIFO' },
  { href: '/stock/picking', label: 'Préparation' },
  { href: '/stock/reservations', label: 'Réservations' },
  { href: '/stock/inventories', label: 'Inventaires' },
  { href: '/stock/warehouses', label: 'Entrepôts' },
]

export function StockNav() {
  const path = usePathname()
  return (
    <nav aria-label="Sections du stock" className="flex gap-1 overflow-x-auto border-b border-line bg-white px-4 sm:px-6">
      {TABS.map((t) => {
        const active = t.href === '/stock' ? path === '/stock' : path.startsWith(t.href)
        return (
          <Link key={t.href} href={t.href} aria-current={active ? 'page' : undefined}
            className={cn('-mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-sm', active ? 'border-brand-500 font-semibold text-brand-700' : 'border-transparent text-ink-soft hover:text-ink')}>
            {t.label}
          </Link>
        )
      })}
    </nav>
  )
}
