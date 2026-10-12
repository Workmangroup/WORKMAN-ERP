import type { Metadata } from 'next'
import Link from 'next/link'
import { requirePermission } from '@/features/auth/guards'
import { openOrders } from '@/features/field/services'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Ordres du jour' }

const STATUS: Record<string, string> = { planned: 'Planifié', launched: 'Lancé', in_progress: 'En cours', suspended: 'Suspendu' }

/** Ordres ouverts, les plus en retard en premier. Une carte = un ordre, un toucher = la fiche. */
export default async function FieldOrders() {
  await requirePermission(P.PRODUCTION_READ)
  const rows = await openOrders()
  return (
    <div className="space-y-4">
      <h1 className="text-3xl font-bold tracking-tight">Ordres du jour</h1>
      {rows.length === 0 && <p className="rounded-lg border border-dashed border-line-strong p-8 text-center text-lg text-ink-soft">Aucun ordre ouvert.</p>}
      <ul className="grid gap-3 sm:grid-cols-2">
        {rows.map((o) => (
          <li key={o.id}>
            <Link href={`/atelier/of/${o.id}`} className="flex min-h-[7.5rem] flex-col justify-between gap-2 rounded-lg border border-line bg-surface p-4 shadow-card active:bg-brand-50">
              <span className="flex items-center justify-between gap-2">
                <span className="font-mono text-base text-ink-soft">{o.number}</span>
                <span className="rounded-full bg-brand-50 px-3 py-1 text-base font-semibold text-brand-700">{STATUS[o.status] ?? o.status}</span>
              </span>
              <span className="text-xl font-semibold">{o.article_name}</span>
              <span className="flex flex-wrap items-center gap-x-4 text-lg text-ink-soft">
                <span>{o.qty_good} / {o.qty_planned} pièces</span>
                {o.late_days > 0 && <span className="font-semibold text-danger-text">En retard de {o.late_days} j</span>}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
