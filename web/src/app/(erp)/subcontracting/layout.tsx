import { requirePermission } from '@/features/auth/guards'
import { SubNav } from '@/features/subcontracting/components/sub-nav'
import { P } from '@/lib/rbac/permissions'

export default async function SubcontractingLayout({ children }: { children: React.ReactNode }) {
  await requirePermission(P.SUBCONTRACT_READ)
  return (<><SubNav />{children}</>)
}
