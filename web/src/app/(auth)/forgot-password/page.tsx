import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { ForgotPasswordForm } from '@/features/auth/components/forgot-password-form'
import { ROUTES } from '@/lib/auth/constants'

export const metadata: Metadata = { title: 'Mot de passe oublié' }

export default function ForgotPasswordPage() {
  return (
    <>
      <Link href={ROUTES.login} className="mb-6 inline-flex items-center gap-1 text-sm text-brand-600 hover:underline">
        <ArrowLeft className="h-4 w-4" /> Retour à la connexion
      </Link>
      <h1 className="text-2xl font-semibold text-ink">Mot de passe oublié</h1>
      <p className="mb-6 mt-1 text-sm text-ink-soft">
        Saisissez votre adresse e-mail : nous vous enverrons un lien pour choisir un nouveau mot de passe.
      </p>
      <ForgotPasswordForm />
    </>
  )
}
