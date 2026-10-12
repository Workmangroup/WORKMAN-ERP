import type { Metadata } from 'next'
import Link from 'next/link'
import { ChevronLeft, ChevronRight, Network, PackageOpen, Plus, Search, Shirt } from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { PAGE_SIZE, listBoms } from '@/features/bom/services/bom.service'
import { BOM_KINDS, formatMoney, label } from '@/lib/bom/options'
import { P } from '@/lib/rbac/permissions'
import { formatDateTime } from '@/lib/utils'

export const metadata: Metadata = { title: 'Nomenclatures (BOM)' }

type SP = Partial<Record<'q' | 'kind' | 'state' | 'page' | 'deleted', string>>

export default async function BomListPage({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await requirePermission(P.BOM_READ)
  const sp = await searchParams
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1)
  const { rows, total } = await listBoms({ q: sp.q, kind: sp.kind, state: sp.state, page })
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const canWrite = ctx.permissions.includes(P.BOM_WRITE)
  const costs = ctx.permissions.includes(P.COSTS_READ)
  const hasFilters = Boolean(sp.q || sp.kind || sp.state)
  const qs = (over: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries({ q: sp.q, kind: sp.kind, state: sp.state, ...over })) if (v !== undefined && v !== '') p.set(k, String(v))
    const s = p.toString()
    return s ? `/bom?${s}` : '/bom'
  }

  return (
    <>
      <PageHeader title="Nomenclatures (BOM)" description="Composants, opérations et coût de revient de chaque produit, versionnés et validés."
        actions={<>
          <Link href="/bom/materials" className={buttonVariants({ variant: 'command', size: 'sm' })}><PackageOpen className="h-4 w-4" /> Composants</Link>
          {canWrite && <Link href="/bom/new" className={buttonVariants({ variant: 'command', size: 'sm' })}><Plus className="h-4 w-4" /> Nouvelle nomenclature</Link>}
        </>} />
      <div className="space-y-4 p-4 sm:p-6">
        {sp.deleted && <Alert tone="success">Nomenclature supprimée.</Alert>}

        <form action="/bom" role="search" className="space-y-3 rounded-md border border-line bg-white p-4 shadow-card">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
            <Input name="q" defaultValue={sp.q} placeholder="Rechercher : code BOM, nom, description…" className="pl-8" aria-label="Rechercher une nomenclature" />
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <div><Label htmlFor="kind">Type</Label><Select id="kind" name="kind" defaultValue={sp.kind ?? ''}><option value="">Tous</option>{BOM_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</Select></div>
            <div><Label htmlFor="state">État</Label><Select id="state" name="state" defaultValue={sp.state ?? ''}><option value="">Actives</option><option value="archived">Archivées</option><option value="all">Toutes</option></Select></div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit">Rechercher</Button>
            {hasFilters && <Link href="/bom" className="text-sm text-brand-600 hover:underline">Réinitialiser</Link>}
            <span className="ml-auto text-sm text-ink-soft">{total} nomenclature(s)</span>
          </div>
        </form>

        {rows.length === 0 ? (
          <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">
            {hasFilters ? 'Aucune nomenclature ne correspond.' : 'Aucune nomenclature pour le moment.'}
          </p>
        ) : (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {rows.map((b) => (
              <li key={b.id}>
                <Link href={`/bom/${b.id}`} className="flex h-full gap-3 rounded-md border border-line bg-white p-3 shadow-card transition-colors hover:border-brand-400">
                  <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-brand-50 text-brand-600">
                    {b.kind === 'product' ? <Shirt className="h-6 w-6" aria-hidden /> : <Network className="h-6 w-6" aria-hidden />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className="font-mono text-sm font-semibold text-brand-700">{b.code}</span>
                      <span className="flex gap-1">
                        {b.archived_at && <Badge>Archivée</Badge>}
                        {b.active_version_no ? <Badge tone="success">v{b.active_version_no} validée</Badge> : <Badge tone="warning">Non validée</Badge>}
                      </span>
                    </span>
                    <span className="mt-0.5 block truncate text-sm font-medium">{b.name}</span>
                    <span className="block truncate text-xs text-ink-soft">
                      {label(BOM_KINDS, b.kind)}{b.article_ref ? ` · ${b.article_ref} (${b.article_client_ref})` : ''}{b.client_name ? ` · ${b.client_name}` : ''}
                    </span>
                    <span className="mt-1 flex items-center justify-between text-xs text-ink-soft">
                      <span>{b.line_count} ligne(s) · {formatDateTime(b.updated_at)}</span>
                      {costs && b.cost_price !== null && <span className="font-semibold text-ink tabular-nums" title="Coût de revient figé à la validation">{formatMoney(b.cost_price)}</span>}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}

        {totalPages > 1 && (
          <div className="flex items-center justify-between text-sm text-ink-soft">
            <span>Page {Math.min(page, totalPages)} / {totalPages}</span>
            <div className="flex gap-2">
              {page > 1 && <Link href={qs({ page: page - 1 })} className={buttonVariants({ variant: 'secondary', size: 'sm' })}><ChevronLeft className="h-4 w-4" /> Précédent</Link>}
              {page < totalPages && <Link href={qs({ page: page + 1 })} className={buttonVariants({ variant: 'secondary', size: 'sm' })}>Suivant <ChevronRight className="h-4 w-4" /></Link>}
            </div>
          </div>
        )}
      </div>
    </>
  )
}
