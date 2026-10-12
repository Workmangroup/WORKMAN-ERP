'use client'

import { useRef } from 'react'
import { Check, X } from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { FormField } from '@/components/auth/form-field'
import { useManualAction } from '@/lib/use-manual-action'
import type { FormState } from '@/features/auth/types'
import {
  delegationGrantAction, derogationApproveAction, derogationControlAction, derogationRequestAction,
  delegationRevokeAction, paymentOrderDecideAction, paymentOrderPrepareAction,
} from '../actions'
import type { Person, SupplierOption } from '../services/governance.service'

const PERMISSION_LABELS: Record<string, string> = {
  'payments.approve': 'Approuver un ordre de paiement',
  'derogations.approve': 'Approuver une dérogation (1er niveau)',
  'derogations.control': 'Contrôler une dérogation (2nd niveau)',
  'quality.approve': 'Libérer un lot qualité',
}
const KIND_LABELS: Record<string, string> = {
  credit_limit: 'Dépassement de plafond de crédit',
  discount: 'Remise exceptionnelle',
  price: 'Prix dérogatoire',
  shipping_certification: 'Expédition sans certification à jour',
  other: 'Autre',
}

function Messages({ state }: { state: FormState }) {
  if (!state) return null
  return state.ok ? <Alert tone="success">{state.message}</Alert> : <Alert tone="error">{state.message}</Alert>
}

export function DelegationForm({ people }: { people: Person[] }) {
  const [state, onSubmit, pending] = useManualAction(delegationGrantAction, null)
  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2">
      <FormField id="dg-delegate" label="Délégué">
        <Select id="dg-delegate" name="delegate" required defaultValue="">
          <option value="" disabled>Choisir une personne</option>
          {people.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
        </Select>
      </FormField>
      <FormField id="dg-permission" label="Pouvoir délégué" hint="Seuls les pouvoirs d’approbation peuvent être délégués. Jamais paie, marge ou prix.">
        <Select id="dg-permission" name="permission" required defaultValue="payments.approve">
          {Object.entries(PERMISSION_LABELS).map(([code, label]) => <option key={code} value={code}>{label}</option>)}
        </Select>
      </FormField>
      <FormField id="dg-object" label="Objet précis (identifiant, facultatif)" hint="Vide = tous les objets du type, dans la limite de montant.">
        <Input id="dg-object" name="object_id" placeholder="uuid de l’ordre ou du contrôle" />
      </FormField>
      <FormField id="dg-amount" label="Montant maximum (facultatif)" hint="Obligatoire si aucun objet précis. Non applicable aux dérogations.">
        <Input id="dg-amount" name="amount_limit" inputMode="decimal" placeholder="ex. 500" />
      </FormField>
      <FormField id="dg-ends" label="Fin de la délégation" hint="90 jours au plus.">
        <Input id="dg-ends" name="ends_on" type="date" required />
      </FormField>
      <FormField id="dg-reason" label="Motif">
        <Textarea id="dg-reason" name="reason" rows={2} maxLength={300} required />
      </FormField>
      <div className="sm:col-span-2 space-y-2">
        <Messages state={state} />
        <div className="flex justify-end"><Button type="submit" disabled={pending}>Accorder la délégation</Button></div>
      </div>
    </form>
  )
}

export function RevokeForm({ id }: { id: string }) {
  const [state, onSubmit, pending] = useManualAction(delegationRevokeAction, null)
  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="id" value={id} />
      <FormField id={`rv-${id}`} label="Motif de révocation">
        <Input id={`rv-${id}`} name="reason" maxLength={300} required />
      </FormField>
      <Button type="submit" variant="danger" size="sm" disabled={pending}><X className="h-4 w-4" /> Révoquer</Button>
      <div className="w-full"><Messages state={state} /></div>
    </form>
  )
}

