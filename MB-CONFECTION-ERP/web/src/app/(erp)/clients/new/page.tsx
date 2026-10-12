import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { ClientForm } from '@/features/clients/components/client-form'
import { listPaymentTerms, listSalesReps } from '@/features/clients/services/clients.service'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Nouveau client' }

export default async function NewClientPage() {
  await requirePermission(P.CLIENTS_WRITE)
  const [terms, reps] = await Promise.all([listPaymentTerms(), listSalesReps()])
  return (
    <>
      <PageHeader
        title="Nouveau client"
        description="Renseignez l’essentiel ; contacts, adresses et documents s’ajoutent ensuite sur la fiche."
        actions={<Link href="/clients" className={buttonVariants({ variant: 'command', size: 'sm' })}><ArrowLeft className="h-4 w-4" /> Clients</Link>}
      />
      <div className="mx-auto max-w-4xl p-4 sm:p-6">
        <ClientForm terms={terms} reps={reps} canSetCode />
      </div>
    </>
  )
}
