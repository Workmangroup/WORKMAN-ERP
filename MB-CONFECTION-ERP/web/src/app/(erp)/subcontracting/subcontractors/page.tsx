import type { Metadata } from 'next'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { SubcontractorManager } from '@/features/subcontracting/components/subcontractor-manager'
import { listSubcontractors } from '@/features/subcontracting/services/subcontracting.service'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Sous-traitants' }

export default async function SubcontractorsPage() {
  const ctx = await requirePermission(P.SUBCONTRACT_READ)
  const subs = await listSubcontractors()
  return (
    <>
      <PageHeader title="Sous-traitants" description="Ateliers de broderie, sérigraphie, impression, lavage et finition : prestations proposées et délai habituel." />
      <div className="p-4 sm:p-6">
        <SubcontractorManager subs={subs} canWrite={ctx.permissions.includes(P.SUBCONTRACT_WRITE)} />
      </div>
    </>
  )
}
