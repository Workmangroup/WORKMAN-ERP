import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { z } from 'zod'
import { buttonVariants } from '@/components/ui/button'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { directoryByIds, listPaymentTerms } from '@/features/clients/services/clients.service'
import { SupplierForm } from '@/features/suppliers/components/supplier-form'
import { getSupplier, listBuyers } from '@/features/suppliers/services/suppliers.service'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Modifier le fournisseur' }

export default async function EditSupplierPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission(P.SUPPLIERS_WRITE)
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const supplier = await getSupplier(id)
  if (!supplier) notFound()
  if (supplier.archived_at) redirect(`/suppliers/${id}`)

  const [terms, buyers] = await Promise.all([listPaymentTerms(), listBuyers()])
  if (supplier.buyer_id && !buyers.some((b) => b.id === supplier.buyer_id)) {
    const current = (await directoryByIds([supplier.buyer_id])).get(supplier.buyer_id)
    if (current) buyers.push(current)
  }
  return (
    <>
      <PageHeader title={`Modifier ${supplier.name}`} description={`Code ${supplier.code}`}
        actions={<Link href={`/suppliers/${id}`} className={buttonVariants({ variant: 'command', size: 'sm' })}><ArrowLeft className="h-4 w-4" /> Fiche fournisseur</Link>} />
      <div className="mx-auto max-w-4xl p-4 sm:p-6"><SupplierForm supplier={supplier} terms={terms} buyers={buyers} /></div>
    </>
  )
}
