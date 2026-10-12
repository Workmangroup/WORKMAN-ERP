import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { ArticleForm } from '@/features/articles/components/article-form'
import { listClientsLite } from '@/features/articles/services/articles.service'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Nouvel article' }

export default async function NewArticlePage({ searchParams }: { searchParams: Promise<{ client?: string }> }) {
  await requirePermission(P.ARTICLES_WRITE)
  const sp = await searchParams
  const clients = (await listClientsLite()).filter((c) => !c.archived_at)
  return (
    <>
      <PageHeader title="Nouvel article" description="Après création, complétez la fiche : couleurs, tailles, normes, packaging et lavage."
        actions={<Link href="/articles" className={buttonVariants({ variant: 'command', size: 'sm' })}><ArrowLeft className="h-4 w-4" /> Articles</Link>} />
      <div className="mx-auto max-w-3xl p-4 sm:p-6"><ArticleForm clients={clients} defaultClient={sp.client} /></div>
    </>
  )
}
