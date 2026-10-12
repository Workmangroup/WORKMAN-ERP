import type { Metadata } from 'next'
import Link from 'next/link'
import { Building2, MapPin } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { NewWarehouseDialog } from '@/features/warehouses/components/warehouse-forms'
import { countsOf, listMyWarehouses, managersOf } from '@/features/warehouses/services/warehouses.service'
import { kindLabel, roleLabel, roleTone } from '@/lib/warehouses/options'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Entrepôts et accès' }

export default async function WarehousesPage() {
  const ctx = await requirePermission(P.STOCK_READ)
  const list = await listMyWarehouses(ctx.profile.id)
  const ids = list.map((w) => w.id)
  const [managers, counts] = await Promise.all([managersOf(ids), countsOf(ids)])
  const canCreate = ctx.permissions.includes(P.WAREHOUSES_MANAGE)
  return (
    <>
      <PageHeader title="Entrepôts et accès" description="Chaque entrepôt a son responsable et ses utilisateurs. Vous ne voyez que les entrepôts qui vous sont affectés."
        actions={canCreate && <NewWarehouseDialog />} />
      <div className="space-y-4 p-4 sm:p-6">
        {list.length === 0 ? (
          <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">Aucun entrepôt ne vous est affecté. Demandez à un responsable d’entrepôt ou à l’administrateur de vous donner accès.</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Entrepôts accessibles">
            {list.map((w) => (
              <li key={w.id}>
                <Link href={`/warehouses/${w.id}`} className="block rounded-md border border-line bg-white p-4 shadow-card transition-colors hover:border-brand-400">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0"><p className="font-mono text-xs text-ink-soft">{w.code}</p><p className="truncate font-semibold">{w.name}</p></div>
                    <Badge tone={roleTone(w.role)}>{roleLabel(w.role)}</Badge>
                  </div>
                  <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-ink-soft">
                    <Building2 className="h-3.5 w-3.5" aria-hidden />{kindLabel(w.kind)}{w.city ? ` · ${w.city}` : ''}{w.archived_at ? <Badge tone="neutral">Archivé</Badge> : null}
                  </p>
                  <p className="mt-2 flex flex-wrap items-center gap-3 text-xs text-ink-soft">
                    <MapPin className="h-3.5 w-3.5" aria-hidden />{counts.get(w.id)?.zones ?? 0} zone(s) · {counts.get(w.id)?.bins ?? 0} emplacement(s)
                  </p>
                  <p className="mt-2 truncate text-xs text-ink-soft">Responsable : {(managers.get(w.id) ?? []).join(', ') || '—'}</p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  )
}
