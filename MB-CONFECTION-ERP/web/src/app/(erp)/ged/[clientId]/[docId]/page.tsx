import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, Download, Trash2 } from 'lucide-react'
import { z } from 'zod'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { ExpiryBadge, FileIcon, StatusBadge } from '@/features/ged/components/badges'
import { CommentForm, MetaForm, PurgeButton, RestoreVersionButton, ReviewPanel } from '@/features/ged/components/document-forms'
import { GedHistory } from '@/features/ged/components/ged-history'
import { DocumentPreview } from '@/features/ged/components/preview'
import { Uploader } from '@/features/ged/components/uploader'
import { deleteCommentAction, restoreDocumentAction, trashDocumentAction } from '@/features/ged/actions'
import { documentHistory, getDocument, listComments, listFolders, listVersions } from '@/features/ged/services/ged.service'
import { directoryByIds, getClient } from '@/features/clients/services/clients.service'
import { clientArticles } from '@/features/articles/services/articles.service'
import { TRASH_RETENTION_DAYS, humanSize } from '@/lib/ged/constants'
import { P } from '@/lib/rbac/permissions'
import { formatDateTime } from '@/lib/utils'

export const metadata: Metadata = { title: 'Document' }

export default async function DocumentPage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string; docId: string }>
  searchParams: Promise<{ v?: string }>
}) {
  const ctx = await requirePermission(P.DOCUMENTS_READ)
  const { clientId, docId } = await params
  if (!z.uuid().safeParse(clientId).success || !z.uuid().safeParse(docId).success) notFound()
  const sp = await searchParams

  const doc = await getDocument(docId)
  if (!doc || doc.client_id !== clientId) notFound()
  const [client, versions, comments, folders, history] = await Promise.all([
    getClient(clientId), listVersions(docId), listComments(docId), listFolders(clientId),
    ctx.permissions.includes(P.DOCUMENTS_READ) ? documentHistory(docId) : Promise.resolve([]),
  ])
  if (!client) notFound()

  const canReadArticles = ctx.permissions.includes(P.ARTICLES_READ)
  const articles = canReadArticles ? await clientArticles(clientId) : []
  const linkedArticle = articles.find((a) => a.id === (doc as unknown as { article_id?: string | null }).article_id)
  const previewed = versions.find((v) => v.id === sp.v) ?? versions.find((v) => v.id === doc.current_version_id) ?? versions[0]
  const users = await directoryByIds([doc.created_by, doc.updated_by, doc.validated_by, doc.deleted_by, ...versions.map((v) => v.uploaded_by), ...comments.map((c) => c.author_id)])
  const name = (id: string | null) => (id ? users.get(id)?.full_name ?? 'Utilisateur' : '—')

  const trashed = Boolean(doc.deleted_at)
  const locked = Boolean(client.archived_at)
  const canWrite = ctx.permissions.includes(P.DOCUMENTS_WRITE) && !locked && !trashed
  const canDelete = ctx.permissions.includes(P.DOCUMENTS_DELETE)
  const canValidate = ctx.permissions.includes(P.DOCUMENTS_VALIDATE) && !locked && !trashed
  const folderPath = (id: string): string => {
    const f = folders.find((x) => x.id === id)
    return f ? (f.parent_id ? `${folderPath(f.parent_id)} / ${f.name}` : f.name) : '—'
  }
  const folderOptions = folders.map((f) => ({ id: f.id, label: folderPath(f.id) })).sort((a, b) => a.label.localeCompare(b.label, 'fr'))
  const daysLeft = doc.deleted_at ? Math.max(0, TRASH_RETENTION_DAYS - Math.floor((Date.now() - new Date(doc.deleted_at).getTime()) / 86_400_000)) : 0

  return (
    <>
      <PageHeader
        title={doc.title}
        description={`${client.name} · ${folderPath(doc.folder_id)}`}
        actions={
          <>
            <Link href={`/ged/${clientId}?folder=${doc.folder_id}`} className={buttonVariants({ variant: 'command', size: 'sm' })}><ArrowLeft className="h-4 w-4" /> Dossier</Link>
            {previewed && <a href={`/ged/files/${previewed.id}?download=1`} className={buttonVariants({ variant: 'command', size: 'sm' })}><Download className="h-4 w-4" /> Télécharger v{previewed.version_no}</a>}
            {trashed && ctx.permissions.includes(P.DOCUMENTS_WRITE) && !locked && (
              <form action={restoreDocumentAction}><input type="hidden" name="id" value={doc.id} /><input type="hidden" name="client_id" value={clientId} />
                <Button variant="command" size="sm" type="submit">Restaurer</Button></form>
            )}
            {!trashed && canWrite && (doc.status !== 'validated' || canDelete) && (
              <form action={trashDocumentAction}>
                <input type="hidden" name="id" value={doc.id} /><input type="hidden" name="client_id" value={clientId} /><input type="hidden" name="redirect" value="1" />
                <Button variant="command" size="sm" type="submit" className="text-danger-text"><Trash2 className="h-4 w-4" /> Corbeille</Button>
              </form>
            )}
          </>
        }
      />

      <div className="space-y-4 p-4 sm:p-6">
        {trashed && (
          <Alert tone="warning">
            Ce document est dans la corbeille depuis le {formatDateTime(doc.deleted_at)} ({name(doc.deleted_by)}). Suppression définitive dans {daysLeft} jour(s).
            {canDelete && !locked && <div className="mt-2"><PurgeButton id={doc.id} clientId={clientId} title={doc.title} /></div>}
          </Alert>
        )}
        {locked && <Alert tone="info">Client archivé : document en lecture seule.</Alert>}

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
          <div className="min-w-0 space-y-4">
            {previewed && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex min-w-0 items-center gap-2">
                    <FileIcon mime={previewed.mime_type} />
                    <span className="truncate">{previewed.file_name}</span>
                  </CardTitle>
                  <div className="flex items-center gap-2 text-xs text-ink-soft">
                    <Badge tone={previewed.id === doc.current_version_id ? 'brand' : 'warning'}>
                      v{previewed.version_no}{previewed.id === doc.current_version_id ? ' · version courante' : ' · ancienne version'}
                    </Badge>
                    {humanSize(previewed.size_bytes)}
                  </div>
                </CardHeader>
                <CardContent><DocumentPreview version={previewed} /></CardContent>
              </Card>
            )}

            <Card>
              <CardHeader><CardTitle>Versions ({versions.length})</CardTitle></CardHeader>
              <ul className="divide-y divide-line">
                {versions.map((v) => {
                  const isCurrent = v.id === doc.current_version_id
                  return (
                    <li key={v.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
                      <Badge tone={isCurrent ? 'brand' : 'neutral'}>v{v.version_no}</Badge>
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{v.file_name} <span className="font-normal text-ink-soft">· {humanSize(v.size_bytes)}</span></p>
                        <p className="text-xs text-ink-soft">{name(v.uploaded_by)} · {formatDateTime(v.created_at)}{doc.validated_version_id === v.id ? ' · ✔ validée' : ''}</p>
                        {v.change_note && <p className="text-xs text-ink">« {v.change_note} »</p>}
                      </div>
                      <div className="flex items-center gap-1">
                        {previewed?.id !== v.id && <Link href={`/ged/${clientId}/${docId}?v=${v.id}`} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>Aperçu</Link>}
                        <a href={`/ged/files/${v.id}?download=1`} className={buttonVariants({ variant: 'ghost', size: 'sm' })} aria-label={`Télécharger la version ${v.version_no}`}><Download className="h-4 w-4" /></a>
                        {!isCurrent && canWrite && <RestoreVersionButton docId={docId} versionId={v.id} versionNo={v.version_no} />}
                      </div>
                    </li>
                  )
                })}
              </ul>
              {canWrite && (
                <div className="border-t border-line p-4">
                  <p className="mb-2 text-sm font-semibold">Ajouter une nouvelle version</p>
                  <Uploader mode="version" clientId={clientId} documentId={docId} />
                  {doc.status === 'validated' && <p className="mt-2 text-xs text-warn-text">Le document est validé : une nouvelle version annulera la validation.</p>}
                </div>
              )}
            </Card>

            <Card>
              <CardHeader><CardTitle>Commentaires ({comments.length})</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <ul className="space-y-3">
                  {comments.map((c) => (
                    <li key={c.id} className="rounded-md bg-canvas p-3 text-sm">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-xs text-ink-soft"><strong className="text-ink">{name(c.author_id)}</strong> · {formatDateTime(c.created_at)}</p>
                        {(c.author_id === ctx.user.id || canDelete) && !locked && (
                          <form action={deleteCommentAction}>
                            <input type="hidden" name="id" value={c.id} /><input type="hidden" name="client_id" value={clientId} /><input type="hidden" name="document_id" value={docId} />
                            <button type="submit" className="text-xs text-ink-faint hover:text-danger-text" aria-label="Supprimer le commentaire"><Trash2 className="h-3.5 w-3.5" /></button>
                          </form>
                        )}
                      </div>
                      <p className="mt-1 whitespace-pre-wrap">{c.body}</p>
                    </li>
                  ))}
                  {comments.length === 0 && <li className="text-sm text-ink-soft">Aucun commentaire.</li>}
                </ul>
                {!trashed && !locked && <CommentForm docId={docId} clientId={clientId} />}
              </CardContent>
            </Card>
          </div>

          <div className="min-w-0 space-y-4">
            <Card>
              <CardHeader><CardTitle>Validation</CardTitle><StatusBadge status={doc.status} /></CardHeader>
              <CardContent className="space-y-3">
                {doc.validated_at && (
                  <div className="rounded-sm bg-canvas p-3 text-sm">
                    <p>{doc.status === 'validated' ? 'Validé' : 'Rejeté'} par <strong>{name(doc.validated_by)}</strong> le {formatDateTime(doc.validated_at)}</p>
                    {doc.validation_comment && <p className="mt-1 text-ink-soft">« {doc.validation_comment} »</p>}
                  </div>
                )}
                {!trashed && !locked && <ReviewPanel docId={docId} clientId={clientId} status={doc.status} canWrite={canWrite} canValidate={canValidate} />}
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle>Informations</CardTitle></CardHeader>
              <CardContent>
                <dl className="mb-4 grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5 text-sm">
                  <dt className="text-ink-soft">Validité</dt><dd>{doc.valid_until ? <ExpiryBadge validUntil={doc.valid_until} /> : '—'}</dd>
                  <dt className="text-ink-soft">Créé</dt><dd>{formatDateTime(doc.created_at)} · {name(doc.created_by)}</dd>
                  <dt className="text-ink-soft">Modifié</dt><dd>{formatDateTime(doc.updated_at)} · {name(doc.updated_by)}</dd>
                  <dt className="text-ink-soft">Empreinte</dt><dd className="break-all font-mono text-xs">{doc.sha256 ? `${doc.sha256.slice(0, 16)}…` : '—'}</dd>
                </dl>
                {linkedArticle && <p className="mb-3 text-sm"><span className="text-ink-soft">Article : </span><Link href={`/articles/${linkedArticle.id}?tab=documents`} className="font-semibold text-brand-700 hover:underline">{linkedArticle.internal_ref} — {linkedArticle.name}</Link></p>}
                <MetaForm doc={doc as unknown as Parameters<typeof MetaForm>[0]['doc']} folders={folderOptions} articles={canReadArticles ? articles.map((a) => ({ id: a.id, label: `${a.internal_ref} · ${a.client_ref} — ${a.name}` })) : undefined} canWrite={canWrite} />
              </CardContent>
            </Card>
          </div>
        </div>

        <Card>
          <CardHeader><CardTitle>Historique</CardTitle></CardHeader>
          <CardContent><GedHistory rows={history} /></CardContent>
        </Card>
      </div>
    </>
  )
}
