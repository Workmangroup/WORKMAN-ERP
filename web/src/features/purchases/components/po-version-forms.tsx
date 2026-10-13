'use client'

import { useActionState } from 'react'
import { Alert } from '@/components/ui/alert'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { FormField } from '@/components/auth/form-field'
import { SubmitButton } from '@/components/auth/submit-button'
import { amendOrderAction, confirmOrderAction } from '../actions'

/** Confirmation fournisseur de la version envoyée : référence et date. */
export function ConfirmOrderForm({ poId, version, today }: { poId: string; version: number; today: string }) {
  const [state, action] = useActionState(confirmOrderAction, null)
  return (
    <form action={action} className="space-y-3" noValidate>
      <input type="hidden" name="id" value={poId} />
      <input type="hidden" name="version" value={version} />
      {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}
      {state?.ok && <Alert tone="success">{state.message}</Alert>}
      <div className="grid gap-3 md:grid-cols-[minmax(0,2fr)_10rem_auto] md:items-end">
        <FormField id={`cf-ref-${version}`} label={`Référence de confirmation de la version ${version} *`}><Input id={`cf-ref-${version}`} name="reference" maxLength={80} /></FormField>
        <FormField id={`cf-date-${version}`} label="Confirmée le *"><Input id={`cf-date-${version}`} name="confirmed_on" type="date" defaultValue={today} max={today} /></FormField>
        <SubmitButton pendingText="Enregistrement…">Enregistrer la confirmation</SubmitButton>
      </div>
    </form>
  )
}

/** Modification d'une commande envoyée : nouvelle version proposée, appliquée seulement après approbation. */
export function AmendOrderForm({ poId, lines }: { poId: string; lines: { id: string; material_code: string; material_name: string; qty_ordered: number; unit_price: number; qty_received: number }[] }) {
  const [state, action] = useActionState(amendOrderAction, null)
  return (
    <form action={action} className="space-y-3" noValidate>
      <input type="hidden" name="id" value={poId} />
      {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}
      {state?.ok && <Alert tone="success">{state.message}</Alert>}
      <p className="text-xs text-ink-soft">Les lignes restent inchangées jusqu’à l’approbation. Une quantité ne peut pas descendre sous le reçu.</p>
      {lines.map((l) => (
        <div key={l.id} className="grid gap-3 md:grid-cols-[minmax(0,2fr)_9rem_9rem] md:items-center">
          <span className="text-sm">{l.material_name} <span className="font-mono text-xs text-ink-faint">{l.material_code}</span> <span className="text-xs text-ink-faint">(reçu {l.qty_received})</span></span>
          <Input aria-label={`Quantité ${l.material_code}`} name={`qty_${l.id}`} inputMode="decimal" defaultValue={String(l.qty_ordered)} />
          <Input aria-label={`Prix unitaire ${l.material_code}`} name={`price_${l.id}`} inputMode="decimal" defaultValue={String(l.unit_price)} />
        </div>
      ))}
      <FormField id={`am-reason-${poId}`} label="Motif de la modification *"><Textarea id={`am-reason-${poId}`} name="reason" rows={2} maxLength={300} /></FormField>
      <div className="flex justify-end"><SubmitButton pendingText="Envoi…">Proposer la modification</SubmitButton></div>
    </form>
  )
}
