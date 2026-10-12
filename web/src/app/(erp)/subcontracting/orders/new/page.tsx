import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { OrderForm } from '@/features/subcontracting/components/order-form'
import { productOptions, subcontractorOptions } from '@/features/subcontracting/services/subcontracting.service'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Nouvelle commande de sous-traitance' }

export default async function NewOrderPage() {
  await requirePermission(P.SUBCONTRACT_WRITE)
  const [subs, products] = await Promise.all([subcontractorOptions(), productOptions()])
  return (
    <>
      <PageHeader title="Nouvelle commande de sous-traitance" description="Créez la commande en brouillon, puis envoyez-la au sous-traitant avec la date de retour."
        actions={<Link href="/subcontracting/orders" className={buttonVariants({ variant: 'command', size: 'sm' })}><ArrowLeft className="h-4 w-4" /> Commandes</Link>} />
      <div className="mx-auto max-w-3xl p-4 sm:p-6">
        {subs.length === 0 ? <p className="rounded-md border border-dashed border-line-strong bg-white p-8 text-center text-sm text-ink-soft">Aucun sous-traitant actif. <Link href="/subcontracting/subcontractors" className="text-brand-700 underline">Ajoutez-en un d’abord.</Link></p>
          : <OrderForm subs={subs} products={products} />}
      </div>
    </>
  )
}
