'use client'

import { useActionState, useState, useTransition } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import type { FormState } from '@/features/auth/types'
import {
  authorizeEmailAction, completeClientTaskAction, createClientTaskAction, recordVisitAction, withdrawEmailAction,
} from '../follow-up-actions'
import type { EmailRow, PieceOption, TaskRow, TimelineRow, VisitRow } from '../services/follow-up.service'

const KIND_LABEL: Record<string, string> = {
  visit: 'Visite', email_authorized: 'Courriel autorisé', email_withdrawn: 'Autorisation retirée', task: 'Tâche', complaint: 'Réclamation',
  order: 'Commande', quote: 'Devis', invoice: 'Facture', shipment: 'BL', bat: 'BAT',
}
const PURPOSE: Record<string, string> = { commercial: 'Commercial', billing: 'Facturation', technical: 'Technique' }

/** Lien vers la pièce originale (quand une route existe) ; sinon l'onglet de la fiche qui la contient. */
function originalHref(clientId: string, row: { kind: string; ref_id: string }): string | null {
  switch (row.kind) {
    case 'quote': return `/commercial/quotes/${row.ref_id}`
    case 'invoice': return `/commercial/invoices/${row.ref_id}`
    case 'order': return `/orders/${row.ref_id}`
    case 'shipment': return `/shipments/${row.ref_id}`
    case 'bat': return '/development/validations'
    case 'complaint': return `/clients/${clientId}?tab=claims`
    default: return null
  }
}

function Msg({ state }: { state: { ok: boolean; message?: string } | null }) {
  if (!state?.message) return null
  return <p role="status" className={state.ok ? 'text-sm text-ink-soft' : 'text-sm text-danger'}>{state.message}</p>
}

