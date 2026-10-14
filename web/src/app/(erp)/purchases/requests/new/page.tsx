import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import { PageHeader } from '@/components/layout/page-header'
import { requireAnyPermission } from '@/features/auth/guards'
import { NewRequestForm } from '@/features/purchases/components/request-forms'
import { costCenterOptions } from '@/features/purchases/services/purchases.service'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Nouvelle demande d’achat' }

export default async function NewRequestPage() {
  await requireAnyPermission(P.PURCHASES_REQUEST, P.PURCHASES_WRITE)
  const costCenters = await costCenterOptions()
  return (
    <>
      <PageHeader title="Nouvelle demande d’achat" actions={<Link href="/purchases/requests" className={buttonVariants({ variant: 'command', size: 'sm' })}><ArrowLeft className="h-4 w-4" /> Demandes</Link>} />
      <div className="mx-auto max-w-3xl p-4 sm:p-6"><NewRequestForm costCenters={costCenters} /></div>
    </>
  )
}
