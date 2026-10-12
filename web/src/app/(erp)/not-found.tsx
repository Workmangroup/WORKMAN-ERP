import Link from 'next/link'

export default function ErpNotFound() {
  return (
    <div className="mx-auto max-w-xl space-y-3 p-6">
      <h1 className="text-xl font-semibold text-ink">Page introuvable</h1>
      <p className="text-sm text-ink-soft">Cette fiche ou cet écran n’existe pas, ou vous n’y avez pas accès.</p>
      <Link href="/dashboard" className="inline-flex h-9 items-center rounded-sm border border-line-strong px-3 text-sm text-ink hover:bg-canvas">Revenir à l’accueil</Link>
    </div>
  )
}
