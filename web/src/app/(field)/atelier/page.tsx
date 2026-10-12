import type { Metadata } from 'next'
import { requireAuth } from '@/features/auth/guards'
import { TileLink } from '@/features/field/components/field-ui'
import { tilesFor } from '@/lib/field/logic'

export const metadata: Metadata = { title: 'Atelier' }

/** Accueil atelier : une tuile par tâche, selon les droits. Pas de menu, pas de sous-niveau inutile. */
export default async function AtelierHome() {
  const ctx = await requireAuth()
  const tiles = tilesFor(ctx.permissions)
  const first = ctx.profile.full_name.split(' ')[0]
  return (
    <div className="space-y-6 pt-2">
      <div>
        <p className="text-base text-ink-soft">Bonjour {first}</p>
        <h1 className="text-3xl font-bold tracking-tight">Que faites-vous maintenant ?</h1>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {tiles.map((t) => <TileLink key={t.id} tile={t} />)}
      </div>
    </div>
  )
}
