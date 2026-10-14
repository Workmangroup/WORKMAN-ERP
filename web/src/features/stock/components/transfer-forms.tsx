'use client'

import { useActionState, useEffect, useState } from 'react'
import { Alert } from '@/components/ui/alert'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { FormField } from '@/components/auth/form-field'
import { SubmitButton } from '@/components/auth/submit-button'
import { createTransferAction, declareLossAction, receiveTransferAction } from '../transfers-actions'

export function TransferCreateForm({ materials, warehouses, locations }: {
  materials: { id: string; name: string }[]; warehouses: { id: string; label: string }[]
  locations: { id: string; warehouse_id: string; code: string }[]
}) {
  const [state, action] = useActionState(createTransferAction, null)
  return (
    <form action={action} className="grid gap-3 rounded-md border border-line bg-white p-4 shadow-card md:grid-cols-3" noValidate>
      {state && !state.ok && state.message && <div className="md:col-span-3"><Alert tone="error">{state.message}</Alert></div>}
      {state?.ok && <div className="md:col-span-3"><Alert tone="success">{state.message}</Alert></div>}
      <FormField id="tf-from" label="Entrepôt source *"><Select id="tf-from" name="from_wh" defaultValue=""><option value="">— Choisir —</option>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}</Select></FormField>
      <FormField id="tf-from-loc" label="Emplacement source *" hint="Pas de quarantaine comme source."><Select id="tf-from-loc" name="from_loc" defaultValue=""><option value="">— Choisir —</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.code}</option>)}</Select></FormField>
      <FormField id="tf-mat" label="Composant *"><Select id="tf-mat" name="material_id" defaultValue=""><option value="">— Choisir —</option>{materials.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select></FormField>
      <FormField id="tf-to" label="Entrepôt destination *"><Select id="tf-to" name="to_wh" defaultValue=""><option value="">— Choisir —</option>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}</Select></FormField>
      <FormField id="tf-to-loc" label="Emplacement destination *"><Select id="tf-to-loc" name="to_loc" defaultValue=""><option value="">— Choisir —</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.code}</option>)}</Select></FormField>
      <FormField id="tf-qty" label="Quantité *"><Input id="tf-qty" name="qty" inputMode="decimal" /></FormField>
      <FormField id="tf-note" label="Note"><Input id="tf-note" name="note" maxLength={500} /></FormField>
      <div className="flex items-end md:col-span-3"><SubmitButton pendingText="Création…">Créer le transfert</SubmitButton></div>
    </form>
  )
}

/** Réception : la clé d'idempotence est tirée par formulaire et renouvelée après chaque succès ; un double envoi reste refusé en base. */
export function ReceiveForm({ transferId, lineId, left }: { transferId: string; lineId: string; left: number }) {
  const [state, action] = useActionState(receiveTransferAction, null)
  const [idemKey, setIdemKey] = useState(() => crypto.randomUUID())
  useEffect(() => { if (state?.ok) setIdemKey(crypto.randomUUID()) }, [state])
  return (
    <form action={action} className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] md:items-end" noValidate>
      <input type="hidden" name="transfer_id" value={transferId} />
      <input type="hidden" name="line_id" value={lineId} />
      <input type="hidden" name="idem_key" value={idemKey} />
      <FormField id={`rc-qty-${lineId}`} label={`Quantité reçue (reste ${left})`}><Input id={`rc-qty-${lineId}`} name="qty" inputMode="decimal" /></FormField>
      <FormField id={`rc-proof-${lineId}`} label="Bon de transport *"><Input id={`rc-proof-${lineId}`} name="proof" maxLength={120} /></FormField>
      <SubmitButton pendingText="Réception…" disabled={left <= 0}>Enregistrer la réception</SubmitButton>
      {state?.message && <p role={state.ok ? 'status' : 'alert'} className={state.ok ? 'md:col-span-3 text-xs text-success-text' : 'md:col-span-3 text-xs text-danger-text'}>{state.message}</p>}
    </form>
  )
}

export function LossForm({ transferId, lineId, left }: { transferId: string; lineId: string; left: number }) {
  const [state, action] = useActionState(declareLossAction, null)
  return (
    <form action={action} className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] md:items-end" noValidate>
      <input type="hidden" name="transfer_id" value={transferId} />
      <input type="hidden" name="line_id" value={lineId} />
      <FormField id={`ls-qty-${lineId}`} label={`Quantité manquante (reste ${left})`}><Input id={`ls-qty-${lineId}`} name="qty" inputMode="decimal" /></FormField>
      <FormField id={`ls-why-${lineId}`} label="Motif (5 caractères min.)"><Input id={`ls-why-${lineId}`} name="reason" maxLength={500} /></FormField>
      <SubmitButton pendingText="Déclaration…" disabled={left <= 0}>Déclarer l’écart</SubmitButton>
      {state?.message && <p role={state.ok ? 'status' : 'alert'} className={state.ok ? 'md:col-span-3 text-xs text-success-text' : 'md:col-span-3 text-xs text-danger-text'}>{state.message}</p>}
    </form>
  )
}
