import Link from 'next/link'

const TABS = [
  { href: '/shipments', label: 'Expéditions' },
  { href: '/shipments/preparation', label: 'Préparation' },
  { href: '/shipments/picking', label: 'Picking' },
  { href: '/shipments/indicateurs', label: 'Indicateurs' },
]

export default function ShipmentsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <nav aria-label="Sections des expéditions" className="-mx-4 flex gap-1 overflow-x-auto border-b border-line bg-white px-4 sm:mx-0 sm:px-6">
        {TABS.map((t) => (
          <Link key={t.href} href={t.href} className="-mb-px whitespace-nowrap border-b-2 border-transparent px-4 py-2.5 text-sm text-ink-soft hover:text-ink">{t.label}</Link>
        ))}
      </nav>
      {children}
    </>
  )
}
