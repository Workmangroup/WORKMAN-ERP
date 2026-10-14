'use client'

import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { FormField } from '@/components/auth/form-field'
import type { FormState } from '@/features/auth/types'
import { useManualAction } from '@/lib/use-manual-action'
import { saveConversionAction } from '../actions'

export function ConversionForm({ materials, units }: { materials: { id: string; name: string; code: string }[]; units: { code: string; label: string }[] }) {
  const [state, onSubmit, pending] = useManualAction(saveConversionAction, null as FormState)
  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      <FormField id="cv-material" label="Composant">
        <Select id="cv-material" name="material" required defaultValue="">
          <option value="" disabled>Choisir</option>
          {materials.map((m) => <option key={m.id} value={m.id}>{m.code} · {m.name}</option>)}
        </Select>
      </FormField>
      <FormField id="cv-from" label="Depuis">
        <Select id="cv-from" name="from_unit" required defaultValue="roll">
          {units.map((u) => <option key={u.code} value={u.code}>{u.label}</option>)}
        </Select>
      </FormField>
      <FormField id="cv-to" label="Vers">
        <Select id="cv-to" name="to_unit" required defaultValue="m">
          {units.map((u) => <option key={u.code} value={u.code}>{u.label}</option>)}
        </Select>
      </FormField>
      <FormField id="cv-factor" label="1 unité « depuis » vaut" hint="Multiplicateur (ex. 2 pour 1 pièce = 2 m).">
        <Input id="cv-factor" name="factor" inputMode="decimal" required />
      </FormField>
      <FormField id="cv-basis" label="Source de la valeur" hint="Fiche technique, mesure… (5 caractères minimum).">
        <Input id="cv-basis" name="basis" minLength={5} maxLength={300} required />
      </FormField>
      <div className="sm:col-span-2 lg:col-span-5 space-y-2">
        {state && <Alert tone={state.ok ? 'success' : 'error'}>{state.message}</Alert>}
        <div className="flex justify-end"><Button type="submit" disabled={pending}>Enregistrer la conversion</Button></div>
      </div>
    </form>
  )
}
