'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { markNotificationReadAction } from '../actions'

/** Liste de mes notifications : marquage lu une à une. */
export function NotificationList({ rows }: { rows: { id: string; title: string; body: string | null; created_at: string; read_at: string | null; link: string | null }[] }) {
  const [read, setRead] = useState<Record<string, boolean>>({})
  const [message, setMessage] = useState<string | null>(null)
  return (
    <ul className="divide-y divide-line">
      {rows.map((n) => {
        const isRead = !!n.read_at || read[n.id]
        return (
          <li key={n.id} className="flex flex-wrap items-start justify-between gap-3 p-4">
            <div>
              <p className={isRead ? 'text-ink-soft' : 'font-semibold text-ink'}>{n.title}</p>
              {n.body && <p className="text-sm text-ink-soft">{n.body}</p>}
              <p className="text-xs text-ink-faint">{new Date(n.created_at).toLocaleString('fr-FR')}</p>
            </div>
            {!isRead && (
              <Button type="button" size="sm" variant="secondary" onClick={async () => {
                const res = await markNotificationReadAction(n.id)
                if (res.ok) setRead((r) => ({ ...r, [n.id]: true })); else setMessage(res.message)
              }}>Marquer lu</Button>
            )}
          </li>
        )
      })}
      {message && <li role="status" className="p-4 text-sm text-danger">{message}</li>}
    </ul>
  )
}
