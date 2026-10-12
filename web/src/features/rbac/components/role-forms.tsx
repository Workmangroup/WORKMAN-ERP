'use client'

import { useActionState } from 'react'
import { Alert } from '@/components/ui/alert'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { FormField } from '@/components/auth/form-field'
import { SubmitButton } from '@/components/auth/submit-button'
import { createRoleAction, deleteRoleAction, updateRoleAction } from '../actions'

export function RoleCreateForm() {
  const [state, formAction] = useActionState(createRoleAction, null)
  const errs = state?.fieldErrors ?? {}
  return (
    <form action={formAction} className="max-w-xl space-y-4" noValidate>
      {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}
      <FormField id="label" label="Libellé" errors={errs.label}>
        <Input id="label" name="label" required autoFocus placeholder="Ex. Contrôle de gestion" aria-invalid={Boolean(errs.label)} />
      </FormField>
      <FormField id="code" label="Code technique" errors={errs.code} hint="Identifiant unique non modifiable : minuscules, chiffres et « _ » (ex. controle_gestion).">
        <Input id="code" name="code" required className="font-mono" placeholder="controle_gestion" aria-invalid={Boolean(errs.code)} />
      </FormField>
      <FormField id="description" label="Description (facultatif)" errors={errs.description}>
        <Textarea id="description" name="description" maxLength={300} />
      </FormField>
      <SubmitButton pendingText="Création…">Créer le rôle</SubmitButton>
    </form>
  )
}

export function RoleEditForm({
  role,
  canEdit,
}: {
  role: { id: string; code: string; label: string; description: string | null; is_system: boolean }
  canEdit: boolean
}) {
  const [state, formAction] = useActionState(updateRoleAction, null)
  const errs = state?.fieldErrors ?? {}
  return (
    <form action={formAction} className="space-y-4" noValidate>
      <input type="hidden" name="roleId" value={role.id} />
      {state?.message && <Alert tone={state.ok ? 'success' : 'error'}>{state.message}</Alert>}
      <FormField id="label" label="Libellé" errors={errs.label} hint={role.is_system ? 'Le libellé d’un rôle système est verrouillé.' : undefined}>
        <Input id="label" name="label" defaultValue={role.label} disabled={!canEdit || role.is_system} required />
        {role.is_system && <input type="hidden" name="label" value={role.label} />}
      </FormField>
      <div>
        <p className="mb-1 text-sm font-semibold">Code technique</p>
        <p className="font-mono text-sm text-ink-soft">{role.code}</p>
      </div>
      <FormField id="description" label="Description" errors={errs.description}>
        <Textarea id="description" name="description" defaultValue={role.description ?? ''} disabled={!canEdit} maxLength={300} />
      </FormField>
      {canEdit && <SubmitButton pendingText="Enregistrement…">Enregistrer</SubmitButton>}
    </form>
  )
}

export function RoleDeleteForm({ roleId, label, disabledReason }: { roleId: string; label: string; disabledReason?: string }) {
  const [state, formAction] = useActionState(deleteRoleAction, null)
  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (!window.confirm(`Supprimer définitivement le rôle « ${label} » ?`)) e.preventDefault()
      }}
      className="space-y-3"
    >
      <input type="hidden" name="roleId" value={roleId} />
      {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}
      {disabledReason && <p className="text-sm text-ink-soft">{disabledReason}</p>}
      <SubmitButton variant="danger" disabled={Boolean(disabledReason)} pendingText="Suppression…">
        Supprimer ce rôle
      </SubmitButton>
    </form>
  )
}
