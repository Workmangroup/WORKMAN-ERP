/** Chargement d'un écran de la zone authentifiée : squelette accessible (annoncé aux lecteurs d'écran). */
export default function Loading() {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className="space-y-4 p-4 sm:p-6">
      <span className="sr-only">Chargement en cours…</span>
      <div className="h-7 w-64 max-w-full animate-pulse rounded-sm bg-line" aria-hidden />
      <div className="h-4 w-96 max-w-full animate-pulse rounded-sm bg-line" aria-hidden />
      <div className="space-y-2 pt-4" aria-hidden>
        {[0, 1, 2, 3, 4].map((i) => <div key={i} className="h-10 animate-pulse rounded-sm bg-canvas" />)}
      </div>
    </div>
  )
}
