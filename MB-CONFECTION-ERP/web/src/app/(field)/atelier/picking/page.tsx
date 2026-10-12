import type { Metadata } from 'next'
import Link from 'next/link'
import { requirePermission } from '@/features/auth/guards'
import { shipmentsToPick } from '@/features/field/services'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Préparer et prélever' }

export default async function FieldPicking() {
  await requirePermission(P.SHIPMENTS_READ)
  const rows = await shipmentsToPick()
  return (
    <div className="space-y-4">
      <h1 className="text-3xl font-bold tracking-tight">Préparer et prélever</h1>
      {rows.length === 0 && <p className="rounded-lg border border-dashed border-line-strong p-8 text-center text-lg text-ink-soft">Aucune expédition à préparer.</p>}
      <ul className="grid gap-3 sm:grid-cols-2">
        {rows.map((s) => (
          <li key={s.id}>
            <Link href={`/atelier/picking/${s.id}`} className="flex min-h-[6rem] items-center justify-between gap-3 rounded-lg border border-line bg-surface p-4 shadow-card active:bg-brand-50">
              <span className="font-mono text-xl font-semibold">{s.number}</span>
              <span className="rounded-full bg-brand-50 px-3 py-1 text-base font-semibold text-brand-700">{s.status === 'picking' ? 'En prélèvement' : 'À préparer'}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
