import type { Metadata } from 'next'
import { LoginForm } from '@/features/auth/components/login-form'
import { safeNext } from '@/lib/auth/redirect'

export const metadata: Metadata = { title: 'Connexion' }

const NOTICES: Record<string, { tone: 'info' | 'success' | 'warning' | 'error'; text: string }> = {
  idle: { tone: 'warning', text: 'Votre session a expiré après une période d’inactivité. Reconnectez-vous.' },
  signedout: { tone: 'info', text: 'Vous avez été déconnecté.' },
  disabled: { tone: 'error', text: 'Ce compte est désactivé. Contactez votre administrateur.' },
  link_invalid: { tone: 'error', text: 'Le lien est invalide ou a expiré. Demandez un nouveau lien de réinitialisation.' },
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; reason?: string; reset?: string; error?: string }>
}) {
  const sp = await searchParams
  const next = sp.next ? safeNext(sp.next) : undefined
  const notice =
    sp.reset === 'success'
      ? { tone: 'success' as const, text: 'Mot de passe mis à jour. Connectez-vous avec votre nouveau mot de passe.' }
      : NOTICES[sp.error ?? sp.reason ?? '']

  return (
    <>
      <h1 className="text-2xl font-semibold text-ink">Se connecter</h1>
      <p className="mb-6 mt-1 text-sm text-ink-soft">Utilisez votre compte WORKMAN pour accéder à WORKMAN ERP 360.</p>
      <LoginForm next={next} notice={notice} />
      <p className="mt-8 text-xs text-ink-faint">
        Pas de compte ? Les comptes sont créés par votre administrateur.
      </p>
    </>
  )
}
