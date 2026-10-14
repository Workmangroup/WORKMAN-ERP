'use client'

import { useActionState } from 'react'
import { SubmitButton } from '@/components/auth/submit-button'
import type { FormState } from '@/features/auth/types'

type Field = { name: string; label: string; type?: string; required?: boolean; pattern?: string; placeholder?: string }

/** Petit formulaire d'action fiscale : champs saisis, valeurs cachées (identifiants), résultat affiché sous le bouton. */
export function TaxForm({ action, fields, hidden = {}, submit, confirm }: {
  action: (prev: FormState, fd: FormData) => Promise<FormState>
  fields: Field[]
  hidden?: Record<string, string>
  submit: string
  confirm?: string
}) {
  const [state, formAction] = useActionState(action, null)
  return (
    <form action={formAction} onSubmit={(e) => { if (confirm && !window.confirm(confirm)) e.preventDefault() }} className="flex flex-wrap items-end gap-2 text-sm">
      {Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      {fields.map((f) => (
        <label key={f.name} className="flex flex-col gap-1 text-xs text-ink-soft">
          {f.label}
          <input name={f.name} type={f.type ?? 'text'} required={f.required} pattern={f.pattern} placeholder={f.placeholder}
                 className="h-8 rounded-md border border-line-strong bg-surface px-2 text-sm text-ink" />
        </label>
      ))}
      <SubmitButton>{submit}</SubmitButton>
      {state?.message && <p role={state.ok ? 'status' : 'alert'} className={state.ok ? 'w-full text-xs text-success-text' : 'w-full text-xs text-danger-text'}>{state.message}</p>}
    </form>
  )
}
