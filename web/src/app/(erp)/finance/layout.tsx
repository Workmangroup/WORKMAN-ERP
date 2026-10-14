import Link from 'next/link'

const TABS = [
  { href: '/finance', label: 'Tableau de bord' },
  { href: '/finance/encaissements', label: 'Encaissements' },
  { href: '/finance/fournisseurs', label: 'Fournisseurs' },
  { href: '/finance/balances', label: 'Balances âgées' },
  { href: '/finance/relances', label: 'Relances' },
  { href: '/finance/tresorerie', label: 'Trésorerie' },
  { href: '/finance/previsions', label: 'Prévisions' },
  { href: '/finance/devises', label: 'Devises et fiscalité' },
  { href: '/finance/tva', label: 'TVA' },
  { href: '/finance/retenues', label: 'Retenues' },
  { href: '/finance/lettrage', label: 'Lettrage' },
  { href: '/finance/banque', label: 'Banque' },
  { href: '/finance/comptabilite', label: 'Comptabilité' },
]

export default function FinanceLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <nav aria-label="Sections de la finance" className="-mx-4 flex gap-1 overflow-x-auto border-b border-line bg-white px-4 sm:mx-0 sm:px-6">
        {TABS.map((t) => (
          <Link key={t.href} href={t.href} className="-mb-px whitespace-nowrap border-b-2 border-transparent px-4 py-2.5 text-sm text-ink-soft hover:text-ink">{t.label}</Link>
        ))}
      </nav>
      {children}
    </>
  )
}
