'use client'

import { startTransition, useActionState } from 'react'
import Link from 'next/link'
import { Plus } from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { FormField } from '@/components/auth/form-field'
import { SubmitButton } from '@/components/auth/submit-button'
import { addActivityAction, saveProspectAction, setStageAction } from '../actions'
import type { ProspectRow, Stage } from '../services/commercial.service'
import { SOURCES, STAGE_INFO } from '../status'

export function ProspectForm({ prospect, owners }: { prospect?: ProspectRow; owners: { id: string; full_name: string }[] }) {
  const [state, action] = useActionState(saveProspectAction, null)
  const errs = state?.fieldErrors ?? {}
  const v = (k: string, fb: string | number | null | undefined = '') => state?.values?.[k] ?? (fb === null || fb === undefined ? '' : String(fb))
  return (
    <form action={action} className="space-y-4" noValidate>
      {prospect && <input type="hidden" name="id" value={prospect.id} />}
      {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}
      <section className="rounded-md border border-line bg-white shadow-card">
        <div className="border-b border-line px-5 py-3"><h2 className="text-base font-semibold">Société et contact</h2><p className="text-xs text-ink-soft">Le pays est obligatoire pour convertir le prospect en fiche client.</p></div>
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <FormField id="company_name" label="Société *" errors={errs.company_name}><Input id="company_name" name="company_name" maxLength={120} defaultValue={v('company_name', prospect?.company_name)} autoFocus aria-invalid={Boolean(errs.company_name)} /></FormField>
          <FormField id="contact_name" label="Contact" errors={errs.contact_name}><Input id="contact_name" name="contact_name" maxLength={120} defaultValue={v('contact_name', prospect?.contact_name)} /></FormField>
          <FormField id="email" label="E-mail" errors={errs.email}><Input id="email" name="email" type="email" defaultValue={v('email', prospect?.email)} /></FormField>
          <FormField id="phone" label="Téléphone" errors={errs.phone}><Input id="phone" name="phone" maxLength={40} defaultValue={v('phone', prospect?.phone)} /></FormField>
          <FormField id="country" label="Pays (code ISO)" errors={errs.country}><Input id="country" name="country" maxLength={2} defaultValue={v('country', prospect?.country)} placeholder="FR" /></FormField>
          <FormField id="city" label="Ville" errors={errs.city}><Input id="city" name="city" maxLength={80} defaultValue={v('city', prospect?.city)} /></FormField>
        </div>
      </section>
      <section className="rounded-md border border-line bg-white shadow-card">
        <div className="border-b border-line px-5 py-3"><h2 className="text-base font-semibold">Opportunité</h2></div>
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <FormField id="source" label="Origine" errors={errs.source}><Select id="source" name="source" defaultValue={v('source', prospect?.source ?? 'other')}>{SOURCES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</Select></FormField>
          <FormField id="owner_id" label="Commercial en charge" errors={errs.owner_id}><Select id="owner_id" name="owner_id" defaultValue={v('owner_id', prospect?.owner_id)}><option value="">— Non affecté —</option>{owners.map((o) => <option key={o.id} value={o.id}>{o.full_name}</option>)}</Select></FormField>
          <FormField id="est_value" label="Valeur estimée (€ HT)" errors={errs.est_value}><Input id="est_value" name="est_value" inputMode="decimal" defaultValue={v('est_value', prospect?.est_value ? String(prospect.est_value).replace('.', ',') : '')} placeholder="50000" /></FormField>
          <FormField id="expected_close" label="Signature espérée le" errors={errs.expected_close}><Input id="expected_close" name="expected_close" type="date" defaultValue={v('expected_close', prospect?.expected_close)} /></FormField>
          <FormField id="next_action" label="Prochaine action" errors={errs.next_action}><Input id="next_action" name="next_action" maxLength={200} defaultValue={v('next_action', prospect?.next_action)} placeholder="Envoyer les échantillons" /></FormField>
          <FormField id="next_action_date" label="À faire le" errors={errs.next_action_date}><Input id="next_action_date" name="next_action_date" type="date" defaultValue={v('next_action_date', prospect?.next_action_date)} /></FormField>
          <div className="sm:col-span-2"><FormField id="notes" label="Notes" errors={errs.notes}><Textarea id="notes" name="notes" rows={3} maxLength={2000} defaultValue={v('notes', prospect?.notes)} /></FormField></div>
        </div>
      </section>
      <div className="flex justify-end gap-2"><Link href={prospect ? `/commercial/prospects/${prospect.id}` : '/commercial/prospects'} className={buttonVariants({ variant: 'secondary' })}>Annuler</Link><SubmitButton pendingText="Enregistrement…">{prospect ? 'Enregistrer' : 'Créer le prospect'}</SubmitButton></div>
    </form>
  )
}

/** Liste d'étapes : un changement soumet immédiatement ; « Perdu » demande le motif. */
export function StageSelect({ id, stage, compact }: { id: string; stage: Stage; compact?: boolean }) {
  const [state, action, pending] = useActionState(setStageAction, null)
  return (
    <span className="inline-block">
      <Select aria-label="Changer d’étape" defaultValue={stage} disabled={pending} className={compact ? 'h-7 text-xs' : ''}
        onChange={(e) => {
          const next = e.target.value
          let reason = ''
          if (next === 'lost') { reason = window.prompt('Motif de la perte (obligatoire) :') ?? ''; if (reason.trim().length < 3) { e.target.value = stage; return } }
          const fd = new FormData(); fd.set('id', id); fd.set('stage', next); fd.set('reason', reason)
          startTransition(() => action(fd))
        }}>
        {(['new', 'contacted', 'qualified', 'proposal', 'negotiation', 'lost'] as Stage[]).map((s) => <option key={s} value={s}>{STAGE_INFO[s].label}</option>)}
      </Select>
      {state && !state.ok && <span role="alert" className="mt-1 block max-w-48 text-xs text-danger-text">{state.message}</span>}
    </span>
  )
}

export function ActivityForm({ prospectId }: { prospectId: string }) {
  const [state, action] = useActionState(addActivityAction, null)
  const v = (k: string) => state?.values?.[k] ?? ''
  return (
    <form action={action} className="space-y-2 border-b border-line p-4" noValidate>
      <input type="hidden" name="prospect_id" value={prospectId} />
      {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}
      <div className="grid gap-3 sm:grid-cols-[9rem_minmax(0,1fr)_auto] sm:items-end">
        <Select name="kind" aria-label="Type d’activité" defaultValue={v('kind') || 'call'}><option value="call">Appel</option><option value="email">E-mail</option><option value="meeting">Rendez-vous</option><option value="note">Note</option></Select>
        <Input name="summary" aria-label="Résumé" maxLength={500} defaultValue={v('summary')} placeholder="Compte rendu de l’échange…" />
        <SubmitButton variant="secondary" pendingText="Ajout…"><Plus className="h-4 w-4" /> Ajouter</SubmitButton>
      </div>
    </form>
  )
}
