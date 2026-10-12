'use client'

import { ArrowDownLeft, ArrowUpRight, MessageSquarePlus, StickyNote } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { FormField } from '@/components/auth/form-field'
import { EXCHANGE_CHANNEL, EXCHANGE_DIRECTION, label } from '@/lib/development/options'
import { fmtDay } from '@/features/orders/status'
import { addExchangeAction } from '../actions'
import type { Exchange } from '../types'
import { ActionDialog } from '@/components/common/action-dialog'

const today = () => new Date().toISOString().slice(0, 10)
const ICON = { inbound: ArrowDownLeft, outbound: ArrowUpRight, internal: StickyNote } as const

/** Historique des échanges avec le client (e-mails, appels, réunions) : saisie seule, jamais modifiable. */
export function ExchangesPanel({ projectId, exchanges, canWrite, authors }: { projectId: string; exchanges: Exchange[]; canWrite: boolean; authors: Record<string, string> }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-soft">{exchanges.length} échange(s). L’historique est conservé tel quel (pas de modification ni de suppression) ; il reste saisissable après la clôture du projet.</p>
        {canWrite && (
          <ActionDialog trigger={<><MessageSquarePlus className="h-4 w-4" /> Enregistrer un échange</>} triggerVariant="primary" title="Enregistrer un échange" action={addExchangeAction} hidden={{ project_id: projectId }} submit="Enregistrer" wide>
            {(st) => (
              <div className="grid gap-3 sm:grid-cols-3">
                <FormField id="ex-dir" label="Sens *" errors={st?.fieldErrors?.direction}><Select id="ex-dir" name="direction" defaultValue={st?.values?.direction ?? 'inbound'}>{EXCHANGE_DIRECTION.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}</Select></FormField>
                <FormField id="ex-chan" label="Canal *" errors={st?.fieldErrors?.channel}><Select id="ex-chan" name="channel" defaultValue={st?.values?.channel ?? 'email'}>{EXCHANGE_CHANNEL.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}</Select></FormField>
                <FormField id="ex-date" label="Date" errors={st?.fieldErrors?.exchanged_on}><Input id="ex-date" name="exchanged_on" type="date" defaultValue={st?.values?.exchanged_on ?? today()} /></FormField>
                <div className="sm:col-span-2"><FormField id="ex-subject" label="Objet *" errors={st?.fieldErrors?.subject}><Input id="ex-subject" name="subject" maxLength={160} defaultValue={st?.values?.subject} placeholder="Retour du client sur le prototype v2" /></FormField></div>
                <FormField id="ex-contact" label="Contact" errors={st?.fieldErrors?.contact_name}><Input id="ex-contact" name="contact_name" maxLength={120} defaultValue={st?.values?.contact_name} placeholder="M. Dupont" /></FormField>
                <div className="sm:col-span-3"><FormField id="ex-body" label="Contenu / compte rendu" errors={st?.fieldErrors?.body}><Textarea id="ex-body" name="body" rows={5} maxLength={4000} defaultValue={st?.values?.body} /></FormField></div>
              </div>
            )}
          </ActionDialog>
        )}
      </div>
      {exchanges.length === 0 ? <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">Aucun échange enregistré.</p> : (
        <ol className="relative border-l-2 border-line pl-6">
          {exchanges.map((e) => {
            const Icon = ICON[e.direction as keyof typeof ICON] ?? StickyNote
            return (
              <li key={e.id} className="relative pb-5 last:pb-0">
                <span className="absolute -left-[34px] flex h-6 w-6 items-center justify-center rounded-full border-2 border-white bg-brand-100 text-brand-700 shadow-card"><Icon className="h-3 w-3" aria-hidden /></span>
                <div className="flex flex-wrap items-center gap-2"><p className="font-semibold">{e.subject}</p><Badge tone={e.direction === 'inbound' ? 'brand' : e.direction === 'outbound' ? 'success' : 'neutral'}>{label(EXCHANGE_DIRECTION, e.direction)}</Badge><Badge>{label(EXCHANGE_CHANNEL, e.channel)}</Badge></div>
                <p className="text-xs text-ink-soft">{fmtDay(e.exchanged_on)}{e.contact_name ? ` · ${e.contact_name}` : ''}{e.created_by && authors[e.created_by] ? ` · saisi par ${authors[e.created_by]}` : ''}</p>
                {e.body && <p className="mt-1 whitespace-pre-wrap rounded-sm bg-canvas p-3 text-sm">{e.body}</p>}
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
