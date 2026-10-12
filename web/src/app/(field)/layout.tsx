import { redirect } from 'next/navigation'
import { AuthProvider } from '@/features/auth'
import { SessionWatcher } from '@/features/auth/components/session-watcher'
import { getAuthContext } from '@/features/auth/services/access.service'
import { FieldHeader } from '@/features/field/components/field-ui'
import { ROUTES } from '@/lib/auth/constants'
import { securityPolicy } from '@/lib/env'

export const dynamic = 'force-dynamic'

/** Espace terrain (atelier, tablette) : mêmes garanties d'authentification, sans barre latérale. */
export default async function FieldLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getAuthContext()
  if (!ctx) redirect(ROUTES.login)
  if (ctx.profile.must_change_password) redirect(ROUTES.changePassword)

  // Thème appliqué avant le premier rendu : pas de flash clair en atelier sombre.
  const boot = `try{var t=localStorage.getItem('mb-field-theme');if(t==='dark'||t==='light')document.documentElement.setAttribute('data-theme',t)}catch(e){}`

  return (
    <AuthProvider value={ctx}>
      <script dangerouslySetInnerHTML={{ __html: boot }} />
      <div className="min-h-screen bg-canvas text-ink">
        <FieldHeader name={ctx.profile.full_name} />
        <main className="mx-auto max-w-4xl px-4 pb-16 pt-4 sm:px-6">{children}</main>
      </div>
      <SessionWatcher idleTimeoutMs={securityPolicy.idleTimeoutMs} />
    </AuthProvider>
  )
}
