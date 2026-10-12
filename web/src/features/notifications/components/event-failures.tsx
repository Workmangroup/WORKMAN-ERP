'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { dispatchEventsAction, replayEventAction } from '../actions'

type Row = { event_id: string; event_type: string; consumer: string; status: string; attempts: number; last_error: string | null; occurred_at: string }

/** Échecs visibles avec cause et tentatives. Relance par replay (droit events.replay) ; traitement de la file. */
export function EventFailures({ rows, canReplay }: { rows: Row[]; canReplay: boolean }) {
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  async function run(fn: () => Promise<{ ok: boolean; message?: string; result?: string }>) {
    setBusy(true); setMessage(null)
    const res = await fn()
    setBusy(false)
    setMessage(res.ok ? `Résultat : ${res.result ?? 'ok'}` : (res.message ?? 'Échec.'))
  }
  return (
    <div className="space-y-3">
      {canReplay && (
        <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => run(dispatchEventsAction)}>Traiter la file</Button>
      )}
      {message && <p role="status" className="text-sm text-ink-soft">{message}</p>}
      <table className="w-full text-left text-sm">
        <thead className="text-ink-soft"><tr><th className="p-2">Survenu le</th><th className="p-2">Événement</th><th className="p-2">Consommateur</th><th className="p-2">État</th><th className="p-2">Tentatives</th><th className="p-2">Cause</th><th className="p-2">Action</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.event_id}-${r.consumer}`} className="border-t border-line align-top">
              <td className="p-2">{new Date(r.occurred_at).toLocaleString('fr-FR')}</td>
              <td className="p-2 font-mono text-xs">{r.event_type}</td>
              <td className="p-2">{r.consumer}</td>
              <td className="p-2">{r.status === 'dead' ? 'Arrêté (replay requis)' : 'En échec (réessai auto)'}</td>
              <td className="p-2">{r.attempts}</td>
              <td className="p-2 text-xs text-danger">{r.last_error}</td>
              <td className="p-2">
                {canReplay && (
                  <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => run(() => replayEventAction(r.event_id, r.consumer))}>Relancer</Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
