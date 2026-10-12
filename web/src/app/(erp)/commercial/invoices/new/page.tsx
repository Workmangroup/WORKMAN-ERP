import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { NewManualInvoiceForm } from '@/features/commercial/components/doc-forms'
import { clientOptions } from '@/features/commercial/services/commercial.service'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Nouvelle facture' }

export default async function NewInvoicePage() {
  await requirePermission(P.INVOICES_WRITE)
  const clients = await clientOptions()
  return (
    <>
      <PageHeader title="Nouvelle facture sans commande" actions={<Link href="/commercial/invoices" className={buttonVariants({ variant: 'command', size: 'sm' })}><ArrowLeft className="h-4 w-4" /> Factures</Link>} />
      <div className="mx-auto max-w-3xl p-4 sm:p-6"><NewManualInvoiceForm clients={clients} /></div>
    </>
  )
}
