'use client'

import { useActionState, useState } from 'react'
import { Alert } from '@/components/ui/alert'
import { FormField } from '@/components/auth/form-field'
import { PasswordInput } from '@/components/auth/password-input'
import { PasswordStrength } from '@/components/auth/password-strength'
import { SubmitButton } from '@/components/auth/submit-button'
import { resetPasswordAction } from '../actions'

export function ResetPasswordForm() {
  const [state, formAction] = useActionState(resetPasswordAction, null)
  const [password, setPassword] = useState('')
  const errs = state?.fieldErrors ?? {}

  return (
    <form action={formAction} className="space-y-4" noValidate>
      {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}

      <FormField id="password" label="Nouveau mot de passe" errors={errs.password}>
        <PasswordInput
          id="password"
          name="password"
          autoComplete="new-password"
          autoFocus
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={Boolean(errs.password)}
          aria-describedby={errs.password ? 'password-error' : undefined}
        />
        <PasswordStrength password={password} />
      </FormField>

      <FormField id="confirm" label="Confirmer le mot de passe" errors={errs.confirm}>
        <PasswordInput
          id="confirm"
          name="confirm"
          autoComplete="new-password"
          required
          aria-invalid={Boolean(errs.confirm)}
          aria-describedby={errs.confirm ? 'confirm-error' : undefined}
        />
      </FormField>

      <SubmitButton size="lg" className="w-full" pendingText="Enregistrement…">
        Enregistrer le mot de passe
      </SubmitButton>
    </form>
  )
}
