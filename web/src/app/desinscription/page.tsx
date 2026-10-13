import type { Metadata } from 'next'
import { confirmUnsubscribeAction } from '@/features/marketing/unsubscribe'

export const metadata: Metadata = { title: 'Désinscription' }

/** Page publique : confirmation explicite (pas de désinscription au simple chargement du lien). */
export default async function UnsubscribePage({ searchParams }: { searchParams: Promise<{ token?: string; done?: string }> }) {
  const sp = await searchParams
  const token = (sp.token ?? '').replace(/[^a-f0-9]/gi, '').slice(0, 64)
  return (
    <main className="mx-auto max-w-md space-y-4 p-6 text-center">
      <h1 className="text-lg font-semibold">Ne plus recevoir nos messages</h1>
      {sp.done ? (
        <p className="text-sm">Si ce lien était valide, votre désinscription est enregistrée. Vous ne recevrez plus de messages commerciaux de ce canal.</p>
      ) : (
        <form action={confirmUnsubscribeAction} className="space-y-4">
          <input type="hidden" name="token" value={token} />
          <p className="text-sm text-ink-soft">Confirmez pour ne plus recevoir de messages commerciaux de ce canal.</p>
          <button type="submit" className="rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white">Confirmer la désinscription</button>
        </form>
      )}
    </main>
  )
}
