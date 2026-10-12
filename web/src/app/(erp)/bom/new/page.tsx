import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { BomForm } from '@/features/bom/components/bom-form'
import { articleOptions } from '@/features/bom/services/bom.service'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Nouvelle nomenclature' }

export default async function NewBomPage({ searchParams }: { searchParams: Promise<{ article?: string; kind?: string }> }) {
  await requirePermission(P.BOM_WRITE)
  const sp = await searchParams
  const articles = await articleOptions()
  return (
    <>
      <PageHeader title="Nouvelle nomenclature" description="Après création, ajoutez les composants et opérations, puis faites valider la version."
        actions={<Link href="/bom" className={buttonVariants({ variant: 'command', size: 'sm' })}><ArrowLeft className="h-4 w-4" /> Nomenclatures</Link>} />
      <div className="mx-auto max-w-3xl p-4 sm:p-6"><BomForm articles={articles} defaultArticle={sp.article} defaultKind={sp.kind} /></div>
    </>
  )
}
