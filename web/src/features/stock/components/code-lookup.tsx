'use client'

import { useActionState, useEffect } from 'react'
import { Input } from '@/components/ui/input'
import { FormField } from '@/components/auth/form-field'
import { SubmitButton } from '@/components/auth/submit-button'
import { scanFeedback, signalScan } from '@/lib/field/scan-feedback'
import { resolveStockCodeAction } from '../scan-actions'

export function StockCodeLookup() {
  const [state, action] = useActionState(resolveStockCodeAction, null)
  useEffect(() => { if (state) signalScan(scanFeedback({ ok: state.ok, message: state.message })) }, [state])
  return (
    <form action={action} className="space-y-3 rounded-md border border-line bg-white p-4 shadow-card" noValidate>
      <FormField id="code-lookup" label="Code article, lot, emplacement, préparation, transfert ou inventaire">
        <Input id="code-lookup" name="code" maxLength={60} autoComplete="off" />
      </FormField>
      <SubmitButton pendingText="Recherche…">Identifier le code</SubmitButton>
      {state?.message && <p role={state.ok ? 'status' : 'alert'} className={state.ok ? 'text-sm text-success-text' : 'text-sm text-danger-text'}>{state.message}</p>}
    </form>
  )
}