export function PaymentOrderForm({ suppliers }: { suppliers: SupplierOption[] }) {
  const [state, onSubmit, pending] = useManualAction(paymentOrderPrepareAction, null)
  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-3">
      <FormField id="po-supplier" label="Fournisseur">
        <Select id="po-supplier" name="supplier" required defaultValue="">
          <option value="" disabled>Choisir</option>
          {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
      </FormField>
      <FormField id="po-amount" label="Montant">
        <Input id="po-amount" name="amount" inputMode="decimal" required />
      </FormField>
      <FormField id="po-reason" label="Motif">
        <Input id="po-reason" name="reason" minLength={5} maxLength={300} required />
      </FormField>
      <div className="sm:col-span-3 space-y-2">
        <Messages state={state} />
        <div className="flex justify-end"><Button type="submit" disabled={pending}>Préparer l’ordre</Button></div>
      </div>
    </form>
  )
}

export function DerogationRequestForm() {
  const [state, onSubmit, pending] = useManualAction(derogationRequestAction, null)
  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2">
      <FormField id="dr-kind" label="Nature">
        <Select id="dr-kind" name="kind" required defaultValue="discount">
          {Object.entries(KIND_LABELS).map(([code, label]) => <option key={code} value={code}>{label}</option>)}
        </Select>
      </FormField>
      <FormField id="dr-object-type" label="Objet concerné" hint="Ex. commande, client, lot.">
        <Input id="dr-object-type" name="object_type" maxLength={40} required />
      </FormField>
      <FormField id="dr-object" label="Identifiant de l’objet (facultatif)">
        <Input id="dr-object" name="object_id" placeholder="uuid" />
      </FormField>
      <FormField id="dr-until" label="Valable jusqu’au" hint="90 jours au plus.">
        <Input id="dr-until" name="valid_until" type="date" required />
      </FormField>
      <FormField id="dr-motive" label="Motif détaillé" hint="10 caractères minimum.">
        <Textarea id="dr-motive" name="motive" rows={3} minLength={10} maxLength={500} required />
      </FormField>
      <div className="sm:col-span-2 space-y-2">
        <Messages state={state} />
        <div className="flex justify-end"><Button type="submit" disabled={pending}>Demander la dérogation</Button></div>
      </div>
    </form>
  )
}

/** Décision à deux issues (valider / rejeter, commentaire requis pour un refus). Sert aux paiements et aux dérogations. */
type DecisionAction = (prev: FormState, fd: FormData) => Promise<FormState>
export function DecisionForm({ id, action, approveLabel }: { id: string; action: 'payment' | 'derogation_approve' | 'derogation_control'; approveLabel: string }) {
  const actions: Record<string, DecisionAction> = {
    payment: paymentOrderDecideAction,
    derogation_approve: derogationApproveAction,
    derogation_control: derogationControlAction,
  }
  const [state, onSubmit, pending] = useManualAction(actions[action], null)
  const formRef = useRef<HTMLFormElement>(null)
  const decision = useRef<HTMLInputElement>(null)
  // La décision passe par un champ caché réglé avant la soumission : FormData(form) n'inclut pas le bouton cliqué.
  const decide = (value: 'approve' | 'reject') => { if (decision.current) decision.current.value = value; formRef.current?.requestSubmit() }
  return (
    <form ref={formRef} onSubmit={onSubmit} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="decision" ref={decision} defaultValue="approve" />
      <FormField id={`dc-${id}`} label="Commentaire (obligatoire pour un refus)">
        <Input id={`dc-${id}`} name="comment" maxLength={300} />
      </FormField>
      <Button type="button" size="sm" disabled={pending} onClick={() => decide('approve')}><Check className="h-4 w-4" /> {approveLabel}</Button>
      <Button type="button" size="sm" variant="danger" disabled={pending} onClick={() => decide('reject')}><X className="h-4 w-4" /> Rejeter</Button>
      <div className="w-full"><Messages state={state} /></div>
    </form>
  )
}
