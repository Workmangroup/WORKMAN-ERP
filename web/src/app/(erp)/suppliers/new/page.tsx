import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { listPaymentTerms } from '@/features/clients/services/clients.service'
import { SupplierForm } from '@/features/suppliers/components/supplier-form'
import { listBuyers } from '@/features/suppliers/services/suppliers.service'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Nouveau fournisseur' }

export default async function NewSupplierPage() {
  await requirePermission(P.SUPPLIERS_WRITE)
  const [terms, buyers] = await Promise.all([listPaymentTerms(), listBuyers()])
  return (
    <>
      <PageHeader title="Nouveau fournisseur" description="Renseignez l’essentiel ; contacts et documents s’ajoutent ensuite sur la fiche."
        actions={<Link href="/suppliers" className={buttonVariants({ variant: 'command', size: 'sm' })}><ArrowLeft className="h-4 w-4" /> Fournisseurs</Link>} />
      <div className="mx-auto max-w-4xl p-4 sm:p-6"><SupplierForm terms={terms} buyers={buyers} /></div>
    </>
  )
}
