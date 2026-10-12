import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { z } from 'zod'
import { buttonVariants } from '@/components/ui/button'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { BomForm } from '@/features/bom/components/bom-form'
import { articleOptions, getBom } from '@/features/bom/services/bom.service'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Modifier la nomenclature' }

export default async function EditBomPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission(P.BOM_WRITE)
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const bom = await getBom(id)
  if (!bom) notFound()
  if (bom.archived_at) redirect(`/bom/${id}`)
  const articles = await articleOptions(bom.article_id)
  return (
    <>
      <PageHeader title={`Modifier ${bom.code}`} description={bom.name}
        actions={<Link href={`/bom/${id}`} className={buttonVariants({ variant: 'command', size: 'sm' })}><ArrowLeft className="h-4 w-4" /> Nomenclature</Link>} />
      <div className="mx-auto max-w-3xl p-4 sm:p-6"><BomForm bom={bom} articles={articles} /></div>
    </>
  )
}
