'use client'

import Link from 'next/link'
import { useActionState } from 'react'
import { Alert } from '@/components/ui/alert'
import { Input } from '@/components/ui/input'
import { FormField } from '@/components/auth/form-field'
import { PasswordInput } from '@/components/auth/password-input'
import { SubmitButton } from '@/components/auth/submit-button'
import { ROUTES } from '@/lib/auth/constants'
import { loginAction } from '../actions'

export function LoginForm({ next, notice }: { next?: string; notice?: { tone: 'info' | 'success' | 'warning' | 'error'; text: string } }) {
  const [state, formAction] = useActionState(loginAction, null)
  const errs = state?.fieldErrors ?? {}

  return (
    <form action={formAction} className="space-y-4" noValidate>
      {next && <input type="hidden" name="next" value={next} />}

      {notice && !state && <Alert tone={notice.tone}>{notice.text}</Alert>}

      {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}

      <FormField id="email" label="Adresse e-mail" errors={errs.email}>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          autoFocus
          required
          defaultValue={state?.values?.email}
          placeholder="prenom.nom@mbconfection.com"
          aria-invalid={Boolean(errs.email)}
          aria-describedby={errs.email ? 'email-error' : undefined}
        />
      </FormField>

      <FormField
        id="password"
        label="Mot de passe"
        errors={errs.password}
        action={
          <Link href={ROUTES.forgotPassword} className="text-xs text-brand-600 hover:underline">
            Mot de passe oublié ?
          </Link>
        }
      >
        <PasswordInput
          id="password"
          name="password"
          autoComplete="current-password"
          required
          aria-invalid={Boolean(errs.password)}
          aria-describedby={errs.password ? 'password-error' : undefined}
        />
      </FormField>

      <SubmitButton size="lg" className="w-full" pendingText="Connexion…">
        Se connecter
      </SubmitButton>
    </form>
  )
}
