import type { Metadata } from 'next'
import Link from 'next/link'
import { requirePermission } from '@/features/auth/guards'
import { openInspections } from '@/features/field/services'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Contrôles à faire' }

const KIND: Record<string, string> = { reception: 'Réception', production: 'Production', final: 'Final' }

export default async function FieldControls() {
  await requirePermission(P.QUALITY_READ)
  const rows = await openInspections()
  return (
    <div className="space-y-4">
      <h1 className="text-3xl font-bold tracking-tight">Contrôles à faire</h1>
      {rows.length === 0 && <p className="rounded-lg border border-dashed border-line-strong p-8 text-center text-lg text-ink-soft">Aucun contrôle en attente.</p>}
      <ul className="grid gap-3 sm:grid-cols-2">
        {rows.map((c) => (
          <li key={c.id}>
            <Link href={`/atelier/controles/${c.id}`} className="flex min-h-[7rem] flex-col justify-between gap-2 rounded-lg border border-line bg-surface p-4 shadow-card active:bg-brand-50">
              <span className="font-mono text-base text-ink-soft">{c.number}</span>
              <span className="text-xl font-semibold">Contrôle {KIND[c.kind] ?? c.kind}</span>
              <span className="text-lg text-ink-soft">Échantillon : {c.sample_size}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
