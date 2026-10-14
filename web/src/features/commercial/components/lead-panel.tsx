'use client'

import { useActionState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import type { DirectoryUser } from '@/features/clients/types'
import {
  assignLeadAction, completeLeadTaskAction, convertLeadAction, createLeadTaskAction, qualifyLeadAction, recordConsentAction,
} from '../actions'

export interface LeadDuplicate { cand_kind: 'client' | 'prospect'; cand_id: string; cand_label: string; cand_reason: string }
export interface LeadTask { id: string; title: string; due_on: string; status: string }

const PURPOSES = [
  { value: 'commercial_prospection', label: 'Prospection commerciale' },
  { value: 'phone_contact', label: 'Contact téléphonique' },
  { value: 'email_marketing', label: 'Courriel marketing' },
] as const

function Msg({ state }: { state: { ok: boolean; message?: string } | null }) {
  if (!state?.message) return null
  return <p role="status" className={state.ok ? 'text-sm text-ink-soft' : 'text-sm text-danger'}>{state.message}</p>
}

/** Panneau de qualification d'un prospect : responsable, qualification, consentements, tâches, doublons, conversion. */
export function LeadPanel({
  id, canWrite, canConvert, closed, owner, owners, duplicates, tasks, consents,
}: {
  id: string; canWrite: boolean; canConvert: boolean; closed: boolean; owner: string | null; owners: DirectoryUser[];
  duplicates: LeadDuplicate[]; tasks: LeadTask[]; consents: Record<string, string>
}) {
  const [assign, assignAct] = useActionState(assignLeadAction, null)
  const [qual, qualAct] = useActionState(qualifyLeadAction, null)
  const [consent, consentAct] = useActionState(recordConsentAction, null)
  const [task, taskAct] = useActionState(createLeadTaskAction, null)
  const [conv, convAct] = useActionState(convertLeadAction, null)
  const [, completeAct] = useActionState(completeLeadTaskAction, null)
  const editable = canWrite && !closed
  return (
    <section className="space-y-5 rounded-md border border-line bg-white p-4 shadow-card">
      <h2 className="text-sm font-semibold">Qualification</h2>

      {editable && (
        <form action={assignAct} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="id" value={id} />
          <label className="space-y-1 text-sm"><span className="font-medium">Responsable</span>
            <Select name="owner" defaultValue={owner ?? ''}>
              <option value="" disabled>Choisir</option>
              {owners.map((u) => <option key={u.id} value={u.id}>{u.full_name || u.email}</option>)}
            </Select>
          </label>
          <Button type="submit" size="sm" variant="secondary">Affecter</Button>
          <Msg state={assign} />
        </form>
      )}

      {editable && (
        <form action={qualAct} className="space-y-2">
          <input type="hidden" name="id" value={id} />
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" name="budget" /> Budget confirmé</label>
            <label className="flex items-center gap-2"><input type="checkbox" name="need" /> Besoin confirmé</label>
            <label className="flex items-center gap-2"><input type="checkbox" name="decision_maker" /> Décideur identifié</label>
          </div>
          <Input name="timeline" maxLength={120} placeholder="Échéance (ex. T1 2027)" />
          <Button type="submit" size="sm" variant="secondary">Enregistrer la qualification</Button>
          <Msg state={qual} />
        </form>
      )}

      <div className="space-y-2">
        <h3 className="text-sm font-semibold">Consentements</h3>
        <ul className="text-sm">
          {PURPOSES.map((p) => <li key={p.value}>{p.label} : {consents[p.value] === 'granted' ? 'accordé' : consents[p.value] === 'withdrawn' ? 'retiré' : 'non renseigné'}</li>)}
        </ul>
        {editable && (
          <form action={consentAct} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="id" value={id} />
            <Select name="purpose" defaultValue="commercial_prospection">{PURPOSES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</Select>
            <Select name="status" defaultValue="granted"><option value="granted">Accordé</option><option value="withdrawn">Retiré</option></Select>
            <Input name="proof" required minLength={5} maxLength={300} placeholder="Preuve (ex. formulaire salon, courriel du …)" className="min-w-64" />
            <Button type="submit" size="sm" variant="secondary">Enregistrer</Button>
            <Msg state={consent} />
          </form>
        )}
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold">Tâches</h3>
        {tasks.length === 0 ? <p className="text-sm text-ink-soft">Aucune tâche.</p> : (
          <ul className="space-y-1 text-sm">
            {tasks.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-2">
                <span className={t.status === 'done' ? 'text-ink-faint line-through' : ''}>{t.title} · échéance {t.due_on}</span>
                {t.status === 'open' && editable && (
                  <form action={completeAct}><input type="hidden" name="task" value={t.id} /><Button type="submit" size="sm" variant="ghost">Terminer</Button></form>
                )}
              </li>
            ))}
          </ul>
        )}
        {editable && (
          <form action={taskAct} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="id" value={id} />
            <Input name="title" required minLength={3} maxLength={200} placeholder="Ex. Rappeler après devis" className="min-w-56" />
            <Input name="due" type="date" required />
            <Button type="submit" size="sm" variant="secondary">Ajouter la tâche</Button>
            <Msg state={task} />
          </form>
        )}
      </div>

      {canConvert && editable && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">Conversion</h3>
          {duplicates.length > 0 ? (
            <>
              <p className="text-sm text-ink-soft">Ces fiches existent déjà. Rattachez le prospect à l’une d’elles, ou convertissez en nouvelle fiche si aucune ne correspond.</p>
              <ul className="space-y-1 text-sm">
                {duplicates.map((d) => (
                  <li key={`${d.cand_kind}-${d.cand_id}`} className="flex items-center justify-between gap-2">
                    <span>{d.cand_kind === 'client' ? 'Client' : 'Prospect'} « {d.cand_label} » ({d.cand_reason})</span>
                    {d.cand_kind === 'client' && (
                      <form action={convAct}><input type="hidden" name="id" value={id} /><input type="hidden" name="client" value={d.cand_id} /><Button type="submit" size="sm" variant="secondary">Rattacher à ce client</Button></form>
                    )}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <form action={convAct}><input type="hidden" name="id" value={id} /><Button type="submit" size="sm" variant="secondary">Créer la fiche client</Button></form>
          )}
          <Msg state={conv} />
        </div>
      )}
    </section>
  )
}
