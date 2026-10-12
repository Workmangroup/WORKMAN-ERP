import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { NewOrderForm } from '@/features/purchases/components/order-forms'
import { supplierOptions } from '@/features/purchases/services/purchases.service'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Nouvelle commande fournisseur' }

export default async function NewOrderPage() {
  await requirePermission(P.PURCHASES_WRITE)
  const suppliers = await supplierOptions()
  return (
    <>
      <PageHeader title="Nouvelle commande fournisseur" actions={<Link href="/purchases/orders" className={buttonVariants({ variant: 'command', size: 'sm' })}><ArrowLeft className="h-4 w-4" /> Commandes</Link>} />
      <div className="mx-auto max-w-3xl p-4 sm:p-6"><NewOrderForm suppliers={suppliers} /></div>
    </>
  )
}
