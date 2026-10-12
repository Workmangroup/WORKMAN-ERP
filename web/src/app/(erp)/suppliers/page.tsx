import type { Metadata } from 'next'
import Link from 'next/link'
import { ChevronLeft, ChevronRight, Mail, Phone, Plus, Search } from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { directoryByIds } from '@/features/clients/services/clients.service'
import { PAGE_SIZE, countByStatus, getFacets, listBuyers, listSuppliers } from '@/features/suppliers/services/suppliers.service'
import type { SupplierFilters } from '@/features/suppliers/types'
import { countryName, flag } from '@/lib/clients/options'
import { P } from '@/lib/rbac/permissions'
import { QUALIFICATIONS, SUPPLIER_CATEGORIES, label } from '@/lib/suppliers/options'
import { cn, formatDateTime } from '@/lib/utils'

export const metadata: Metadata = { title: 'Fournisseurs' }

type SP = Partial<Record<'q' | 'status' | 'category' | 'country' | 'qualification' | 'buyer' | 'sort' | 'page' | 'deleted', string>>
const SORTS = [
  { value: 'name', label: 'Raison sociale (A → Z)' }, { value: 'code', label: 'Code' },
  { value: 'recent', label: 'Plus récents' }, { value: 'updated', label: 'Dernière modification' },
] as const

