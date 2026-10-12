import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { listClientsLite } from '@/features/articles/services/articles.service'
import { ProjectForm } from '@/features/development/components/project-form'
import { ownerOptions } from '@/features/development/services/development.service'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Nouveau projet de développement' }

export default async function NewProjectPage({ searchParams }: { searchParams: Promise<{ client?: string }> }) {
  await requirePermission(P.DEVELOPMENT_WRITE)
  const sp = await searchParams
  const [clients, owners] = await Promise.all([listClientsLite().then((c) => c.filter((x) => !x.archived_at)), ownerOptions()])
  return (
    <>
      <PageHeader title="Nouveau projet de développement" description="Enregistrez la demande du client : le projet démarre à l’étape « Demande client »."
        actions={<Link href="/development/projects" className={buttonVariants({ variant: 'command', size: 'sm' })}><ArrowLeft className="h-4 w-4" /> Projets</Link>} />
      <div className="mx-auto max-w-3xl p-4 sm:p-6"><ProjectForm clients={clients} defaultClient={sp.client} owners={owners} /></div>
    </>
  )
}
