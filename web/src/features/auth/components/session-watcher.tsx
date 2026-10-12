'use client'

import { useTransition } from 'react'
import { Clock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { idleSignOutAction, signOutAction } from '../actions'
import { useIdleTimeout } from '../hooks/use-idle-timeout'

/** Avertit puis déconnecte l'utilisateur inactif (timeout aligné sur le middleware). */
export function SessionWatcher({ idleTimeoutMs }: { idleTimeoutMs: number }) {
  const [pending, startTransition] = useTransition()
  const { warning, secondsLeft, stayActive } = useIdleTimeout({
    timeoutMs: idleTimeoutMs,
    warningMs: Math.min(60_000, Math.floor(idleTimeoutMs / 3)),
    onTimeout: () => startTransition(() => void idleSignOutAction()),
  })

  if (!warning) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="alertdialog" aria-modal="true" aria-labelledby="idle-title">
      <div className="w-full max-w-md rounded-md bg-white p-6 shadow-pop">
        <div className="flex items-center gap-2 text-brand-900">
          <Clock className="h-5 w-5" aria-hidden />
          <h2 id="idle-title" className="text-lg font-semibold">Session sur le point d’expirer</h2>
        </div>
        <p className="mt-3 text-sm text-ink-soft">
          Pour protéger vos données, vous allez être déconnecté dans{' '}
          <strong className="text-ink">{secondsLeft} s</strong> en raison d’une inactivité.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" disabled={pending} onClick={() => startTransition(() => void signOutAction())}>
            Se déconnecter
          </Button>
          <Button onClick={stayActive} disabled={pending} autoFocus>
            Rester connecté
          </Button>
        </div>
      </div>
    </div>
  )
}
