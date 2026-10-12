import Link from 'next/link'

const TABS = [
  { href: '/quality', label: 'Indicateurs' },
  { href: '/quality/controles', label: 'Contrôles' },
  { href: '/quality/non-conformites', label: 'Non-conformités' },
  { href: '/quality/plans', label: 'Plans d’actions' },
  { href: '/quality/historique', label: 'Historique des défauts' },
]

/** Barre de navigation du module Qualité. */
export function QualityNav() {
  return (
    <nav aria-label="Sections de la qualité" className="-mx-4 flex gap-1 overflow-x-auto border-b border-line bg-white px-4 sm:mx-0 sm:px-6">
      {TABS.map((t) => (
        <Link key={t.href} href={t.href} className="-mb-px whitespace-nowrap border-b-2 border-transparent px-4 py-2.5 text-sm text-ink-soft hover:text-ink">{t.label}</Link>
      ))}
    </nav>
  )
}
