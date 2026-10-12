import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { listClientsLite } from '@/features/articles/services/articles.service'
import { ProductForm } from '@/features/products/components/product-form'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Nouveau produit' }

export default async function NewProductPage({ searchParams }: { searchParams: Promise<{ client?: string }> }) {
  await requirePermission(P.PRODUCTS_WRITE)
  const sp = await searchParams
  const clients = (await listClientsLite()).filter((c) => !c.archived_at)
  return (
    <>
      <PageHeader title="Nouveau produit" description="Après création, complétez la fiche technique (version 1), les photos, les documents et les certifications."
        actions={<Link href="/products" className={buttonVariants({ variant: 'command', size: 'sm' })}><ArrowLeft className="h-4 w-4" /> Produits</Link>} />
      <div className="mx-auto max-w-3xl p-4 sm:p-6"><ProductForm clients={clients} defaultClient={sp.client} /></div>
    </>
  )
}
