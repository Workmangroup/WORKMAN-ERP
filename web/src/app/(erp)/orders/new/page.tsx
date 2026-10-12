import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { NewOrderForm } from '@/features/orders/components/order-forms'
import { clientOptions } from '@/features/orders/services/orders.service'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Nouvelle commande' }

export default async function NewOrderPage() {
  await requirePermission(P.ORDERS_WRITE)
  const clients = await clientOptions()
  return (
    <>
      <PageHeader title="Nouvelle commande client" actions={<Link href="/orders" className={buttonVariants({ variant: 'command', size: 'sm' })}><ArrowLeft className="h-4 w-4" /> Commandes</Link>} />
      <div className="mx-auto max-w-3xl p-4 sm:p-6"><NewOrderForm clients={clients} /></div>
    </>
  )
}
