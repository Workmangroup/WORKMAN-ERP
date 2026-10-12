import type { Metadata } from 'next'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { CatalogManager } from '@/features/variants/components/catalog-manager'
import { catalogUsage, listColors, listSizes } from '@/features/variants/services/variants.service'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Catalogue tailles et couleurs' }

export default async function CatalogPage() {
  const ctx = await requirePermission(P.VARIANTS_READ)
  const [sizes, colors, usage] = await Promise.all([listSizes(), listColors(), catalogUsage()])
  return (
    <>
      <PageHeader title="Catalogue tailles et couleurs" description="Référentiel commun aux produits : codes utilisés dans les SKU (ex. PRD-0001-JAU-XL), teintes et ordre d’affichage." />
      <div className="p-4 sm:p-6">
        <CatalogManager sizes={sizes} colors={colors} usage={{ sizes: Object.fromEntries(usage.sizes), colors: Object.fromEntries(usage.colors) }} canWrite={ctx.permissions.includes(P.VARIANTS_WRITE)} />
      </div>
    </>
  )
}
