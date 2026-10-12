import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, ChevronLeft, ChevronRight, Search } from 'lucide-react'
import { z } from 'zod'
import { Alert } from '@/components/ui/alert'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { DocumentsList } from '@/features/ged/components/documents-list'
import { EmptyTrashButton } from '@/features/ged/components/document-forms'
import { FolderManager } from '@/features/ged/components/folder-manager'
import { FolderTree } from '@/features/ged/components/folder-tree'
import { GedHistory } from '@/features/ged/components/ged-history'
import { Uploader } from '@/features/ged/components/uploader'
import { PAGE_SIZE, clientActivity, folderCounts, listFolders, searchDocuments } from '@/features/ged/services/ged.service'
import { directoryByIds, getClient } from '@/features/clients/services/clients.service'
import { STATUS, TRASH_RETENTION_DAYS } from '@/lib/ged/constants'
import { P } from '@/lib/rbac/permissions'
import { cn } from '@/lib/utils'

export const metadata: Metadata = { title: 'Espace documentaire' }

type SP = Partial<Record<'folder' | 'view' | 'q' | 'status' | 'page' | 'trashed', string>>

export default async function ClientSpacePage({ params, searchParams }: { params: Promise<{ clientId: string }>; searchParams: Promise<SP> }) {
  const ctx = await requirePermission(P.DOCUMENTS_READ)
  const { clientId } = await params
  if (!z.uuid().safeParse(clientId).success) notFound()
  const sp = await searchParams

  const client = await getClient(clientId)
  if (!client) notFound()

  const view: 'all' | 'folder' | 'trash' | 'activity' = sp.view === 'trash' ? 'trash' : sp.view === 'activity' ? 'activity' : sp.folder ? 'folder' : 'all'
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1)
  const [folders, counts] = await Promise.all([listFolders(clientId), folderCounts(clientId)])
  const current = sp.folder ? folders.find((f) => f.id === sp.folder) : undefined
  if (sp.folder && !current) notFound()

  const descendants = (id: string): string[] => [id, ...folders.filter((f) => f.parent_id === id).flatMap((f) => descendants(f.id))]
  const canWrite = ctx.permissions.includes(P.DOCUMENTS_WRITE) && !client.archived_at
  const canDelete = ctx.permissions.includes(P.DOCUMENTS_DELETE) && !client.archived_at

  // Documents du dossier courant (sous-dossiers inclus) / de la corbeille
  const folderIds = view === 'folder' && current ? descendants(current.id) : undefined
  const docs: Awaited<ReturnType<typeof searchDocuments>> =
    view === 'activity' ? { rows: [], total: 0 } : await searchDocuments({ clientId, folderIds, trash: view === 'trash', q: sp.q, status: sp.status, page })
  const activity = view === 'activity' ? await clientActivity(clientId) : []
  const users = await directoryByIds(docs.rows.flatMap((d) => [d.updated_by, d.deleted_by]))
  const folderNames = new Map(folders.map((f) => [f.id, f.name]))
  const totalPages = Math.max(1, Math.ceil(docs.total / PAGE_SIZE))

  const qs = (over: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries({ folder: sp.folder, view: sp.view, q: sp.q, status: sp.status, ...over })) if (v !== undefined && v !== '') p.set(k, String(v))
    const s = p.toString()
    return `/ged/${clientId}${s ? `?${s}` : ''}`
  }

  const tab = (id: string, label: string, href: string, active: boolean) => (
    <Link key={id} href={href} aria-current={active ? 'page' : undefined}
      className={cn('-mb-px whitespace-nowrap border-b-2 px-4 py-2 text-sm', active ? 'border-brand-500 font-semibold text-brand-700' : 'border-transparent text-ink-soft hover:text-ink')}>
      {label}
    </Link>
  )

  const tree = <FolderTree clientId={clientId} folders={folders} counts={counts.byFolder} trash={counts.trash} activeFolder={current?.id} view={view === 'folder' ? 'folder' : view === 'trash' ? 'trash' : 'all'} />

  return (
    <>
      <PageHeader
        title={client.name}
        description={`Espace documentaire · ${client.code}`}
        actions={
          <>
            <Link href="/ged" className={buttonVariants({ variant: 'command', size: 'sm' })}><ArrowLeft className="h-4 w-4" /> GED</Link>
            <Link href={`/clients/${clientId}`} className={buttonVariants({ variant: 'command', size: 'sm' })}>Fiche client</Link>
          </>
        }
      />
      <div className="space-y-4 p-4 sm:p-6">
        {sp.trashed && <Alert tone="success">Document placé dans la corbeille.</Alert>}
        {client.archived_at && <Alert tone="warning">Client archivé : l’espace documentaire est en lecture seule.</Alert>}

        <div className="grid gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
          <aside className="space-y-2">
            <details className="lg:hidden">
              <summary className="cursor-pointer rounded-md border border-line bg-white px-3 py-2 text-sm font-semibold shadow-card">Dossiers{current ? ` — ${current.name}` : view === 'trash' ? ' — Corbeille' : ''}</summary>
              <div className="mt-2">{tree}</div>
            </details>
            <div className="hidden lg:block">{tree}</div>
          </aside>

          <section className="min-w-0 space-y-4">
            <nav aria-label="Vue" className="-mx-4 flex gap-1 overflow-x-auto border-b border-line px-4 sm:mx-0 sm:px-0">
              {tab('docs', current ? current.name : 'Documents', qs({ view: undefined, page: undefined }), view === 'all' || view === 'folder')}
              {tab('trash', `Corbeille (${counts.trash})`, qs({ view: 'trash', folder: undefined, page: undefined }), view === 'trash')}
              {tab('activity', 'Activité', qs({ view: 'activity', folder: undefined, page: undefined }), view === 'activity')}
            </nav>

            {view === 'activity' ? (
              <Card><CardContent><GedHistory rows={activity} showTitle /></CardContent></Card>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <form action={`/ged/${clientId}`} role="search" className="flex min-w-0 flex-1 flex-wrap gap-2">
                    {sp.folder && <input type="hidden" name="folder" value={sp.folder} />}
                    {sp.view === 'trash' && <input type="hidden" name="view" value="trash" />}
                    <div className="relative min-w-48 flex-1">
                      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
                      <Input name="q" defaultValue={sp.q} placeholder="Rechercher dans cet espace…" className="pl-8" aria-label="Rechercher" />
                    </div>
                    <Select name="status" defaultValue={sp.status ?? ''} className="w-40" aria-label="Statut">
                      <option value="">Tous statuts</option>
                      {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                    </Select>
                    <Button type="submit" variant="secondary">Filtrer</Button>
                  </form>
                  {view !== 'trash' && <FolderManager clientId={clientId} current={current ? { id: current.id, name: current.name, system: Boolean(current.system_key) } : undefined} canWrite={canWrite} />}
                  {view === 'trash' && canDelete && <EmptyTrashButton clientId={clientId} count={counts.trash} />}
                </div>

                {view !== 'trash' && (
                  <Uploader
                    clientId={clientId}
                    folderId={current?.id}
                    disabled={!canWrite || !current}
                    disabledReason={!canWrite ? undefined : 'Sélectionnez un dossier dans l’arborescence pour y déposer des fichiers.'}
                  />
                )}
                {view === 'trash' && <p className="text-sm text-ink-soft">Les documents supprimés sont conservés {TRASH_RETENTION_DAYS} jours puis effacés définitivement. Un document validé ne peut être supprimé que par un responsable.</p>}

                <DocumentsList docs={docs.rows} folderNames={folderNames} users={users as unknown as Map<string, { full_name: string }>}
                  trash={view === 'trash'} canWrite={canWrite} canDelete={ctx.permissions.includes(P.DOCUMENTS_DELETE)}
                  empty={view === 'trash' ? 'La corbeille est vide.' : sp.q || sp.status ? 'Aucun document ne correspond.' : 'Aucun document ici pour le moment.'} />

                {totalPages > 1 && (
                  <div className="flex items-center justify-between text-sm text-ink-soft">
                    <span>Page {Math.min(page, totalPages)} / {totalPages} · {docs.total} document(s)</span>
                    <div className="flex gap-2">
                      {page > 1 && <Link href={qs({ page: page - 1 })} className={buttonVariants({ variant: 'secondary', size: 'sm' })}><ChevronLeft className="h-4 w-4" /> Précédent</Link>}
                      {page < totalPages && <Link href={qs({ page: page + 1 })} className={buttonVariants({ variant: 'secondary', size: 'sm' })}>Suivant <ChevronRight className="h-4 w-4" /></Link>}
                    </div>
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      </div>
    </>
  )
}
