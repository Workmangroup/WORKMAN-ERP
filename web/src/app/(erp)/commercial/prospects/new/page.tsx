import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { ProspectForm } from '@/features/commercial/components/prospect-forms'
import { listSalesReps } from '@/features/commercial/services/commercial.service'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Nouveau prospect' }

export default async function NewProspectPage() {
  await requirePermission(P.PROSPECTS_WRITE)
  const owners = await listSalesReps()
  return (
    <>
      <PageHeader title="Nouveau prospect" actions={<Link href="/commercial/prospects" className={buttonVariants({ variant: 'command', size: 'sm' })}><ArrowLeft className="h-4 w-4" /> Prospects</Link>} />
      <div className="mx-auto max-w-3xl p-4 sm:p-6"><ProspectForm owners={owners} /></div>
    </>
  )
}
