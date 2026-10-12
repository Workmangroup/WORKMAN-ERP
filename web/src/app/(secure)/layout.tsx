import { LogOut } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { requireAuth } from '@/features/auth/guards'
import { signOutAction } from '@/features/auth/actions'

export const dynamic = 'force-dynamic'

/** Pages réservées aux utilisateurs connectés mais hors du shell ERP (ex : changement forcé). */
export default async function SecureLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireAuth()
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-md rounded-md border border-line bg-white p-8 shadow-card">{children}</div>
      <form action={signOutAction} className="mt-4 text-sm text-ink-soft">
        Connecté en tant que {ctx.user.email} ·{' '}
        <Button variant="ghost" size="sm" type="submit" className="inline-flex px-1">
          <LogOut className="h-3.5 w-3.5" /> Se déconnecter
        </Button>
      </form>
    </div>
  )
}
