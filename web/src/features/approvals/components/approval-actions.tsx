'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { decideApprovalAction, escalateApprovalAction } from '../actions'

/** Actions sur une demande ouverte. Le motif est saisi ici et vérifié par la base (refus : 10 caractères minimum). */
export function ApprovalActions({ id, canDecide, canEscalate, overdue }: { id: string; canDecide: boolean; canEscalate: boolean; overdue: boolean }) {
  const [reason, setReason] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function run(fn: () => Promise<{ ok: boolean; message?: string; state?: string }>) {
    setBusy(true); setMessage(null)
    const res = await fn()
    setBusy(false)
    if (!res.ok) setMessage(res.message ?? 'Action refusée.')
    else setMessage(res.state ? `Nouvel état : ${res.state}` : 'Action enregistrée.')
  }

  return (
    <div className="space-y-2">
      <Input aria-label="Motif" placeholder="Motif (obligatoire pour un refus)" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} disabled={busy} />
      <div className="flex flex-wrap gap-2">
        {canDecide && (
          <>
            <Button type="button" size="sm" disabled={busy} onClick={() => run(() => decideApprovalAction(id, 'approve', reason))}>Approuver</Button>
            <Button type="button" size="sm" variant="danger" disabled={busy} onClick={() => run(() => decideApprovalAction(id, 'refuse', reason))}>Refuser</Button>
          </>
        )}
        {canEscalate && overdue && (
          <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => run(() => escalateApprovalAction(id, reason))}>Escalader</Button>
        )}
      </div>
      {message && <p role="status" className="text-sm text-ink-soft">{message}</p>}
    </div>
  )
}
