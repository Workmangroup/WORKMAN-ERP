'use client'

import { useActionState, useState, type ReactNode } from 'react'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { SubmitButton } from '@/components/auth/submit-button'
import type { FormState } from '@/features/auth/types'

type Variant = 'primary' | 'secondary' | 'ghost' | 'command' | 'danger'
type Size = 'sm' | 'default' | 'lg'

/**
 * Bouton + boîte de dialogue contenant un formulaire relié à une action serveur.
 * Se referme quand l'action réussit ; les erreurs s'affichent dans la boîte. `fields` reçoit l'état (erreurs par champ, valeurs saisies).
 */
export function ActionDialog({ trigger, triggerVariant = 'secondary', triggerSize = 'sm', triggerLabel, triggerClassName, title, description, action, hidden, submit, submitVariant, children, wide }: {
  trigger: ReactNode
  triggerVariant?: Variant
  triggerSize?: Size
  triggerLabel?: string
  triggerClassName?: string
  title: string
  description?: ReactNode
  action: (prev: FormState, fd: FormData) => Promise<FormState>
  hidden?: Record<string, string>
  submit: string
  submitVariant?: Variant
  children?: (state: FormState) => ReactNode
  wide?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [state, formAction] = useActionState(async (p: FormState, fd: FormData) => {
    const r = await action(p, fd)
    if (r?.ok) setOpen(false)
    return r
  }, null as FormState)
  return (
    <>
      <Button type="button" variant={triggerVariant} size={triggerSize} className={triggerClassName} aria-label={triggerLabel} onClick={() => setOpen(true)}>{trigger}</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={title} className={wide ? 'max-w-2xl' : undefined}>
        <form action={formAction} className="space-y-4" noValidate>
          {Object.entries(hidden ?? {}).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
          {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}
          {description && <div className="text-sm text-ink-soft">{description}</div>}
          {children?.(state)}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Annuler</Button>
            <SubmitButton variant={submitVariant} pendingText="Enregistrement…">{submit}</SubmitButton>
          </div>
        </form>
      </Dialog>
    </>
  )
}
