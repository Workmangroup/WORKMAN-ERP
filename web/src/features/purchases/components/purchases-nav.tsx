'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useAuth } from '@/features/auth'
import { cn } from '@/lib/utils'

const TABS = [
  { href: '/purchases', label: 'Statistiques', need: 'purchases.read' },
  { href: '/purchases/requests', label: 'Demandes d’achat' },
  { href: '/purchases/orders', label: 'Commandes fournisseur', need: 'purchases.read' },
  { href: '/purchases/budgets', label: 'Budgets', need: 'purchases.read' },
  { href: '/purchases/sourcing', label: 'Consultations', need: 'purchases.read' },
  { href: '/purchases/receipts', label: 'Réceptions', need: 'purchases.read' },
  { href: '/purchases/returns', label: 'Retours fournisseur', need: 'purchases.read' },
]

export function PurchasesNav() {
  const path = usePathname()
  const { permissions } = useAuth()
  return (
    <nav aria-label="Sections des achats" className="flex gap-1 overflow-x-auto border-b border-line bg-white px-4 sm:px-6">
      {TABS.filter((t) => !t.need || permissions.includes(t.need)).map((t) => {
        const active = t.href === '/purchases' ? path === '/purchases' : path.startsWith(t.href)
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
