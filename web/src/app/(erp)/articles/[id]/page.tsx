import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, ImageOff } from 'lucide-react'
import { z } from 'zod'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { ArticleActions } from '@/features/articles/components/article-actions'
import { ArticleDocuments } from '@/features/articles/components/documents-panel'
import { ArticleHistory } from '@/features/articles/components/history-panel'
import { PhotosPanel } from '@/features/articles/components/photos-panel'
import { SpecView } from '@/features/articles/components/spec-view'
import { VersionsPanel, type VersionRow } from '@/features/articles/components/versions-panel'
import { getArticle, getClientLite, linkedDocuments, listPhotos, listVersions, unlinkedClientDocuments } from '@/features/articles/services/articles.service'
import { bomOfArticle } from '@/features/bom/services/bom.service'
import { directoryByIds } from '@/features/clients/services/clients.service'
import { listFolders } from '@/features/ged/services/ged.service'
import { recentAuditFor } from '@/features/rbac/services/audit-query.service'
import { ARTICLE_STATUS, EMPTY_SPEC, FAMILIES, VERSION_STATUS, label } from '@/lib/articles/options'
import { P } from '@/lib/rbac/permissions'
import { cn, formatDateTime } from '@/lib/utils'

export const metadata: Metadata = { title: 'Article' }

const TABS = [
  { id: 'overview', label: 'Fiche' }, { id: 'photos', label: 'Photos' }, { id: 'versions', label: 'Versions' },
  { id: 'documents', label: 'Documents (GED)' }, { id: 'history', label: 'Historique' },
] as const
type TabId = (typeof TABS)[number]['id']
const FLASH: Record<string, string> = { created: 'Article créé. Complétez maintenant sa fiche (couleurs, tailles, normes…).', updated: 'Modifications enregistrées.', validated: 'Version validée : elle est désormais utilisée en production.' }

