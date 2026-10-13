import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import { PageHeader } from '@/components/layout/page-header'
import { requireAnyPermission } from '@/features/auth/guards'
import { materialOptions } from '@/features/purchases/services/purchases.service'
import { CreateSourcingForm } from '@/features/sourcing/components/sourcing-forms'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Nouvelle consultation fournisseurs' }

export default async function NewSourcingPage() {
  await requireAnyPermission(P.PURCHASES_WRITE)
  const materials = await materialOptions()
  return (
    <>
      <PageHeader title="Nouvelle consultation" actions={<Link href="/purchases/sourcing" className={buttonVariants({ variant: 'command', size: 'sm' })}><ArrowLeft className="h-4 w-4" /> Consultations</Link>} />
      <div className="mx-auto max-w-3xl p-4 sm:p-6"><CreateSourcingForm materials={materials} /></div>
    </>
  )
}
