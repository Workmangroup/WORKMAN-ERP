import type { Metadata } from 'next'
import Link from 'next/link'
import { ChevronLeft, ChevronRight, ImageOff, Plus, Search } from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { PAGE_SIZE, listArticles, listClientsLite, normFacets } from '@/features/articles/services/articles.service'
import { ARTICLE_STATUS, FAMILIES, label } from '@/lib/articles/options'
import { P } from '@/lib/rbac/permissions'
import { formatDateTime } from '@/lib/utils'

export const metadata: Metadata = { title: 'Articles' }

type SP = Partial<Record<'q' | 'client' | 'family' | 'status' | 'norm' | 'page' | 'deleted', string>>

export default async function ArticlesPage({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await requirePermission(P.ARTICLES_READ)
  const sp = await searchParams
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1)
  const [{ rows, total }, clients, norms] = await Promise.all([
    listArticles({ q: sp.q, client: sp.client, family: sp.family, status: sp.status, norm: sp.norm, page }), listClientsLite(), normFacets(),
  ])
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const canWrite = ctx.permissions.includes(P.ARTICLES_WRITE)
  const hasFilters = Boolean(sp.q || sp.client || sp.family || sp.status || sp.norm)
  const qs = (over: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries({ q: sp.q, client: sp.client, family: sp.family, status: sp.status, norm: sp.norm, ...over })) if (v !== undefined && v !== '') p.set(k, String(v))
    const s = p.toString()
    return s ? `/articles?${s}` : '/articles'
  }

  return (
    <>
      <PageHeader title="Articles clients" description="Références client et internes, fiches versionnées, photos, normes, packaging et lavage."
        actions={canWrite && <Link href={`/articles/new${sp.client ? `?client=${sp.client}` : ''}`} className={buttonVariants({ variant: 'command', size: 'sm' })}><Plus className="h-4 w-4" /> Nouvel article</Link>} />
      <div className="space-y-4 p-4 sm:p-6">
        {sp.deleted && <Alert tone="success">Article supprimé.</Alert>}

        <form action="/articles" role="search" className="space-y-3 rounded-md border border-line bg-white p-4 shadow-card">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
            <Input name="q" defaultValue={sp.q} placeholder="Rechercher : référence interne (JKT001), référence client (LAF-HV-JKT-2027), désignation…" className="pl-8" aria-label="Rechercher un article" />
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <div><Label htmlFor="client">Client</Label><Select id="client" name="client" defaultValue={sp.client ?? ''}><option value="">Tous</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></div>
            <div><Label htmlFor="family">Famille</Label><Select id="family" name="family" defaultValue={sp.family ?? ''}><option value="">Toutes</option>{FAMILIES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}</Select></div>
            <div><Label htmlFor="status">Statut</Label><Select id="status" name="status" defaultValue={sp.status ?? ''}><option value="">Tous</option>{Object.entries(ARTICLE_STATUS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}</Select></div>
            <div><Label htmlFor="norm">Norme</Label><Select id="norm" name="norm" defaultValue={sp.norm ?? ''}><option value="">Toutes</option>{norms.map((n) => <option key={n} value={n}>{n}</option>)}</Select></div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit">Rechercher</Button>
            {hasFilters && <Link href="/articles" className="text-sm text-brand-600 hover:underline">Réinitialiser</Link>}
            <span className="ml-auto text-sm text-ink-soft">{total} article(s)</span>
          </div>
        </form>

        {rows.length === 0 ? (
          <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">Aucun article ne correspond.</p>
        ) : (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {rows.map((a) => (
              <li key={a.id}>
                <Link href={`/articles/${a.id}`} className="flex gap-3 rounded-md border border-line bg-white p-3 shadow-card transition-colors hover:border-brand-400">
                  <span className="relative flex h-24 w-20 shrink-0 items-center justify-center overflow-hidden rounded-md bg-canvas">
                    {a.main_photo_id ? (
                      // eslint-disable-next-line
                      <img src={`/articles/photo/${a.main_photo_id}`} alt="" loading="lazy" className="h-full w-full object-cover" />
                    ) : <ImageOff className="h-6 w-6 text-line-strong" aria-label="Pas de photo" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className="font-mono text-sm font-semibold text-brand-700">{a.internal_ref}</span>
                      <Badge tone={ARTICLE_STATUS[a.status].tone}>{ARTICLE_STATUS[a.status].label}</Badge>
                    </span>
                    <span className="block truncate font-mono text-xs text-ink-soft">{a.client_ref}</span>
                    <span className="mt-0.5 block truncate text-sm font-medium">{a.name}</span>
                    <span className="block truncate text-xs text-ink-soft">{a.client_name} · {label(FAMILIES, a.family)}</span>
                    {a.norm_codes.length > 0 && <span className="mt-1 flex flex-wrap gap-1">{a.norm_codes.slice(0, 3).map((n) => <Badge key={n} tone="brand">{n}</Badge>)}{a.norm_codes.length > 3 && <Badge>+{a.norm_codes.length - 3}</Badge>}</span>}
                    <span className="mt-1 block text-[11px] text-ink-faint">Modifié {formatDateTime(a.updated_at)}</span>
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