export default async function SuppliersPage({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await requirePermission(P.SUPPLIERS_READ)
  const sp = await searchParams
  const status = sp.status === 'archived' || sp.status === 'all' ? sp.status : 'active'
  const sort = (SORTS.find((s) => s.value === sp.sort)?.value ?? 'name') as SupplierFilters['sort']
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1)
  const filters: SupplierFilters = { q: sp.q, status, category: sp.category, country: sp.country, qualification: sp.qualification, buyer: sp.buyer, sort, page }

  const [{ rows, total }, counts, facets, buyers] = await Promise.all([listSuppliers(filters), countByStatus(), getFacets(), listBuyers()])
  const buyerNames = await directoryByIds(rows.map((r) => r.buyer_id))
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const canWrite = ctx.permissions.includes(P.SUPPLIERS_WRITE)
  const hasFilters = Boolean(sp.q || sp.category || sp.country || sp.qualification || sp.buyer)

  const qs = (over: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams()
    const base: Record<string, string | number | undefined> = { q: sp.q, status: status === 'active' ? undefined : status, category: sp.category, country: sp.country, qualification: sp.qualification, buyer: sp.buyer, sort: sort === 'name' ? undefined : sort, ...over }
    for (const [k, v] of Object.entries(base)) if (v !== undefined && v !== '') p.set(k, String(v))
    const s = p.toString()
    return s ? `/suppliers?${s}` : '/suppliers'
  }
  const qualTone = (v: string) => QUALIFICATIONS.find((q) => q.value === v)?.tone ?? 'neutral'

  return (
    <>
      <PageHeader title="Fournisseurs" description="Fiches fournisseurs, conditions d’achat, contacts, documents et statistiques."
        actions={canWrite && <Link href="/suppliers/new" className={buttonVariants({ variant: 'command', size: 'sm' })}><Plus className="h-4 w-4" /> Nouveau fournisseur</Link>} />
      <div className="space-y-4 p-4 sm:p-6">
        {sp.deleted && <Alert tone="success">Fournisseur supprimé définitivement.</Alert>}

        <nav aria-label="Statut" className="flex gap-1 overflow-x-auto border-b border-line">
          {([['active', 'Actifs', counts.active], ['archived', 'Archivés', counts.archived], ['all', 'Tous', counts.active + counts.archived]] as const).map(([id, text, n]) => (
            <Link key={id} href={qs({ status: id === 'active' ? undefined : id, page: undefined })} aria-current={status === id ? 'page' : undefined}
              className={cn('-mb-px whitespace-nowrap border-b-2 px-4 py-2 text-sm', status === id ? 'border-brand-500 font-semibold text-brand-700' : 'border-transparent text-ink-soft hover:text-ink')}>
              {text} <span className="ml-1 rounded-full bg-canvas px-1.5 text-xs">{n}</span>
            </Link>
          ))}
        </nav>

        <form action="/suppliers" role="search" className="space-y-3 rounded-md border border-line bg-white p-4 shadow-card">
          {status !== 'active' && <input type="hidden" name="status" value={status} />}
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
            <Input name="q" defaultValue={sp.q} placeholder="Rechercher : raison sociale, code, identifiant fiscal, e-mail, téléphone, ville…" className="pl-8" aria-label="Rechercher un fournisseur" />
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
            <div><Label htmlFor="category">Catégorie</Label>
              <Select id="category" name="category" defaultValue={sp.category ?? ''}><option value="">Toutes</option>{SUPPLIER_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</Select></div>
            <div><Label htmlFor="country">Pays</Label>
              <Select id="country" name="country" defaultValue={sp.country ?? ''}><option value="">Tous</option>{facets.countries.map((c) => <option key={c} value={c}>{countryName(c)}</option>)}</Select></div>
            <div><Label htmlFor="qualification">Qualification</Label>
              <Select id="qualification" name="qualification" defaultValue={sp.qualification ?? ''}><option value="">Toutes</option>{QUALIFICATIONS.map((q) => <option key={q.value} value={q.value}>{q.label}</option>)}</Select></div>
            <div><Label htmlFor="buyer">Acheteur</Label>
              <Select id="buyer" name="buyer" defaultValue={sp.buyer ?? ''}><option value="">Tous</option><option value="none">Non affecté</option>{buyers.map((b) => <option key={b.id} value={b.id}>{b.full_name}</option>)}</Select></div>
            <div className="col-span-2 md:col-span-1"><Label htmlFor="sort">Tri</Label>
              <Select id="sort" name="sort" defaultValue={sort}>{SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</Select></div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit">Appliquer</Button>
            {hasFilters && <Link href={qs({ q: undefined, category: undefined, country: undefined, qualification: undefined, buyer: undefined, page: undefined })} className="text-sm text-brand-600 hover:underline">Réinitialiser les filtres</Link>}
            <span className="ml-auto text-sm text-ink-soft">{total} résultat(s)</span>
          </div>
        </form>

        <ul className="grid gap-3 md:hidden">
          {rows.map((s) => (
            <li key={s.id}>
              <Link href={`/suppliers/${s.id}`} className="block rounded-md border border-line bg-white p-4 shadow-card active:bg-canvas">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0"><p className="truncate font-semibold text-brand-700">{s.name}</p><p className="font-mono text-xs text-ink-faint">{s.code}</p></div>
                  {s.archived_at ? <Badge tone="warning">Archivé</Badge> : <Badge tone={qualTone(s.qualification)}>{label(QUALIFICATIONS, s.qualification)}</Badge>}
                </div>
                <p className="mt-2 text-sm">{flag(s.country)} {countryName(s.country)} · {label(SUPPLIER_CATEGORIES, s.category)}</p>
                <p className="mt-1 text-xs text-ink-soft">{s.lead_time_days !== null ? `Délai ${s.lead_time_days} j` : 'Délai —'}{s.incoterm ? ` · ${s.incoterm}` : ''} · {s.currency}</p>
              </Link>
            </li>
          ))}
          {rows.length === 0 && <li className="rounded-md border border-dashed border-line-strong p-8 text-center text-sm text-ink-soft">Aucun fournisseur ne correspond.</li>}
        </ul>

        <Card className="hidden md:block">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-canvas text-xs uppercase text-ink-soft">
                <tr>
                  <th className="px-5 py-2 font-semibold">Fournisseur</th><th className="px-3 py-2 font-semibold">Catégorie</th><th className="px-3 py-2 font-semibold">Pays</th>
                  <th className="px-3 py-2 font-semibold">Contact principal</th><th className="px-3 py-2 font-semibold">Conditions</th><th className="px-3 py-2 font-semibold">Acheteur</th><th className="px-5 py-2 font-semibold">Modifié</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id} className="border-t border-line hover:bg-canvas/60">
                    <td className="px-5 py-3">
                      <Link href={`/suppliers/${s.id}`} className="font-semibold text-brand-700 hover:underline">{s.name}</Link>
                      {s.archived_at ? <Badge tone="warning" className="ml-2">Archivé</Badge> : <Badge tone={qualTone(s.qualification)} className="ml-2">{label(QUALIFICATIONS, s.qualification)}</Badge>}
                      <div className="font-mono text-xs text-ink-faint">{s.code}{s.tax_id ? ` · ${s.tax_id}` : ''}</div>
                    </td>
                    <td className="px-3 py-3">{label(SUPPLIER_CATEGORIES, s.category)}</td>
                    <td className="whitespace-nowrap px-3 py-3">{flag(s.country)} {countryName(s.country)}{s.city ? <div className="text-xs text-ink-soft">{s.city}</div> : null}</td>
                    <td className="px-3 py-3">
                      {s.primary_contact ? (<>
                        <div>{s.primary_contact.full_name}</div>
                        <div className="flex flex-wrap gap-x-3 text-xs text-ink-soft">
                          {s.primary_contact.email && <span className="inline-flex items-center gap-1"><Mail className="h-3 w-3" />{s.primary_contact.email}</span>}
                          {s.primary_contact.phone && <span className="inline-flex items-center gap-1"><Phone className="h-3 w-3" />{s.primary_contact.phone}</span>}
                        </div></>) : <span className="text-ink-faint">—</span>}
                    </td>
                    <td className="px-3 py-3 text-xs text-ink-soft">{s.currency}{s.lead_time_days !== null ? ` · ${s.lead_time_days} j` : ''}{s.incoterm ? ` · ${s.incoterm}` : ''}</td>
                    <td className="px-3 py-3">{s.buyer_id ? buyerNames.get(s.buyer_id)?.full_name ?? '—' : <span className="text-ink-faint">Non affecté</span>}</td>
                    <td className="whitespace-nowrap px-5 py-3 text-ink-soft">{formatDateTime(s.updated_at)}</td>
                  </tr>
                ))}
                {rows.length === 0 && <tr><td colSpan={7} className="px-5 py-12 text-center text-ink-soft">Aucun fournisseur ne correspond à ces critères.</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>

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
