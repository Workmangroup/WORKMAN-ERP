import type { Metadata } from 'next'
import { Alert } from '@/components/ui/alert'
import { ChangePasswordForm } from '@/features/auth/components/change-password-form'
import { requireAuth } from '@/features/auth/guards'

export const metadata: Metadata = { title: 'Changer le mot de passe' }

export default async function ChangePasswordPage() {
  const ctx = await requireAuth()
  return (
    <>
      <h1 className="text-xl font-semibold text-ink">Changer le mot de passe</h1>
      {ctx.profile.must_change_password && (
        <Alert tone="warning" className="my-4">
          Pour des raisons de sécurité, vous devez définir un nouveau mot de passe avant de continuer.
        </Alert>
      )}
      <div className="mt-4">
        <ChangePasswordForm />
      </div>
    </>
  )
}
