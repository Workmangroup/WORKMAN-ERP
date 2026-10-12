'use client'

import { useActionState, useRef, useState } from 'react'
import Link from 'next/link'
import { Check, Plus, X } from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { Button, buttonVariants } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { FormField } from '@/components/auth/form-field'
import { SubmitButton } from '@/components/auth/submit-button'
import { unitLabel } from '@/lib/bom/options'
import { useManualAction } from '@/lib/use-manual-action'
import { addRequestLineAction, createRequestAction, decideRequestAction } from '../actions'

export function NewRequestForm() {
  const [state, action] = useActionState(createRequestAction, null)
  const errs = state?.fieldErrors ?? {}
  const v = (k: string) => state?.values?.[k] ?? ''
  return (
    <form action={action} className="space-y-4" noValidate>
      {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}
      <section className="rounded-md border border-line bg-white shadow-card">
        <div className="border-b border-line px-5 py-3"><h2 className="text-base font-semibold">Demande d’achat</h2><p className="text-xs text-ink-soft">Le code DA-xxxx est généré. Ajoutez ensuite les composants à acheter, puis soumettez la demande à validation.</p></div>
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <FormField id="needed_date" label="Besoin au plus tard le" errors={errs.needed_date}><Input id="needed_date" name="needed_date" type="date" defaultValue={v('needed_date')} /></FormField>
          <div className="sm:col-span-2"><FormField id="reason" label="Motif de la demande" errors={errs.reason}><Textarea id="reason" name="reason" rows={3} maxLength={500} defaultValue={v('reason')} placeholder="Collection hiver, réassort, ordre de fabrication…" /></FormField></div>
        </div>
      </section>
      <div className="flex justify-end gap-2"><Link href="/purchases/requests" className={buttonVariants({ variant: 'secondary' })}>Annuler</Link><SubmitButton pendingText="Création…">Créer la demande</SubmitButton></div>
    </form>
  )
}

export function AddRequestLine({ requestId, materials, suppliers }: { requestId: string; materials: { id: string; code: string; name: string; unit: string }[]; suppliers: { id: string; name: string }[] }) {
  const [state, action] = useActionState(addRequestLineAction, null)
  const errs = state?.fieldErrors ?? {}
  const v = (k: string) => state?.values?.[k] ?? ''
  const [mat, setMat] = useState('')
  const unit = materials.find((m) => m.id === (v('material_id') || mat))?.unit
  return (
    <form action={action} className="space-y-3 border-t border-line bg-canvas/50 p-4" noValidate>
      <input type="hidden" name="request_id" value={requestId} />
      <p className="text-sm font-semibold">Ajouter un composant</p>
      {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}
      <div className="grid gap-3 md:grid-cols-[minmax(0,2fr)_7rem_minmax(0,1.3fr)_9rem_auto] md:items-end">
        <FormField id="rl-mat" label="Composant *" errors={errs.material_id}>
          <Select id="rl-mat" name="material_id" defaultValue={v('material_id')} onChange={(e) => setMat(e.target.value)}><option value="">— Choisir —</option>{materials.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.code})</option>)}</Select>
        </FormField>
        <FormField id="rl-qty" label={`Quantité *${unit ? ` (${unitLabel(unit)})` : ''}`} errors={errs.qty}><Input id="rl-qty" name="qty" inputMode="decimal" defaultValue={v('qty')} /></FormField>
        <FormField id="rl-sup" label="Fournisseur" errors={errs.supplier_id} hint="Vide = fournisseur du composant."><Select id="rl-sup" name="supplier_id" defaultValue={v('supplier_id')}><option value="">— Habituel —</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></FormField>
        <FormField id="rl-date" label="Besoin le" errors={errs.needed_date}><Input id="rl-date" name="needed_date" type="date" defaultValue={v('needed_date')} /></FormField>
        <SubmitButton pendingText="Ajout…"><Plus className="h-4 w-4" /> Ajouter</SubmitButton>
      </div>
    </form>
  )
}

/** Validation de la demande : approuver, ou rejeter avec un motif obligatoire. */
export function DecideDialog({ id, code }: { id: string; code: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="command" size="sm" onClick={() => setOpen(true)}><Check className="h-4 w-4" /> Valider / rejeter</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`Décision sur ${code}`}><DecideForm id={id} onDone={() => setOpen(false)} /></Dialog>
    </>
  )
}
function DecideForm({ id, onDone }: { id: string; onDone: () => void }) {
  const [state, action, pending] = useManualAction(decideRequestAction, null)
  const formRef = useRef<HTMLFormElement>(null)
  const decision = useRef<HTMLInputElement>(null)
  // la décision passe par un champ caché : ne dépend pas du bouton « submitter » du navigateur
  const decide = (value: 'approve' | 'reject') => { if (decision.current) decision.current.value = value; formRef.current?.requestSubmit() }
  return (
    <form ref={formRef} onSubmit={action} className="space-y-3">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="decision" ref={decision} defaultValue="approve" />
      {state && !state.ok && <Alert tone="error">{state.message}</Alert>}
      {state?.ok && <Alert tone="success">{state.message}</Alert>}
      <FormField id="comment" label="Commentaire" hint="Obligatoire pour rejeter."><Textarea id="comment" name="comment" rows={3} maxLength={500} autoFocus /></FormField>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onDone}>{state?.ok ? 'Fermer' : 'Annuler'}</Button>
        <Button type="button" variant="danger" disabled={pending} onClick={() => decide('reject')}><X className="h-4 w-4" /> Rejeter</Button>
        <Button type="button" disabled={pending} onClick={() => decide('approve')}><Check className="h-4 w-4" /> Valider</Button>
      </div>
    </form>
  )
}
