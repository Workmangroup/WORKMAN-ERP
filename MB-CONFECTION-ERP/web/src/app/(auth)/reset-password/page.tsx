import type { Metadata } from 'next'
import Link from 'next/link'
import { cookies } from 'next/headers'
import { Alert } from '@/components/ui/alert'
import { buttonVariants } from '@/components/ui/button'
import { ResetPasswordForm } from '@/features/auth/components/reset-password-form'
import { COOKIE_RECOVERY, ROUTES } from '@/lib/auth/constants'
import { createClient } from '@/lib/supabase/server'

export const metadata: Metadata = { title: 'Nouveau mot de passe' }

export default async function ResetPasswordPage() {
  const hasRecoveryCookie = (await cookies()).get(COOKIE_RECOVERY)?.value === '1'
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const valid = hasRecoveryCookie && Boolean(user)

  if (!valid) {
    return (
      <>
        <h1 className="text-2xl font-semibold text-ink">Lien expiré</h1>
        <Alert tone="error" className="my-4">
          Ce lien de réinitialisation est invalide ou a expiré.
        </Alert>
        <Link href={ROUTES.forgotPassword} className={buttonVariants({ size: 'lg', className: 'w-full' })}>
          Demander un nouveau lien
        </Link>
      </>
    )
  }

  return (
    <>
      <h1 className="text-2xl font-semibold text-ink">Choisir un nouveau mot de passe</h1>
      <p className="mb-6 mt-1 text-sm text-ink-soft">
        Compte : <strong className="text-ink">{user?.email}</strong>
      </p>
      <ResetPasswordForm />
    </>
  )
}
