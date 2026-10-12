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
import { PAGE_SIZE, countByStatus, getFacets, listClients } from '@/features/clients/services/clients-api'
import { directoryByIds, listPaymentTerms, listSalesReps } from '@/features/clients/services/clients.service'
import type { ClientFilters, ClientSort, ClientStatusFilter } from '@/features/clients/types'
import { countryName, flag } from '@/lib/clients/options'
import { P } from '@/lib/rbac/permissions'
import { cn, formatDateTime } from '@/lib/utils'

export const metadata: Metadata = { title: 'Clients' }

type SP = Record<'q' | 'status' | 'country' | 'currency' | 'rep' | 'terms' | 'sort' | 'page' | 'deleted', string | undefined>

const SORTS: { value: ClientSort; label: string }[] = [
  { value: 'name', label: 'Raison sociale (A → Z)' },
  { value: 'code', label: 'Code' },
  { value: 'recent', label: 'Plus récents' },
  { value: 'updated', label: 'Dernière modification' },
]

export default async function ClientsPage({ searchParams }: { searchParams: Promise<Partial<SP>> }) {
  const ctx = await requirePermission(P.CLIENTS_READ)
  const sp = await searchParams
  const status: ClientStatusFilter = sp.status === 'archived' || sp.status === 'all' ? sp.status : 'active'
  const sort = (SORTS.find((s) => s.value === sp.sort)?.value ?? 'name') as ClientSort
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1)
  const filters: ClientFilters = { q: sp.q, status, country: sp.country, currency: sp.currency, rep: sp.rep, terms: sp.terms, sort, page }

  const [{ rows, total }, counts, facets, reps, terms] = await Promise.all([
    listClients(filters), countByStatus(), getFacets(), listSalesReps(), listPaymentTerms(),
  ])
  const repNames = await directoryByIds(rows.map((r) => r.sales_rep_id))
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const canWrite = ctx.permissions.includes(P.CLIENTS_WRITE)

  const qs = (over: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams()
    const base: Record<string, string | number | undefined> = { q: sp.q, status: status === 'active' ? undefined : status, country: sp.country, currency: sp.currency, rep: sp.rep, terms: sp.terms, sort: sort === 'name' ? undefined : sort, ...over }
    for (const [k, v] of Object.entries(base)) if (v !== undefined && v !== '') p.set(k, String(v))
    const s = p.toString()
    return s ? `/clients?${s}` : '/clients'
  }
  const hasFilters = Boolean(sp.q || sp.country || sp.currency || sp.rep || sp.terms)

  return (
    <>
      <PageHeader
        title="Clients"
        description="Fiches clients, contacts, adresses, conditions et documents."
        actions={
          canWrite && (
            <Link href="/clients/new" className={buttonVariants({ variant: 'command', size: 'sm' })}>
              <Plus className="h-4 w-4" /> Nouveau client
            </Link>
          )
        }
      />
      <div className="space-y-4 p-4 sm:p-6">
        {sp.deleted && <Alert tone="success">Client supprimé définitivement.</Alert>}

        <nav aria-label="Statut" className="flex gap-1 overflow-x-auto border-b border-line">
          {([
            ['active', 'Actifs', counts.active],
            ['archived', 'Archivés', counts.archived],
            ['all', 'Tous', counts.active + counts.archived],
          ] as const).map(([id, text, n]) => (
            <Link
              key={id}
              href={qs({ status: id === 'active' ? undefined : id, page: undefined })}
              aria-current={status === id ? 'page' : undefined}
              className={cn('-mb-px whitespace-nowrap border-b-2 px-4 py-2 text-sm', status === id ? 'border-brand-500 font-semibold text-brand-700' : 'border-transparent text-ink-soft hover:text-ink')}
            >
              {text} <span className="ml-1 rounded-full bg-canvas px-1.5 text-xs">{n}</span>
            </Link>
          ))}
        </nav>

        <form action="/clients" role="search" className="space-y-3 rounded-md border border-line bg-white p-4 shadow-card">
          {status !== 'active' && <input type="hidden" name="status" value={status} />}
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
            <Input name="q" defaultValue={sp.q} placeholder="Rechercher : raison sociale, code, identifiant fiscal, e-mail, téléphone…" className="pl-8" aria-label="Rechercher un client" />
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
            <div>
              <Label htmlFor="country">Pays</Label>
              <Select id="country" name="country" defaultValue={sp.country ?? ''}>
                <option value="">Tous</option>
                {facets.countries.map((c) => <option key={c} value={c}>{countryName(c)}</option>)}
              </Select>
            </div>
            <div>
              <Label htmlFor="currency">Devise</Label>
              <Select id="currency" name="currency" defaultValue={sp.currency ?? ''}>
                <option value="">Toutes</option>
                {facets.currencies.map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            </div>
            <div>
              <Label htmlFor="rep">Commercial</Label>
              <Select id="rep" name="rep" defaultValue={sp.rep ?? ''}>
                <option value="">Tous</option>
                <option value="none">Non affecté</option>
                {reps.map((r) => <option key={r.id} value={r.id}>{r.full_name}</option>)}
              </Select>
            </div>
            <div>
              <Label htmlFor="terms">Paiement</Label>
              <Select id="terms" name="terms" defaultValue={sp.terms ?? ''}>
                <option value="">Tous</option>
                {terms.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </Select>
            </div>
            <div className="col-span-2 md:col-span-1">
              <Label htmlFor="sort">Tri</Label>
              <Select id="sort" name="sort" defaultValue={sort}>
                {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </Select>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit">Appliquer</Button>
            {hasFilters && <Link href={qs({ q: undefined, country: undefined, currency: undefined, rep: undefined, terms: undefined, page: undefined })} className="text-sm text-brand-600 hover:underline">Réinitialiser les filtres</Link>}
            <span className="ml-auto text-sm text-ink-soft">{total} résultat(s)</span>
          </div>
        </form>

        {/* Cartes (mobile) */}
        <ul className="grid gap-3 md:hidden">
          {rows.map((c) => (
            <li key={c.id}>
              <Link href={`/clients/${c.id}`} className="block rounded-md border border-line bg-white p-4 shadow-card active:bg-canvas">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-brand-700">{c.name}</p>
                    <p className="font-mono text-xs text-ink-faint">{c.code}</p>
                  </div>
                  {c.archived_at && <Badge tone="warning">Archivé</Badge>}
                </div>
                <p className="mt-2 text-sm">{flag(c.country)} {countryName(c.country)} · {c.currency}</p>
                {c.primary_contact && <p className="mt-1 truncate text-sm text-ink-soft">{c.primary_contact.full_name}{c.primary_contact.email ? ` · ${c.primary_contact.email}` : ''}</p>}
                <p className="mt-1 text-xs text-ink-faint">{c.sales_rep_id ? `Commercial : ${repNames.get(c.sales_rep_id)?.full_name ?? '—'}` : 'Non affecté'}</p>
              </Link>
            </li>
          ))}
          {rows.length === 0 && <li className="rounded-md border border-dashed border-line-strong p-8 text-center text-sm text-ink-soft">Aucun client ne correspond.</li>}
        </ul>

        {/* Tableau (≥ md) */}
        <Card className="hidden md:block">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-canvas text-xs uppercase text-ink-soft">
                <tr>
                  <th className="px-5 py-2 font-semibold">Client</th>
                  <th className="px-3 py-2 font-semibold">Pays</th>
                  <th className="px-3 py-2 font-semibold">Contact principal</th>
                  <th className="px-3 py-2 font-semibold">Commercial</th>
                  <th className="px-3 py-2 font-semibold">Devise</th>
                  <th className="px-5 py-2 font-semibold">Modifié</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} className="border-t border-line hover:bg-canvas/60">
                    <td className="px-5 py-3">
                      <Link href={`/clients/${c.id}`} className="font-semibold text-brand-700 hover:underline">{c.name}</Link>
                      {c.archived_at && <Badge tone="warning" className="ml-2">Archivé</Badge>}
                      <div className="font-mono text-xs text-ink-faint">{c.code}{c.tax_id ? ` · ${c.tax_id}` : ''}</div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3">{flag(c.country)} {countryName(c.country)}</td>
                    <td className="px-3 py-3">
                      {c.primary_contact ? (
                        <>
                          <div>{c.primary_contact.full_name}</div>
                          <div className="flex flex-wrap gap-x-3 text-xs text-ink-soft">
                            {c.primary_contact.email && <span className="inline-flex items-center gap-1"><Mail className="h-3 w-3" />{c.primary_contact.email}</span>}
                            {c.primary_contact.phone && <span className="inline-flex items-center gap-1"><Phone className="h-3 w-3" />{c.primary_contact.phone}</span>}
                          </div>
                        </>
                      ) : <span className="text-ink-faint">—</span>}
                    </td>
                    <td className="px-3 py-3">{c.sales_rep_id ? repNames.get(c.sales_rep_id)?.full_name ?? '—' : <span className="text-ink-faint">Non affecté</span>}</td>
                    <td className="px-3 py-3">{c.currency}</td>
                    <td className="whitespace-nowrap px-5 py-3 text-ink-soft">{formatDateTime(c.updated_at)}</td>
                  </tr>
                ))}
                {rows.length === 0 && <tr><td colSpan={6} className="px-5 py-12 text-center text-ink-soft">Aucun client ne correspond à ces critères.</td></tr>}
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
