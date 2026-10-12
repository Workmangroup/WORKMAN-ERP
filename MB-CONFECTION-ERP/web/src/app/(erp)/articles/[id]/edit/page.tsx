import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { z } from 'zod'
import { buttonVariants } from '@/components/ui/button'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { ArticleForm } from '@/features/articles/components/article-form'
import { getArticle, listClientsLite } from '@/features/articles/services/articles.service'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Modifier l’article' }

export default async function EditArticlePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePermission(P.ARTICLES_WRITE)
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const article = await getArticle(id)
  if (!article) notFound()
  const clients = await listClientsLite()
  return (
    <>
      <PageHeader title={`Modifier ${article.internal_ref}`} description={article.client_ref}
        actions={<Link href={`/articles/${id}`} className={buttonVariants({ variant: 'command', size: 'sm' })}><ArrowLeft className="h-4 w-4" /> Fiche article</Link>} />
      <div className="mx-auto max-w-3xl p-4 sm:p-6"><ArticleForm article={article} clients={clients} canActivate={ctx.permissions.includes(P.ARTICLES_VALIDATE)} /></div>
    </>
  )
}
