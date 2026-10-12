import type { Metadata } from 'next'
import Link from 'next/link'
import { AlertTriangle, ChevronLeft, ChevronRight, ClipboardCheck, FolderOpen, Search, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { DocumentsList } from '@/features/ged/components/documents-list'
import { PAGE_SIZE, clientStats, listClientsLite, searchDocuments } from '@/features/ged/services/ged.service'
import { directoryByIds } from '@/features/clients/services/clients.service'
import { createClient } from '@/lib/supabase/server'
import { STATUS, SYSTEM_FOLDERS, humanSize } from '@/lib/ged/constants'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'GED — Documents' }

type SP = Partial<Record<'q' | 'client' | 'folder' | 'status' | 'expiring' | 'page', string>>

export default async function GedHome({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await requirePermission(P.DOCUMENTS_READ)
  const sp = await searchParams
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1)
  const hasFilters = Boolean(sp.q || sp.client || sp.folder || sp.status || sp.expiring)

  const [clients, stats] = await Promise.all([listClientsLite(), clientStats()])
  const clientNames = new Map(clients.map((c) => [c.id, c.name]))
  const canWrite = ctx.permissions.includes(P.DOCUMENTS_WRITE)
  const canDelete = ctx.permissions.includes(P.DOCUMENTS_DELETE)
  const canValidate = ctx.permissions.includes(P.DOCUMENTS_VALIDATE)

  let results: Awaited<ReturnType<typeof searchDocuments>> | null = null
  const folderNames = new Map<string, string>()
  let users = new Map<string, { full_name: string }>()
  if (hasFilters) {
    results = await searchDocuments({ q: sp.q, clientId: sp.client, folderKey: sp.folder, status: sp.status, expiring: Boolean(sp.expiring), page })
    const supabase = await createClient()
    const ids = [...new Set(results.rows.map((d) => d.folder_id))]
    if (ids.length) {
      const { data } = await supabase.from('ged_folders').select('id,name').in('id', ids)
      for (const f of data ?? []) folderNames.set(f.id as string, f.name as string)
    }
    users = (await directoryByIds(results.rows.flatMap((d) => [d.updated_by, d.deleted_by]))) as unknown as typeof users
  }
  const totalPages = results ? Math.max(1, Math.ceil(results.total / PAGE_SIZE)) : 1

  const qs = (over: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries({ q: sp.q, client: sp.client, folder: sp.folder, status: sp.status, expiring: sp.expiring, ...over })) if (v !== undefined && v !== '') p.set(k, String(v))
    return `/ged?${p.toString()}`
  }
  const totalPending = [...stats.values()].reduce((n, s) => n + s.pending, 0)
  const totalExpiring = [...stats.values()].reduce((n, s) => n + s.expiring, 0)
  const spaces = clients.filter((c) => !c.archived_at || stats.has(c.id))

  return (
    <>
      <PageHeader title="GED — Documents" description="Espace documentaire de chaque client : contrats, commandes, factures, BAT, patronages, certifications…" />
      <div className="space-y-4 p-4 sm:p-6">
        <form action="/ged" role="search" className="space-y-3 rounded-md border border-line bg-white p-4 shadow-card">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
            <Input name="q" defaultValue={sp.q} placeholder="Rechercher dans tous les documents : titre, description, nom de fichier, mot-clé…" className="pl-8" aria-label="Recherche" />
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <div>
              <Label htmlFor="client">Client</Label>
              <Select id="client" name="client" defaultValue={sp.client ?? ''}>
                <option value="">Tous</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </div>
            <div>
              <Label htmlFor="folder">Type de dossier</Label>
              <Select id="folder" name="folder" defaultValue={sp.folder ?? ''}>
                <option value="">Tous</option>
                {SYSTEM_FOLDERS.map((f) => <option key={f.key} value={f.key}>{f.name}</option>)}
              </Select>
            </div>
            <div>
              <Label htmlFor="status">Statut</Label>
              <Select id="status" name="status" defaultValue={sp.status ?? ''}>
                <option value="">Tous</option>
                {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </Select>
            </div>
            <label className="col-span-2 flex items-end gap-2 pb-2 text-sm md:col-span-1">
              <Checkbox name="expiring" value="1" defaultChecked={Boolean(sp.expiring)} /> Expire sous 60 jours
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit">Rechercher</Button>
            {hasFilters && <Link href="/ged" className="text-sm text-brand-600 hover:underline">Réinitialiser</Link>}
          </div>
        </form>

        {results ? (
          <>
            <p className="text-sm text-ink-soft">{results.total} document(s)</p>
            <DocumentsList docs={results.rows} folderNames={folderNames} users={users} clientNames={clientNames} showClient canWrite={canWrite} canDelete={canDelete}
              empty="Aucun document ne correspond à cette recherche." />
            {totalPages > 1 && (
              <div className="flex items-center justify-between text-sm text-ink-soft">
                <span>Page {Math.min(page, totalPages)} / {totalPages}</span>
                <div className="flex gap-2">
                  {page > 1 && <Link href={qs({ page: page - 1 })} className={buttonVariants({ variant: 'secondary', size: 'sm' })}><ChevronLeft className="h-4 w-4" /> Précédent</Link>}
                  {page < totalPages && <Link href={qs({ page: page + 1 })} className={buttonVariants({ variant: 'secondary', size: 'sm' })}>Suivant <ChevronRight className="h-4 w-4" /></Link>}
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            {(totalPending > 0 || totalExpiring > 0) && (
              <div className="flex flex-wrap gap-3">
                {totalPending > 0 && (
                  <Link href="/ged?status=pending_review" className="inline-flex items-center gap-2 rounded-md border border-warn/30 bg-warn-bg px-3 py-2 text-sm text-warn-text">
                    <ClipboardCheck className="h-4 w-4" /> {totalPending} document(s) en attente de validation{canValidate ? '' : ''}
                  </Link>
                )}
                {totalExpiring > 0 && (
                  <Link href="/ged?expiring=1" className="inline-flex items-center gap-2 rounded-md border border-danger/30 bg-danger-bg px-3 py-2 text-sm text-danger-text">
                    <AlertTriangle className="h-4 w-4" /> {totalExpiring} document(s) expirés ou bientôt expirés
                  </Link>
                )}
              </div>
            )}

            <h2 className="text-base font-semibold">Espaces documentaires</h2>
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {spaces.map((c) => {
                const s = stats.get(c.id)
                return (
                  <li key={c.id}>
                    <Link href={`/ged/${c.id}`} className="block rounded-md border border-line bg-white p-4 shadow-card transition-colors hover:border-brand-400">
                      <div className="flex items-start gap-3">
                        <FolderOpen className="mt-0.5 h-6 w-6 shrink-0 text-brand-500" aria-hidden />
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-semibold text-brand-700">{c.name}</p>
                          <p className="font-mono text-xs text-ink-faint">{c.code}{c.archived_at ? ' · archivé' : ''}</p>
                        </div>
                      </div>
                      <p className="mt-3 text-sm">{s?.documents ?? 0} document(s) · {humanSize(s?.size_bytes ?? 0)}</p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {(s?.pending ?? 0) > 0 && <Badge tone="warning">{s!.pending} à valider</Badge>}
                        {(s?.expiring ?? 0) > 0 && <Badge tone="danger">{s!.expiring} à renouveler</Badge>}
                        {(s?.trashed ?? 0) > 0 && <Badge><Trash2 className="mr-1 h-3 w-3" />{s!.trashed}</Badge>}
                      </div>
                    </Link>
                  </li>
                )
              })}
              {spaces.length === 0 && <li className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft sm:col-span-2 xl:col-span-3">Aucun client : créez d’abord un client, son espace documentaire est créé automatiquement.</li>}
            </ul>
          </>
        )}
      </div>
    </>
  )
}
