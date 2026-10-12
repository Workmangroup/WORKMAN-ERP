'use client'

import { useActionState } from 'react'
import { SubmitButton } from '@/components/auth/submit-button'
import type { ButtonProps } from '@/components/ui/button'
import type { FormState } from '@/features/auth/types'

/** Petit formulaire à un bouton : exécute une action serveur et affiche son résultat (erreur ou succès) sous le bouton. */
export function RpcButton({ action, fields, children, confirm, pendingText, ...props }: {
  action: (prev: FormState, fd: FormData) => Promise<FormState>
  fields: Record<string, string>
  confirm?: string
  pendingText?: string
} & Omit<ButtonProps, 'type' | 'onClick'>) {
  const [state, formAction] = useActionState(action, null)
  return (
    <form action={formAction} onSubmit={(e) => { if (confirm && !window.confirm(confirm)) e.preventDefault() }} className="inline-block">
      {Object.entries(fields).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <SubmitButton pendingText={pendingText} {...props}>{children}</SubmitButton>
      {state?.message && <p role={state.ok ? 'status' : 'alert'} className={state.ok ? 'mt-1 text-xs text-success-text' : 'mt-1 max-w-xs text-xs text-danger-text'}>{state.message}</p>}
    </form>
  )
}
