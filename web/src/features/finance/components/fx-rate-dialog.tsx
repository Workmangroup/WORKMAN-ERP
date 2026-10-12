'use client'

import { Plus } from 'lucide-react'
import { ActionDialog } from '@/components/common/action-dialog'
import { FormField } from '@/components/auth/form-field'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { saveFxRateAction } from '../fx-actions'

const today = () => new Date().toISOString().slice(0, 10)

/** Saisie d'un taux : 1 unité de la devise vaut ce montant dans la devise de base. */
export function FxRateDialog({ currencies, base }: { currencies: { code: string; name: string }[]; base: string }) {
  return (
    <ActionDialog trigger={<><Plus className="h-4 w-4" /> Saisir un taux</>} triggerVariant="primary" title="Taux de change" action={saveFxRateAction} submit="Enregistrer le taux"
      description={`Un taux vaut combien de ${base} pour une unité de la devise. Une seule valeur par jour et par devise : la saisie remplace celle du jour.`}>
      {(st) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField id="fx-c" label="Devise *" errors={st?.fieldErrors?.currency}>
            <Select id="fx-c" name="currency" defaultValue={currencies[0]?.code ?? ''}>
              {currencies.map((c) => <option key={c.code} value={c.code}>{c.code} · {c.name}</option>)}
            </Select>
          </FormField>
          <FormField id="fx-d" label="Date *" errors={st?.fieldErrors?.rate_date}>
            <Input id="fx-d" name="rate_date" type="date" defaultValue={today()} max={today()} />
          </FormField>
          <div className="sm:col-span-2">
            <FormField id="fx-r" label={`Taux (en ${base}) *`} errors={st?.fieldErrors?.rate}>
              <Input id="fx-r" name="rate" inputMode="decimal" placeholder="ex. 0,3300" />
            </FormField>
          </div>
        </div>
      )}
    </ActionDialog>
  )
}
