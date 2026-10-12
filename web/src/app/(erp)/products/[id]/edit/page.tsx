import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { z } from 'zod'
import { buttonVariants } from '@/components/ui/button'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { ProductForm } from '@/features/products/components/product-form'
import { articleChoices, getProduct } from '@/features/products/services/products.service'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Modifier le produit' }

export default async function EditProductPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission(P.PRODUCTS_WRITE)
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const product = await getProduct(id)
  if (!product) notFound()
  if (product.status === 'archived') redirect(`/products/${id}`)
  const articles = await articleChoices(product.client_id, id)
  return (
    <>
      <PageHeader title={`Modifier ${product.code}`} description={product.name}
        actions={<Link href={`/products/${id}`} className={buttonVariants({ variant: 'command', size: 'sm' })}><ArrowLeft className="h-4 w-4" /> Fiche produit</Link>} />
      <div className="mx-auto max-w-3xl p-4 sm:p-6"><ProductForm product={product} articles={articles} /></div>
    </>
  )
}
