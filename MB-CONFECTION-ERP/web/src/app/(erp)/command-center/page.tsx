import type { Metadata } from 'next'
import { requireAuth } from '@/features/auth/guards'
import { CommandCenterBoard } from '@/features/command-center/components/command-center-board'
import { buildCommandCenter } from '@/features/command-center/services/command-center.service'
import { AGENDA_VIEWS, type AgendaView } from '@/lib/command-center/logic'
import { createClient } from '@/lib/supabase/server'

export const metadata: Metadata = { title: 'Command Center' }

/** Page d'accueil de tous les utilisateurs : le contenu s'adapte aux droits (et donc au rôle). */
export default async function CommandCenterPage({ searchParams }: { searchParams: Promise<{ vue?: string }> }) {
  const ctx = await requireAuth()
  const sp = await searchParams
  const view = (AGENDA_VIEWS.find((v) => v === sp.vue) ?? 'semaine') as AgendaView
  const supabase = await createClient()
  const data = await buildCommandCenter(supabase, ctx.permissions, ctx.user.id, view)
  const firstName = (ctx.profile.full_name ?? '').split(' ')[0] || ctx.user.email
  return (
    <div className="p-4 sm:p-6">
      <CommandCenterBoard data={data} perms={ctx.permissions} userName={firstName} view={view} />
    </div>
  )
}
