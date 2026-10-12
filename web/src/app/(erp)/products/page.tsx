import type { Metadata } from 'next'
import Link from 'next/link'
import { AlertTriangle, ChevronLeft, ChevronRight, FilePenLine, ImageOff, Layers, Plus, Search } from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { listClientsLite } from '@/features/articles/services/articles.service'
import { PAGE_SIZE, listProducts, productStats } from '@/features/products/services/products.service'
import { FAMILIES, PRODUCT_STATUS, label } from '@/lib/products/options'
import { P } from '@/lib/rbac/permissions'
import { formatDateTime } from '@/lib/utils'

export const metadata: Metadata = { title: 'Produits (PDM)' }

type SP = Partial<Record<'q' | 'client' | 'family' | 'status' | 'page' | 'deleted', string>>

export default async function ProductsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await requirePermission(P.PRODUCTS_READ)
  const sp = await searchParams
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1)
  const [{ rows, total }, clients, stats] = await Promise.all([listProducts({ q: sp.q, client: sp.client, family: sp.family, status: sp.status, page }), listClientsLite(), productStats()])
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const canWrite = ctx.permissions.includes(P.PRODUCTS_WRITE)
  const hasFilters = Boolean(sp.q || sp.client || sp.family || sp.status)
  const qs = (over: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries({ q: sp.q, client: sp.client, family: sp.family, status: sp.status, ...over })) if (v !== undefined && v !== '') p.set(k, String(v))
    const s = p.toString()
    return s ? `/products?${s}` : '/products'
  }
  const kpi = [
    { label: 'Produits actifs', value: stats.active, icon: Layers, tone: 'text-success-text' },
    { label: 'En préparation', value: stats.draft, icon: FilePenLine, tone: 'text-ink' },
    { label: 'Brouillons de version', value: stats.pendingDrafts, icon: FilePenLine, tone: 'text-brand-700' },
    { label: 'Certifications en alerte', value: stats.certAlerts, icon: AlertTriangle, tone: stats.certAlerts ? 'text-warn-text' : 'text-ink' },
  ]

  return (
    <>
      <PageHeader title="Produits (PDM)" description="Référentiel technique : fiche versionnée, variantes, photos, nomenclature, patronages, documents, certifications et historique."
        actions={canWrite && <Link href={`/products/new${sp.client ? `?client=${sp.client}` : ''}`} className={buttonVariants({ variant: 'command', size: 'sm' })}><Plus className="h-4 w-4" /> Nouveau produit</Link>} />
      <div className="space-y-4 p-4 sm:p-6">
        {sp.deleted && <Alert tone="success">Produit supprimé.</Alert>}
        {stats.expired > 0 && <Alert tone="warning"><AlertTriangle className="mr-1 inline h-4 w-4" />{stats.expired} certification(s) expirée(s) : ouvrez les produits marqués d’une alerte pour les renouveler.</Alert>}

        <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Indicateurs">
          {kpi.map((k) => (
            <li key={k.label} className="rounded-md border border-line bg-white p-3 shadow-card"><p className="flex items-center gap-1.5 text-xs text-ink-soft"><k.icon className="h-3.5 w-3.5" aria-hidden />{k.label}</p><p className={`mt-1 text-2xl font-semibold tabular-nums ${k.tone}`}>{k.value}</p></li>
          ))}
        </ul>

        <form action="/products" role="search" className="space-y-3 rounded-md border border-line bg-white p-4 shadow-card">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
            <Input name="q" defaultValue={sp.q} placeholder="Rechercher : code (PRD-0001), désignation, description…" className="pl-8" aria-label="Rechercher un produit" />
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            <div><Label htmlFor="client">Client</Label><Select id="client" name="client" defaultValue={sp.client ?? ''}><option value="">Tous</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></div>
            <div><Label htmlFor="family">Famille</Label><Select id="family" name="family" defaultValue={sp.family ?? ''}><option value="">Toutes</option>{FAMILIES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}</Select></div>
            <div><Label htmlFor="status">Statut</Label><Select id="status" name="status" defaultValue={sp.status ?? ''}><option value="">Hors archivés</option><option value="all">Tous (archivés inclus)</option>{Object.entries(PRODUCT_STATUS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}</Select></div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit">Rechercher</Button>
            {hasFilters && <Link href="/products" className="text-sm text-brand-600 hover:underline">Réinitialiser</Link>}
            <span className="ml-auto text-sm text-ink-soft">{total} produit(s)</span>
          </div>
        </form>

        {rows.length === 0 ? (
          <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">Aucun produit ne correspond.</p>
        ) : (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {rows.map((p) => (
              <li key={p.id}>
                <Link href={`/products/${p.id}`} className="flex gap-3 rounded-md border border-line bg-white p-3 shadow-card transition-colors hover:border-brand-400">
                  <span className="relative flex h-24 w-20 shrink-0 items-center justify-center overflow-hidden rounded-md bg-canvas">
                    {p.main_photo_id ? (
                      // eslint-disable-next-line
                      <img src={`/products/photo/${p.main_photo_id}`} alt="" loading="lazy" className="h-full w-full object-cover" />
                    ) : <ImageOff className="h-6 w-6 text-line-strong" aria-label="Pas de photo" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2"><span className="font-mono text-sm font-semibold text-brand-700">{p.code}</span><Badge tone={PRODUCT_STATUS[p.status].tone}>{PRODUCT_STATUS[p.status].label}</Badge></span>
                    <span className="mt-0.5 block truncate text-sm font-medium">{p.name}</span>
                    <span className="block truncate text-xs text-ink-soft">{p.client_name} · {label(FAMILIES, p.family)}</span>
                    <span className="mt-1 flex flex-wrap gap-1">
                      {p.version_no && <Badge tone="brand">v{p.version_no}{p.active_version_id ? '' : ' brouillon'}</Badge>}
                      {p.variant_count > 0 && <Badge>{p.variant_count} variante(s)</Badge>}
                      {p.cert_alerts > 0 && <Badge tone="warning"><AlertTriangle className="mr-1 h-3 w-3" />{p.cert_alerts} certif.</Badge>}
                    </span>
                    <span className="mt-1 block text-[11px] text-ink-faint">Modifié {formatDateTime(p.updated_at)}</span>
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
