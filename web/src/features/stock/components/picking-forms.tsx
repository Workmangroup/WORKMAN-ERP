'use client'

import { useActionState } from 'react'
import { Alert } from '@/components/ui/alert'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { FormField } from '@/components/auth/form-field'
import { SubmitButton } from '@/components/auth/submit-button'
import { createPickAction, requestSubstitutionAction, scanLineAction, setExitRuleAction } from '../picking-actions'

export function ExitRuleForm({ current }: { current: string }) {
  const [state, action] = useActionState(setExitRuleAction, null)
  return (
    <form action={action} className="flex flex-wrap items-end gap-3 rounded-md border border-line bg-white p-4 shadow-card" noValidate>
      {state && !state.ok && state.message && <div className="w-full"><Alert tone="error">{state.message}</Alert></div>}
      {state?.ok && <div className="w-full"><Alert tone="success">{state.message}</Alert></div>}
      <FormField id="rule" label="Règle de sortie" hint="Choisit quel lot proposer. La méthode de valorisation (coût du lot) ne change pas.">
        <Select id="rule" name="rule" defaultValue={current}>
          <option value="fifo">FIFO — première entrée, première sortie</option>
          <option value="fefo">FEFO — échéance la plus proche d’abord</option>
        </Select>
      </FormField>
      <SubmitButton pendingText="Enregistrement…">Enregistrer la règle</SubmitButton>
    </form>
  )
}

export function PickCreateForm({ materials, warehouses }: {
  materials: { id: string; name: string }[]; warehouses: { id: string; label: string }[]
}) {
  const [state, action] = useActionState(createPickAction, null)
  return (
    <form action={action} className="grid gap-3 rounded-md border border-line bg-white p-4 shadow-card md:grid-cols-4" noValidate>
      {state && !state.ok && state.message && <div className="md:col-span-4"><Alert tone="error">{state.message}</Alert></div>}
      {state?.ok && <div className="md:col-span-4"><Alert tone="success">{state.message}</Alert></div>}
      <FormField id="pk-mat" label="Composant *"><Select id="pk-mat" name="material_id" defaultValue=""><option value="">— Choisir —</option>{materials.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select></FormField>
      <FormField id="pk-wh" label="Entrepôt *"><Select id="pk-wh" name="warehouse_id" defaultValue=""><option value="">— Choisir —</option>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}</Select></FormField>
      <FormField id="pk-qty" label="Quantité *"><Input id="pk-qty" name="qty" inputMode="decimal" /></FormField>
      <FormField id="pk-note" label="Note"><Input id="pk-note" name="note" maxLength={500} /></FormField>
      <div className="flex items-end md:col-span-4"><SubmitButton pendingText="Création…">Créer la liste de prélèvement</SubmitButton></div>
    </form>
  )
}

export function LineScanForm({ lineId, disabled }: { lineId: string; disabled: boolean }) {
  const [state, action] = useActionState(scanLineAction, null)
  return (
    <form action={action} className="flex flex-wrap items-end gap-2" noValidate>
      <input type="hidden" name="line_id" value={lineId} />
      <FormField id={`scan-${lineId}`} label="Code du lot scanné"><Input id={`scan-${lineId}`} name="code" maxLength={40} autoComplete="off" disabled={disabled} /></FormField>
      <SubmitButton pendingText="Contrôle…" disabled={disabled}>Valider le scan</SubmitButton>
      {state?.message && <p role={state.ok ? 'status' : 'alert'} className={state.ok ? 'w-full text-xs text-success-text' : 'w-full text-xs text-danger-text'}>{state.message}</p>}
    </form>
  )
}

export function SubstitutionForm({ lineId, lots }: { lineId: string; lots: { id: string; label: string }[] }) {
  const [state, action] = useActionState(requestSubstitutionAction, null)
  return (
    <form action={action} className="grid gap-2 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] md:items-end" noValidate>
      <input type="hidden" name="line_id" value={lineId} />
      <FormField id={`sub-lot-${lineId}`} label="Lot de remplacement"><Select id={`sub-lot-${lineId}`} name="lot_id" defaultValue=""><option value="">— Choisir —</option>{lots.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}</Select></FormField>
      <FormField id={`sub-why-${lineId}`} label="Motif (5 caractères min.)"><Input id={`sub-why-${lineId}`} name="reason" maxLength={500} /></FormField>
      <SubmitButton pendingText="Envoi…">Demander l’accord</SubmitButton>
      {state?.message && <p role={state.ok ? 'status' : 'alert'} className={state.ok ? 'md:col-span-3 text-xs text-success-text' : 'md:col-span-3 text-xs text-danger-text'}>{state.message}</p>}
    </form>
  )
}
