import { redirect } from 'next/navigation'
import { AppShell } from '@/components/layout/app-shell'
import { AuthProvider } from '@/features/auth'
import { SessionWatcher } from '@/features/auth/components/session-watcher'
import { getAuthContext } from '@/features/auth/services/access.service'
import { ROUTES } from '@/lib/auth/constants'
import { securityPolicy } from '@/lib/env'

export const dynamic = 'force-dynamic'

/** Zone authentifiée : garde serveur (défense en profondeur) + contexte + surveillance d'inactivité. */
export default async function ErpLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getAuthContext()
  if (!ctx) redirect(ROUTES.login)
  if (ctx.profile.must_change_password) redirect(ROUTES.changePassword)

  return (
    <AuthProvider value={ctx}>
      <AppShell>{children}</AppShell>
      <SessionWatcher idleTimeoutMs={securityPolicy.idleTimeoutMs} />
    </AuthProvider>
  )
}
