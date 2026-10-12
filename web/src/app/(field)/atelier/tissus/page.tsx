import type { Metadata } from 'next'
import { requirePermission } from '@/features/auth/guards'
import { fabricNeeds } from '@/features/field/services'
import { P } from '@/lib/rbac/permissions'
import { formatDateTime } from '@/lib/utils'

export const metadata: Metadata = { title: 'Tissus à commander' }

/** Pour le responsable tissus : ce qu'il faut commander, avec la date limite en gros. */
export default async function FieldFabric() {
  await requirePermission(P.PURCHASES_READ)
  const rows = await fabricNeeds()
  return (
    <div className="space-y-4">
      <h1 className="text-3xl font-bold tracking-tight">Tissus à commander</h1>
      {rows.length === 0 && <p className="rounded-lg border border-dashed border-line-strong p-8 text-center text-lg text-ink-soft">Rien à commander : les besoins sont couverts.</p>}
      <ul className="space-y-3">
        {rows.map((r) => (
          <li key={r.code} className={`rounded-lg border p-4 shadow-card ${r.late ? 'border-danger/40 bg-danger-bg' : 'border-line bg-surface'}`}>
            <p className="font-mono text-base text-ink-soft">{r.code}</p>
            <p className="text-xl font-semibold">{r.name}</p>
            <p className="mt-1 text-2xl font-bold tabular-nums">{r.qty} {r.unit}</p>
            <p className="text-lg text-ink-soft">{r.due ? `À commander avant le ${formatDateTime(r.due)}` : 'Date non précisée'}</p>
            {r.late && <p className="mt-1 text-lg font-semibold text-danger-text">Date dépassée : commander aujourd’hui</p>}
          </li>
        ))}
      </ul>
    </div>
  )
}