export function FollowUpPanel({
  clientId, canWrite, timeline, visits, emails, tasks, pieces,
}: {
  clientId: string; canWrite: boolean; timeline: TimelineRow[]; visits: VisitRow[]; emails: EmailRow[]; tasks: TaskRow[]; pieces: PieceOption[]
}) {
  const [visit, visitAct] = useActionState<FormState, FormData>(recordVisitAction, null)
  const [mail, mailAct] = useActionState<FormState, FormData>(authorizeEmailAction, null)
  const [task, taskAct] = useActionState<FormState, FormData>(createClientTaskAction, null)
  const [pending, start] = useTransition()
  const [note, setNote] = useState<FormState>(null)
  const run = (fn: () => Promise<FormState>) => start(async () => setNote(await fn()))

  return (
    <div className="space-y-6">
      {note && <p role="status" className={note.ok ? 'text-sm text-ink-soft' : 'text-sm text-danger'}>{note.message}</p>}

      <section className="space-y-2 rounded-md border border-line bg-white p-4 shadow-card">
        <h2 className="text-sm font-semibold">Visites et appels</h2>
        {visits.length === 0 ? <p className="text-sm text-ink-soft">Aucune visite enregistrée.</p> : (
          <ul className="space-y-1 text-sm">
            {visits.map((v) => <li key={v.id}><span className="tabular-nums">{v.visit_on}</span> · {KIND_LABEL[v.kind] ?? v.kind} · {v.summary}</li>)}
          </ul>
        )}
        {canWrite && (
          <form action={visitAct} className="grid gap-2 sm:grid-cols-4">
            <input type="hidden" name="client" value={clientId} />
            <Select name="kind" defaultValue="visit"><option value="visit">Visite</option><option value="call">Appel</option><option value="meeting">Rencontre</option></Select>
            <Input name="on" type="date" />
            <Input name="summary" required minLength={2} maxLength={1000} placeholder="Compte rendu" className="sm:col-span-2" />
            <div className="sm:col-span-4 flex items-center gap-3"><Button type="submit" size="sm" variant="secondary">Enregistrer la visite</Button><Msg state={visit} /></div>
          </form>
        )}
      </section>

      <section className="space-y-2 rounded-md border border-line bg-white p-4 shadow-card">
        <h2 className="text-sm font-semibold">Adresses courriel autorisées</h2>
        <p className="text-xs text-ink-soft">Seules les adresses autorisées pour une finalité peuvent recevoir ce type de message. Un retrait reste visible dans l’historique.</p>
        <ul className="space-y-1 text-sm">
          {emails.map((e) => (
            <li key={e.id} className="flex items-center justify-between gap-2">
              <span className={e.withdrawn_at ? 'text-ink-faint line-through' : ''}>{e.email} · {PURPOSE[e.purpose] ?? e.purpose} · {e.withdrawn_at ? `retirée le ${e.withdrawn_at.slice(0, 10)}` : `autorisée le ${e.authorized_at.slice(0, 10)}`}</span>
              {canWrite && !e.withdrawn_at && (
                <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => run(() => withdrawEmailAction(e.id, clientId))}>Retirer</Button>
              )}
            </li>
          ))}
        </ul>
        {canWrite && (
          <form action={mailAct} className="grid gap-2 sm:grid-cols-4">
            <input type="hidden" name="client" value={clientId} />
            <Input name="email" type="email" required placeholder="adresse@client.tn" className="sm:col-span-2" />
            <Select name="purpose" defaultValue="billing"><option value="commercial">Commercial</option><option value="billing">Facturation</option><option value="technical">Technique</option></Select>
            <Input name="proof" required minLength={5} maxLength={300} placeholder="Preuve (ex. courriel du client du …)" />
            <div className="sm:col-span-4 flex items-center gap-3"><Button type="submit" size="sm" variant="secondary">Autoriser</Button><Msg state={mail} /></div>
          </form>
        )}
      </section>

      <section className="space-y-2 rounded-md border border-line bg-white p-4 shadow-card">
        <h2 className="text-sm font-semibold">Tâches</h2>
        {tasks.length === 0 ? <p className="text-sm text-ink-soft">Aucune tâche.</p> : (
          <ul className="space-y-1 text-sm">
            {tasks.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-2">
                <span className={t.status === 'done' ? 'text-ink-faint line-through' : ''}>{t.title} · échéance {t.due_on}</span>
                {t.status === 'open' && canWrite && <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => run(() => completeClientTaskAction(t.id, clientId))}>Terminer</Button>}
              </li>
            ))}
          </ul>
        )}
        {canWrite && (
          <form action={taskAct} className="space-y-2">
            <input type="hidden" name="client" value={clientId} />
            <div className="grid gap-2 sm:grid-cols-3">
              <Input name="title" required minLength={3} maxLength={200} placeholder="Ex. Relancer sur la réclamation" className="sm:col-span-2" />
              <Input name="due" type="date" required />
            </div>
            {pieces.length > 0 && (
              <fieldset className="text-sm">
                <legend className="mb-1 text-xs text-ink-soft">Pièces originales liées (seules celles de ce client sont acceptées)</legend>
                <div className="grid gap-1 sm:grid-cols-2">
                  {pieces.map((p) => (
                    <label key={`${p.type}:${p.id}`} className="flex items-center gap-2"><input type="checkbox" name="link" value={`${p.type}:${p.id}`} /> {p.label}</label>
                  ))}
                </div>
              </fieldset>
            )}
            <div className="flex items-center gap-3"><Button type="submit" size="sm" variant="secondary">Ajouter la tâche</Button><Msg state={task} /></div>
          </form>
        )}
        <p className="text-xs text-ink-faint">Responsable : vous par défaut.</p>
      </section>

      <section className="space-y-2 rounded-md border border-line bg-white p-4 shadow-card">
        <h2 className="text-sm font-semibold">Chronologie</h2>
        {timeline.length === 0 ? <p className="text-sm text-ink-soft">Aucun évènement visible.</p> : (
          <ol className="space-y-1 text-sm">
            {timeline.map((r) => {
              const href = originalHref(clientId, r)
              return (
                <li key={`${r.kind}-${r.ref_id}-${r.at}`} className="flex flex-wrap gap-2">
                  <span className="tabular-nums text-ink-soft">{new Date(r.at).toLocaleDateString('fr-FR')}</span>
                  <span className="text-xs text-ink-faint">{KIND_LABEL[r.kind] ?? r.kind}</span>
                  {href ? <a href={href} className="font-medium text-brand-700 hover:underline">{r.label}</a> : <span>{r.label}</span>}
                  {r.status && <span className="text-xs text-ink-faint">({r.status})</span>}
                </li>
              )
            })}
          </ol>
        )}
      </section>
    </div>
  )
}
