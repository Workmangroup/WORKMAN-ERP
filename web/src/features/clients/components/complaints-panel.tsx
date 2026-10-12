'use client'

import { useState, useTransition } from 'react'
import { Plus } from 'lucide-react'
import { ActionDialog } from '@/components/common/action-dialog'
import { FormField } from '@/components/auth/form-field'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Alert } from '@/components/ui/alert'
import { formatDateTime } from '@/lib/utils'
import { openComplaintAction, updateComplaintAction } from '../complaint-actions'
import type { ComplaintLite } from '../services/client360.service'

const STATUS: Record<string, { label: string; tone: 'neutral' | 'brand' | 'success' | 'warning' | 'danger' }> = {
  open: { label: 'Ouverte', tone: 'danger' },
  in_progress: { label: 'En cours', tone: 'warning' },
  resolved: { label: 'Résolue', tone: 'brand' },
  closed: { label: 'Close', tone: 'success' },
}
const SEV: Record<string, string> = { minor: 'Mineure', major: 'Majeure', critical: 'Critique' }

/** Réclamations du client : ouverture, prise en charge, solution écrite, clôture. */
export function ComplaintsPanel({ clientId, complaints, orders, canWrite }: {
  clientId: string; complaints: ComplaintLite[]; orders: { id: string; code: string }[]; canWrite: boolean
}) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, start] = useTransition()
  const [resolution, setResolution] = useState<Record<string, string>>({})

  const move = (id: string, status: 'in_progress' | 'resolved' | 'closed') => start(async () => {
    const r = await updateComplaintAction(clientId, id, status, resolution[id] ?? null)
    setMsg({ ok: Boolean(r?.ok), text: r?.message ?? '' })
  })

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-soft">{complaints.length} réclamation(s) · {complaints.filter((c) => c.status !== 'closed').length} à traiter</p>
        {canWrite && (
          <ActionDialog trigger={<><Plus className="h-4 w-4" /> Nouvelle réclamation</>} triggerVariant="primary" title="Nouvelle réclamation" action={openComplaintAction} hidden={{ client_id: clientId }} submit="Ouvrir la réclamation" wide>
            {(st) => (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="sm:col-span-2"><FormField id="cp-s" label="Objet *" errors={st?.fieldErrors?.subject}><Input id="cp-s" name="subject" maxLength={160} /></FormField></div>
                <FormField id="cp-o" label="Commande concernée" errors={st?.fieldErrors?.order_id}>
                  <Select id="cp-o" name="order_id" defaultValue=""><option value="">— Aucune —</option>{orders.map((o) => <option key={o.id} value={o.id}>{o.code}</option>)}</Select>
                </FormField>
                <FormField id="cp-g" label="Gravité *" errors={st?.fieldErrors?.severity}>
                  <Select id="cp-g" name="severity" defaultValue="minor"><option value="minor">Mineure</option><option value="major">Majeure</option><option value="critical">Critique</option></Select>
                </FormField>
                <div className="sm:col-span-2"><FormField id="cp-d" label="Description" errors={st?.fieldErrors?.description}><Input id="cp-d" name="description" maxLength={2000} /></FormField></div>
              </div>
            )}
          </ActionDialog>
        )}
      </div>
      {msg && <Alert tone={msg.ok ? 'success' : 'error'}>{msg.text}</Alert>}
      {complaints.length === 0 ? (
        <p className="rounded-md border border-dashed border-line-strong bg-surface p-8 text-center text-sm text-ink-soft">Aucune réclamation pour ce client.</p>
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line bg-surface shadow-card">
          {complaints.map((c) => {
            const st = STATUS[c.status] ?? STATUS.open
            return (
              <li key={c.id} className="space-y-2 px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-ink-soft">{c.number}</span>
                  <span className="font-medium">{c.subject}</span>
                  <Badge tone={st.tone}>{st.label}</Badge>
                  <span className="text-xs text-ink-soft">Gravité : {SEV[c.severity]}</span>
                  <span className="ml-auto text-xs text-ink-faint">{formatDateTime(c.created_at)}</span>
                </div>
                {c.resolution && <p className="text-sm text-ink-soft">Solution : {c.resolution}</p>}
                {canWrite && c.status !== 'closed' && (
                  <div className="flex flex-wrap items-end gap-2">
                    {c.status === 'open' && <Button size="sm" variant="secondary" disabled={pending} onClick={() => move(c.id, 'in_progress')}>Prendre en charge</Button>}
                    {(c.status === 'open' || c.status === 'in_progress') && (
                      <>
                        <label className="flex min-w-[14rem] flex-1 flex-col gap-1 text-xs text-ink-soft">
                          Solution apportée (10 caractères minimum)
                          <Input value={resolution[c.id] ?? ''} onChange={(e) => setResolution({ ...resolution, [c.id]: e.target.value })} maxLength={2000} />
                        </label>
                        <Button size="sm" variant="primary" disabled={pending || (resolution[c.id] ?? '').trim().length < 10} onClick={() => move(c.id, 'resolved')}>Marquer résolue</Button>
                      </>
                    )}
                    {c.status === 'resolved' && <Button size="sm" variant="secondary" disabled={pending} onClick={() => move(c.id, 'closed')}>Clôturer</Button>}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
