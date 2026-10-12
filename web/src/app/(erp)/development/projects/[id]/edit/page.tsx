import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { z } from 'zod'
import { buttonVariants } from '@/components/ui/button'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { ProjectForm } from '@/features/development/components/project-form'
import { getProject, ownerOptions, productChoices } from '@/features/development/services/development.service'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Modifier le projet' }

export default async function EditProjectPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission(P.DEVELOPMENT_WRITE)
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const project = await getProject(id)
  if (!project) notFound()
  if (project.status === 'cancelled' || project.status === 'completed') redirect(`/development/projects/${id}`)
  const [owners, products] = await Promise.all([ownerOptions(), productChoices(project.client_id)])
  return (
    <>
      <PageHeader title={`Modifier ${project.code}`} description={project.name}
        actions={<Link href={`/development/projects/${id}`} className={buttonVariants({ variant: 'command', size: 'sm' })}><ArrowLeft className="h-4 w-4" /> Fiche projet</Link>} />
      <div className="mx-auto max-w-3xl p-4 sm:p-6"><ProjectForm project={project} owners={owners} products={products} /></div>
    </>
  )
}