export default async function ArticlePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requirePermission(P.ARTICLES_READ)
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const sp = await searchParams
  const tab = (TABS.find((t) => t.id === sp.tab)?.id ?? 'overview') as TabId

  const article = await getArticle(id)
  if (!article) notFound()
  const canDocs = ctx.permissions.includes(P.DOCUMENTS_READ)
  const [client, versions, photos, docs] = await Promise.all([
    getClientLite(article.client_id), listVersions(id), listPhotos(id), canDocs ? linkedDocuments(id) : Promise.resolve([]),
  ])
  const bomLink = ctx.permissions.includes(P.BOM_READ) ? await bomOfArticle(id) : null
  const history = tab === 'history' ? await recentAuditFor('article', id, 120) : []
  const gedFolders = tab === 'documents' && canDocs ? await listFolders(article.client_id) : []
  const unlinked = tab === 'documents' && canDocs && ctx.permissions.includes(P.DOCUMENTS_WRITE) ? await unlinkedClientDocuments(article.client_id) : []
  const users = await directoryByIds(versions.flatMap((v) => [v.created_by, v.validated_by]))

  const canWrite = ctx.permissions.includes(P.ARTICLES_WRITE)
  const canValidate = ctx.permissions.includes(P.ARTICLES_VALIDATE)
  const locked = Boolean(client?.archived_at)
  const shown = versions.find((v) => v.id === sp.v) ?? versions.find((v) => v.id === article.active_version_id) ?? versions[0]
  const spec = { ...EMPTY_SPEC, ...(shown?.spec ?? {}) }
  const flash = Object.keys(FLASH).find((k) => sp[k])
  const folderName = new Map(gedFolders.map((f) => [f.id, f.name]))
  const rows: VersionRow[] = versions.map((v) => ({
    ...v,
    author: v.created_by ? users.get(v.created_by)?.full_name : undefined,
    validator: v.validated_by ? users.get(v.validated_by)?.full_name : undefined,
    summary: `${v.spec.colors.length} couleur(s) · ${v.spec.sizes.length} taille(s) · ${v.spec.norms.length} norme(s)`,
  }))
  const mainPhoto = photos.find((p) => p.is_main) ?? photos[0]
  const canDelete = canWrite && article.status === 'draft' && !versions.some((v) => v.status !== 'draft')

  return (
    <>
      <PageHeader title={`${article.internal_ref} — ${article.name}`} description={`${client?.name ?? ''} · réf. client ${article.client_ref} · ${label(FAMILIES, article.family)}`}
        actions={<><Link href="/articles" className={buttonVariants({ variant: 'command', size: 'sm' })}><ArrowLeft className="h-4 w-4" /> Articles</Link>
          {client && <Link href={`/clients/${client.id}`} className={buttonVariants({ variant: 'command', size: 'sm' })}>Client</Link>}
          <ArticleActions id={id} reference={article.internal_ref} canWrite={canWrite && !locked} canDelete={canDelete && !locked} /></>} />

      <div className="space-y-4 p-4 sm:p-6">
        {flash && <Alert tone="success">{FLASH[flash]}</Alert>}
        {locked && <Alert tone="warning">Client archivé : l’article est en lecture seule.</Alert>}

        <nav aria-label="Sections de l’article" className="-mx-4 flex gap-1 overflow-x-auto border-b border-line px-4 sm:mx-0 sm:px-0">
          {TABS.filter((t) => canDocs || t.id !== 'documents').map((t) => (
            <Link key={t.id} href={t.id === 'overview' ? `/articles/${id}` : `/articles/${id}?tab=${t.id}`} aria-current={tab === t.id ? 'page' : undefined}
              className={cn('-mb-px whitespace-nowrap border-b-2 px-4 py-2 text-sm', tab === t.id ? 'border-brand-500 font-semibold text-brand-700' : 'border-transparent text-ink-soft hover:text-ink')}>
              {t.label}
              {t.id === 'photos' && photos.length > 0 && <span className="ml-1.5 rounded-full bg-canvas px-1.5 text-xs">{photos.length}</span>}
              {t.id === 'versions' && <span className="ml-1.5 rounded-full bg-canvas px-1.5 text-xs">{versions.length}</span>}
              {t.id === 'documents' && docs.length > 0 && <span className="ml-1.5 rounded-full bg-canvas px-1.5 text-xs">{docs.length}</span>}
            </Link>
          ))}
        </nav>

        {tab === 'overview' && (
          <div className="space-y-4">
            <Card>
              <CardContent className="flex flex-col gap-4 sm:flex-row">
                <div className="flex h-44 w-36 shrink-0 items-center justify-center self-center overflow-hidden rounded-md bg-canvas sm:self-start">
                  {mainPhoto ? (
                    // eslint-disable-next-line
                    <img src={`/articles/photo/${mainPhoto.id}`} alt={`Photo de ${article.internal_ref}`} className="h-full w-full object-cover" />
                  ) : <ImageOff className="h-8 w-8 text-line-strong" aria-label="Pas de photo" />}
                </div>
                <div className="min-w-0 flex-1 space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={ARTICLE_STATUS[article.status].tone}>{ARTICLE_STATUS[article.status].label}</Badge>
                    {article.active_version_id ? <Badge tone="brand">Version validée v{versions.find((v) => v.id === article.active_version_id)?.version_no}</Badge> : <Badge tone="warning">Aucune version validée</Badge>}
                  </div>
                  <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1.5 text-sm">
                    <dt className="text-ink-soft">Référence interne</dt><dd className="font-mono font-semibold">{article.internal_ref}</dd>
                    <dt className="text-ink-soft">Référence client</dt><dd className="font-mono font-semibold">{article.client_ref}</dd>
                    <dt className="text-ink-soft">Client</dt><dd className="font-medium">{client ? <Link href={`/clients/${client.id}`} className="text-brand-700 hover:underline">{client.name}</Link> : '—'}</dd>
                    <dt className="text-ink-soft">Famille</dt><dd className="font-medium">{label(FAMILIES, article.family)}</dd>
                    <dt className="text-ink-soft">Normes</dt><dd className="flex flex-wrap gap-1">{article.norm_codes.length ? article.norm_codes.map((n) => <Badge key={n} tone="brand">{n}</Badge>) : <span className="text-ink-faint">—</span>}</dd>
                    {ctx.permissions.includes(P.BOM_READ) && (<><dt className="text-ink-soft">Nomenclature</dt><dd>{bomLink ? <Link href={`/bom/${bomLink.id}`} className="font-mono font-semibold text-brand-700 hover:underline">{bomLink.code}</Link> : ctx.permissions.includes(P.BOM_WRITE) && !locked ? <Link href={`/bom/new?article=${id}`} className="text-brand-600 hover:underline">Créer la nomenclature</Link> : <span className="text-ink-faint">—</span>}{bomLink && <span className="ml-2 text-xs text-ink-soft">{bomLink.archived ? 'archivée' : bomLink.active_version_no ? `v${bomLink.active_version_no} validée` : 'non validée'}</span>}</dd></>)}
                    <dt className="text-ink-soft">Mis à jour</dt><dd>{formatDateTime(article.updated_at)}</dd>
                  </dl>
                  {article.description && <p className="whitespace-pre-wrap rounded-sm bg-canvas p-3 text-sm">{article.description}</p>}
                </div>
              </CardContent>
            </Card>

            {shown && (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-base font-semibold">Fiche — version {shown.version_no}</h2>
                  <Badge tone={VERSION_STATUS[shown.status].tone}>{VERSION_STATUS[shown.status].label}</Badge>
                  {shown.id !== article.active_version_id && article.active_version_id && <Link href={`/articles/${id}`} className="text-xs text-brand-600 hover:underline">Revenir à la version validée</Link>}
                </div>
                {shown.status === 'draft' && <Alert tone="info">Brouillon non validé : {article.active_version_id ? 'la production utilise toujours la version validée.' : 'aucune version n’est encore utilisable en production.'} <Link className="underline" href={`/articles/${id}?tab=versions`}>Gérer les versions</Link></Alert>}
                <SpecView spec={spec} />
              </>
            )}
          </div>
        )}

        {tab === 'photos' && <PhotosPanel articleId={id} clientId={article.client_id} photos={photos} canWrite={canWrite} locked={locked} />}
        {tab === 'versions' && <VersionsPanel articleId={id} versions={rows} canWrite={canWrite} canValidate={canValidate} locked={locked} activeVersionId={article.active_version_id} />}
        {tab === 'documents' && canDocs && (
          <ArticleDocuments articleId={id} clientId={article.client_id} docs={docs}
            folders={gedFolders.filter((f) => !f.parent_id).map((f) => ({ id: f.id, label: f.name }))}
            unlinked={unlinked.map((d) => ({ id: d.id, title: d.title, folder: folderName.get(d.folder_id) ?? '' }))}
            canWrite={ctx.permissions.includes(P.DOCUMENTS_WRITE)} locked={locked} />
        )}
        {tab === 'history' && <Card><CardHeader><CardTitle>Historique</CardTitle></CardHeader><CardContent><ArticleHistory rows={history} /></CardContent></Card>}
      </div>
    </>
  )
}
