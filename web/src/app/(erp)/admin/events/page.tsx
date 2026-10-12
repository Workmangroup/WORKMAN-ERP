import type { Metadata } from 'next'
import { PageHeader } from '@/components/layout/page-header'
import { Card } from '@/components/ui/card'
import { requirePermission } from '@/features/auth/guards'
import { getAuthContext } from '@/features/auth/services/access.service'
import { EventFailures } from '@/features/notifications/components/event-failures'
import { eventFailures } from '@/features/notifications/services/notifications.service'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Événements en échec' }

export default async function EventsPage() {
  await requirePermission(P.EVENTS_READ)
  const canReplay = (await getAuthContext())?.permissions.includes(P.EVENTS_REPLAY) ?? false
  const rows = await eventFailures()
  return (
    <>
      <PageHeader title="Événements en échec" description="Chaque échec reste visible avec sa cause. Un événement arrêté après 5 tentatives doit être relancé par une personne habilitée." />
      <Card className="overflow-x-auto p-4">
        {rows.length === 0 ? <p className="text-sm text-ink-soft">Aucun échec.</p> : <EventFailures rows={rows} canReplay={canReplay} />}
      </Card>
    </>
  )
}
