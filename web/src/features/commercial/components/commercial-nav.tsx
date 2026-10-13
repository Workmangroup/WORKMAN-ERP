'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useAuth } from '@/features/auth'
import { cn } from '@/lib/utils'

const TABS = [
  { href: '/commercial', label: 'Tableau de bord', exact: true },
  { href: '/commercial/pipeline', label: 'Pipeline', need: 'prospects.read' },
  { href: '/commercial/prospects', label: 'Prospects', need: 'prospects.read' },
  { href: '/clients', label: 'Clients', need: 'clients.read' },
  { href: '/commercial/quotes', label: 'Devis', need: 'quotes.read' },
  { href: '/commercial/contracts', label: 'Contrats', need: 'contracts.read' },
  { href: '/commercial/objectives', label: 'Objectifs', need: 'objectives.read' },
  { href: '/commercial/visits', label: 'Visites', need: 'visits.read' },
  { href: '/commercial/marketing', label: 'Marketing', need: 'marketing.read' },
  { href: '/commercial/credit', label: 'Crédit et stock', need: 'orders.read' },
  { href: '/commercial/personalization', label: 'Logos et BAT', need: 'personalization.read' },
  { href: '/orders', label: 'Commandes', need: 'orders.read' },
  { href: '/commercial/invoices', label: 'Factures', need: 'invoices.read' },
  { href: '/commercial/credit-notes', label: 'Avoirs', need: 'invoices.read' },
]

/** Barre de navigation du module : relie aussi les écrans Clients et Commandes (modules existants). */
export function CommercialNav() {
  const path = usePathname()
  const { permissions } = useAuth()
  return (
    <nav aria-label="Sections du module commercial" className="flex gap-1 overflow-x-auto border-b border-line bg-white px-4 sm:px-6">
      {TABS.filter((t) => !t.need || permissions.includes(t.need)).map((t) => {
        const active = t.exact ? path === t.href : path.startsWith(t.href)
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
