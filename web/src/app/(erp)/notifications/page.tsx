import type { Metadata } from 'next'
import { PageHeader } from '@/components/layout/page-header'
import { Card } from '@/components/ui/card'
import { requireAuth } from '@/features/auth/guards'
import { NotificationList } from '@/features/notifications/components/notification-list'
import { myNotifications } from '@/features/notifications/services/notifications.service'

export const metadata: Metadata = { title: 'Notifications' }

export default async function NotificationsPage() {
  await requireAuth()
  const rows = await myNotifications()
  return (
    <>
      <PageHeader title="Notifications" description="Vos notifications internes. Chacune n’apparaît qu’une fois, même si l’événement est relancé." />
      <Card>
        {rows.length === 0 ? <p className="p-4 text-sm text-ink-soft">Aucune notification.</p> : <NotificationList rows={rows} />}
      </Card>
    </>
  )
}
