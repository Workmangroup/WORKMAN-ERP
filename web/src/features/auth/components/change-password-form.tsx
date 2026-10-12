'use client'

import { useActionState, useEffect, useRef, useState } from 'react'
import { Alert } from '@/components/ui/alert'
import { FormField } from '@/components/auth/form-field'
import { PasswordInput } from '@/components/auth/password-input'
import { PasswordStrength } from '@/components/auth/password-strength'
import { SubmitButton } from '@/components/auth/submit-button'
import { changePasswordAction } from '../actions'

export function ChangePasswordForm() {
  const [state, formAction] = useActionState(changePasswordAction, null)
  const [password, setPassword] = useState('')
  const formRef = useRef<HTMLFormElement>(null)
  const errs = state?.fieldErrors ?? {}

  useEffect(() => {
    if (state?.ok) {
      formRef.current?.reset()
      setPassword('')
    }
  }, [state])

  return (
    <form ref={formRef} action={formAction} className="space-y-4" noValidate>
      {state?.message && <Alert tone={state.ok ? 'success' : 'error'}>{state.message}</Alert>}

      <FormField id="current" label="Mot de passe actuel" errors={errs.current}>
        <PasswordInput
          id="current"
          name="current"
          autoComplete="current-password"
          required
          aria-invalid={Boolean(errs.current)}
          aria-describedby={errs.current ? 'current-error' : undefined}
        />
      </FormField>

      <FormField id="password" label="Nouveau mot de passe" errors={errs.password}>
        <PasswordInput
          id="password"
          name="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={Boolean(errs.password)}
          aria-describedby={errs.password ? 'password-error' : undefined}
        />
        <PasswordStrength password={password} />
      </FormField>

      <FormField id="confirm" label="Confirmer le nouveau mot de passe" errors={errs.confirm}>
        <PasswordInput
          id="confirm"
          name="confirm"
          autoComplete="new-password"
          required
          aria-invalid={Boolean(errs.confirm)}
          aria-describedby={errs.confirm ? 'confirm-error' : undefined}
        />
      </FormField>

      <SubmitButton pendingText="Enregistrement…">Modifier le mot de passe</SubmitButton>
    </form>
  )
}
