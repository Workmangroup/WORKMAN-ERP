'use client'

import { useActionState } from 'react'
import { Alert } from '@/components/ui/alert'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { FormField } from '@/components/auth/form-field'
import { SubmitButton } from '@/components/auth/submit-button'
import { decideReceiptLineAction } from '../actions'

/** Décision de contrôle d'une ligne reçue : accepté + rejeté = reçu ; rejet = retour fournisseur, motif obligatoire. */
export function ReceiptInspectForm({ lineId, received, locations }: { lineId: string; received: number; locations: { id: string; code: string; name: string | null }[] }) {
  const [state, action] = useActionState(decideReceiptLineAction, null)
  return (
    <form action={action} className="space-y-2 rounded-md border border-line bg-canvas/50 p-3" noValidate>
      <input type="hidden" name="receipt_line_id" value={lineId} />
      {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}
      {state?.ok && <Alert tone="success">{state.message}</Alert>}
      <div className="grid gap-3 md:grid-cols-[8rem_8rem_minmax(0,2fr)_minmax(0,1.5fr)_auto] md:items-end">
        <FormField id={`acc-${lineId}`} label={`Accepté (sur ${received}) *`}><Input id={`acc-${lineId}`} name="accept" inputMode="decimal" /></FormField>
        <FormField id={`rej-${lineId}`} label="Rejeté *"><Input id={`rej-${lineId}`} name="reject" inputMode="decimal" defaultValue="0" /></FormField>
        <FormField id={`rsn-${lineId}`} label="Motif (si rejet)"><Input id={`rsn-${lineId}`} name="reason" maxLength={300} /></FormField>
        <FormField id={`tgt-${lineId}`} label="Emplacement après acceptation" hint="Requis si la ligne est en quarantaine.">
          <Select id={`tgt-${lineId}`} name="target_location_id" defaultValue=""><option value="">— Aucun —</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.code}{l.name ? ` — ${l.name}` : ''}</option>)}</Select>
        </FormField>
        <SubmitButton pendingText="Enregistrement…">Enregistrer le contrôle</SubmitButton>
      </div>
    </form>
  )
}
