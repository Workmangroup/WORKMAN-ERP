import { requirePermission } from '@/features/auth/guards'
import { DevNav } from '@/features/development/components/dev-nav'
import { getAlerts } from '@/features/development/services/development.service'
import { P } from '@/lib/rbac/permissions'

export default async function DevelopmentLayout({ children }: { children: React.ReactNode }) {
  await requirePermission(P.DEVELOPMENT_READ)
  const alerts = await getAlerts()
  return (
    <>
      <DevNav alerts={alerts.filter((a) => a.severity === 'high' || a.type.startsWith('validation')).length} />
      {children}
    </>
  )
}
