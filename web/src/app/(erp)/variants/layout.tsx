import { requirePermission } from '@/features/auth/guards'
import { VariantsNav } from '@/features/variants/components/variants-nav'
import { P } from '@/lib/rbac/permissions'

export default async function VariantsLayout({ children }: { children: React.ReactNode }) {
  await requirePermission(P.VARIANTS_READ)
  return (<><VariantsNav />{children}</>)
}
