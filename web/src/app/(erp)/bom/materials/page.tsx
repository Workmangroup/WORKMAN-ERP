import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft, ChevronLeft, ChevronRight, Search } from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { MaterialsManager } from '@/features/bom/components/materials-manager'
import { listMaterials, supplierOptions } from '@/features/bom/services/bom.service'
import { MATERIAL_CATEGORIES } from '@/lib/bom/options'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Composants' }

type SP = Partial<Record<'q' | 'category' | 'state' | 'page', string>>

export default async function MaterialsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await requirePermission(P.BOM_READ)
  const sp = await searchParams
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1)
  const canWrite = ctx.permissions.includes(P.BOM_WRITE)
  const costs = ctx.permissions.includes(P.COSTS_READ)
  const [{ rows, total }, suppliers] = await Promise.all([listMaterials({ q: sp.q, category: sp.category, state: sp.state, page }), canWrite ? supplierOptions() : Promise.resolve([])])
  const totalPages = Math.max(1, Math.ceil(total / 30))
  const hasFilters = Boolean(sp.q || sp.category || sp.state)
  const qs = (n: number) => {
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries({ q: sp.q, category: sp.category, state: sp.state, page: n })) if (v !== undefined && v !== '') p.set(k, String(v))
    return `/bom/materials?${p.toString()}`
  }

  return (
    <>
      <PageHeader title="Composants" description="Catalogue des matières, mercerie et fournitures utilisées dans les nomenclatures."
        actions={<Link href="/bom" className={buttonVariants({ variant: 'command', size: 'sm' })}><ArrowLeft className="h-4 w-4" /> Nomenclatures</Link>} />
      <div className="space-y-4 p-4 sm:p-6">
        <form action="/bom/materials" role="search" className="space-y-3 rounded-md border border-line bg-white p-4 shadow-card">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
            <Input name="q" defaultValue={sp.q} placeholder="Rechercher : code, désignation, couleur…" className="pl-8" aria-label="Rechercher un composant" />
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <div><Label htmlFor="category">Catégorie</Label><Select id="category" name="category" defaultValue={sp.category ?? ''}><option value="">Toutes</option>{MATERIAL_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</Select></div>
            <div><Label htmlFor="state">État</Label><Select id="state" name="state" defaultValue={sp.state ?? ''}><option value="">Actifs</option><option value="archived">Archivés</option><option value="all">Tous</option></Select></div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit">Rechercher</Button>
            {hasFilters && <Link href="/bom/materials" className="text-sm text-brand-600 hover:underline">Réinitialiser</Link>}
            <span className="ml-auto text-sm text-ink-soft">{total} composant(s)</span>
          </div>
        </form>

        <MaterialsManager rows={rows} suppliers={suppliers} canWrite={canWrite} costs={costs} />

        {totalPages > 1 && (
          <div className="flex items-center justify-between text-sm text-ink-soft">
            <span>Page {Math.min(page, totalPages)} / {totalPages}</span>
            <div className="flex gap-2">
              {page > 1 && <Link href={qs(page - 1)} className={buttonVariants({ variant: 'secondary', size: 'sm' })}><ChevronLeft className="h-4 w-4" /> Précédent</Link>}
              {page < totalPages && <Link href={qs(page + 1)} className={buttonVariants({ variant: 'secondary', size: 'sm' })}>Suivant <ChevronRight className="h-4 w-4" /></Link>}
            </div>
          </div>
        )}
      </div>
    </>
  )
}
