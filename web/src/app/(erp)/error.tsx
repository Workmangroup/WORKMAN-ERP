'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'

/**
 * Erreur d'un écran : message compréhensible en français, sans détail technique (le détail reste dans les journaux serveur).
 * Permet de réessayer ou de revenir à l'accueil, sans perdre la navigation.
 */
export default function ErpError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Trace côté navigateur uniquement ; aucune donnée saisie n'est transmise.
    console.error('Erreur d’écran', error.digest ?? '')
  }, [error])
  return (
    <div role="alert" className="mx-auto max-w-xl space-y-4 p-6">
      <h1 className="text-xl font-semibold text-ink">Cet écran n’a pas pu s’afficher</h1>
      <p className="text-sm text-ink-soft">
        Une erreur temporaire est survenue. Vos données n’ont pas été modifiées. Réessayez ; si le problème persiste, revenez à l’accueil et signalez l’heure approximative à votre administrateur.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={() => reset()}>Réessayer</Button>
        <Link href="/dashboard" className="inline-flex h-9 items-center rounded-sm border border-line-strong px-3 text-sm text-ink hover:bg-canvas">Revenir à l’accueil</Link>
      </div>
    </div>
  )
}
