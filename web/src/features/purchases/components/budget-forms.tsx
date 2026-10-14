'use client'

import { useActionState } from 'react'
import { Alert } from '@/components/ui/alert'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { FormField } from '@/components/auth/form-field'
import { SubmitButton } from '@/components/auth/submit-button'
import { setBudgetAction } from '../actions'
import type { BudgetRow, CostCenterOption } from '../services/purchases.service'

/** Création d'un budget (centre et période), ou révision du seul montant d'un budget existant. */
export function BudgetForm({ costCenters, budget }: { costCenters: CostCenterOption[]; budget?: BudgetRow }) {
  const [state, action] = useActionState(setBudgetAction, null)
  const errs = state?.fieldErrors ?? {}
  const v = (k: string) => state?.values?.[k] ?? ''
  return (
    <form action={action} className="space-y-3" noValidate>
      {budget && <>
        <input type="hidden" name="budget_id" value={budget.id} />
        <input type="hidden" name="cost_center_id" value={budget.cost_center_id} />
        <input type="hidden" name="period_start" value={budget.period_start} />
        <input type="hidden" name="period_end" value={budget.period_end} />
      </>}
      {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}
      {state?.ok && <Alert tone="success">{state.message}</Alert>}
      <div className={budget ? 'grid gap-3 md:grid-cols-[12rem_auto] md:items-end' : 'grid gap-3 md:grid-cols-[minmax(0,2fr)_9rem_9rem_10rem_auto] md:items-end'}>
        {!budget && <>
          <FormField id="b-cc" label="Centre de coût *" errors={errs.cost_center_id}>
            <Select id="b-cc" name="cost_center_id" defaultValue={v('cost_center_id')}><option value="">— Choisir —</option>{costCenters.map((c) => <option key={c.id} value={c.id}>{c.code} — {c.label}</option>)}</Select>
          </FormField>
          <FormField id="b-start" label="Début *" errors={errs.period_start}><Input id="b-start" name="period_start" type="date" defaultValue={v('period_start')} /></FormField>
          <FormField id="b-end" label="Fin *" errors={errs.period_end}><Input id="b-end" name="period_end" type="date" defaultValue={v('period_end')} /></FormField>
        </>}
        <FormField id={`b-amount-${budget?.id ?? 'new'}`} label={budget ? 'Nouveau montant *' : 'Montant du budget *'} errors={errs.amount} hint="Ne peut pas descendre sous l’engagé + le réalisé.">
          <Input id={`b-amount-${budget?.id ?? 'new'}`} name="amount" inputMode="decimal" defaultValue={v('amount') || (budget ? String(budget.amount) : '')} />
        </FormField>
        <SubmitButton pendingText="Enregistrement…">{budget ? 'Réviser le montant' : 'Créer le budget'}</SubmitButton>
      </div>
    </form>
  )
}
