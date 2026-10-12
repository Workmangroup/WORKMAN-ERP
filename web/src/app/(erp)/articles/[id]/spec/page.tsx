import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { z } from 'zod'
import { Alert } from '@/components/ui/alert'
import { buttonVariants } from '@/components/ui/button'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { SpecEditor } from '@/features/articles/components/spec-editor'
import { getArticle, getClientLite, listVersions } from '@/features/articles/services/articles.service'
import { EMPTY_SPEC } from '@/lib/articles/options'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Fiche article' }

/** Édition de la fiche d'une version en brouillon. Une version validée n'est jamais modifiable. */
export default async function SpecPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ v?: string }> }) {
  await requirePermission(P.ARTICLES_WRITE)
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const sp = await searchParams
  const article = await getArticle(id)
  if (!article) notFound()
  const [versions, client] = await Promise.all([listVersions(id), getClientLite(article.client_id)])
  const version = versions.find((v) => v.id === sp.v) ?? versions.find((v) => v.status === 'draft')
  if (!version) redirect(`/articles/${id}?tab=versions`)
  const editable = version.status === 'draft' && !client?.archived_at

  return (
    <>
      <PageHeader title={`${article.internal_ref} — fiche, version ${version.version_no}`} description={`${client?.name ?? ''} · réf. client ${article.client_ref}`}
        actions={<Link href={`/articles/${id}?tab=versions`} className={buttonVariants({ variant: 'command', size: 'sm' })}><ArrowLeft className="h-4 w-4" /> Versions</Link>} />
      <div className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6">
        {!editable ? (
          <Alert tone="warning">{client?.archived_at ? 'Client archivé : la fiche est en lecture seule.' : `La version ${version.version_no} est ${version.status === 'validated' ? 'validée' : 'obsolète'} et ne peut plus être modifiée. Créez une nouvelle version pour la faire évoluer.`}{' '}
            <Link className="underline" href={`/articles/${id}?v=${version.id}`}>Consulter</Link></Alert>
        ) : (
          <>
            <Alert tone="info">Brouillon de la version {version.version_no} : la production continue d’utiliser la version validée tant que ce brouillon n’est pas validé.</Alert>
            <SpecEditor articleId={id} versionId={version.id} versionNo={version.version_no} initial={{ ...EMPTY_SPEC, ...version.spec }} note={version.change_note} />
          </>
        )}
      </div>
    </>
  )
}
