import Link from 'next/link'

const TABS = [
  { href: '/production', label: 'Tableau de bord' },
  { href: '/production/ordres', label: 'Ordres de fabrication' },
  { href: '/production/postes', label: 'Postes de travail' },
]

/** Barre de navigation du module Production. */
export function ProductionNav() {
  return (
    <nav aria-label="Sections de la production" className="flex gap-1 overflow-x-auto border-b border-line bg-white px-4 sm:px-6">
      {TABS.map((t) => (
        <Link key={t.href} href={t.href} className="-mb-px whitespace-nowrap border-b-2 border-transparent px-4 py-2.5 text-sm text-ink-soft hover:text-ink">{t.label}</Link>
      ))}
    </nav>
  )
}
