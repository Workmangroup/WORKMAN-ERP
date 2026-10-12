'use client'

import { useActionState } from 'react'
import { Alert } from '@/components/ui/alert'
import { Input } from '@/components/ui/input'
import { FormField } from '@/components/auth/form-field'
import { SubmitButton } from '@/components/auth/submit-button'
import { forgotPasswordAction } from '../actions'

export function ForgotPasswordForm() {
  const [state, formAction] = useActionState(forgotPasswordAction, null)
  const errs = state?.fieldErrors ?? {}

  if (state?.ok) {
    return (
      <Alert tone="success">
        {state.message} Le lien est valable une heure. Pensez à vérifier vos courriers indésirables.
      </Alert>
    )
  }

  return (
    <form action={formAction} className="space-y-4" noValidate>
      {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}
      <FormField id="email" label="Adresse e-mail" errors={errs.email}>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          autoFocus
          required
          aria-invalid={Boolean(errs.email)}
          aria-describedby={errs.email ? 'email-error' : undefined}
        />
      </FormField>
      <SubmitButton size="lg" className="w-full" pendingText="Envoi…">
        Envoyer le lien de réinitialisation
      </SubmitButton>
    </form>
  )
}
