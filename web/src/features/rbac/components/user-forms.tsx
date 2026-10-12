'use client'

import { useActionState } from 'react'
import { Lock } from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { Checkbox } from '@/components/ui/checkbox'
import { SubmitButton } from '@/components/auth/submit-button'
import { revokeUserSessionsAction, saveUserRolesAction, setUserActiveAction } from '../actions'

export interface AssignableRole {
  id: string
  code: string
  label: string
  description: string | null
  is_system: boolean
  /** false : l'acteur ne détient pas toutes les permissions du rôle (anti-escalade) */
  assignable: boolean
}

export function UserRolesForm({
  userId,
  roles,
  assigned,
  canAssign,
  canForceLogout,
  isSelf,
}: {
  userId: string
  roles: AssignableRole[]
  assigned: string[]
  canAssign: boolean
  canForceLogout: boolean
  isSelf: boolean
}) {
  const [state, formAction] = useActionState(saveUserRolesAction, null)
  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="userId" value={userId} />
      {state?.message && <Alert tone={state.ok ? 'success' : 'error'}>{state.message}</Alert>}

      <ul className="divide-y divide-line rounded-md border border-line">
        {roles.map((r) => {
          const isAssigned = assigned.includes(r.id)
          const disabled = !canAssign || (!r.assignable && !isAssigned)
          return (
            <li key={r.id} className="flex items-start gap-3 px-4 py-3">
              <Checkbox id={`role-${r.id}`} name="role" value={r.id} defaultChecked={isAssigned} disabled={disabled} className="mt-0.5" />
              <label htmlFor={`role-${r.id}`} className="min-w-0 flex-1 text-sm">
                <span className="flex items-center gap-2 font-medium">
                  {r.label}
                  {r.is_system && <span className="rounded-sm bg-canvas px-1.5 text-[10px] font-semibold uppercase text-ink-soft">système</span>}
                  {disabled && !isAssigned && canAssign && <Lock className="h-3 w-3 text-ink-faint" aria-label="Non affectable" />}
                </span>
                {r.description && <span className="block text-xs text-ink-soft">{r.description}</span>}
                {!r.assignable && !isAssigned && canAssign && (
                  <span className="block text-xs text-warn-text">Ce rôle contient des permissions que vous ne détenez pas.</span>
                )}
              </label>
              {isAssigned && !canAssign && <input type="hidden" name="role" value={r.id} />}
            </li>
          )
        })}
      </ul>

      {canAssign && (
        <>
          {canForceLogout && !isSelf && (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox name="force_logout" /> Forcer la reconnexion de l’utilisateur (applique immédiatement les nouveaux droits)
            </label>
          )}
          <SubmitButton pendingText="Enregistrement…">Enregistrer les rôles</SubmitButton>
        </>
      )}
    </form>
  )
}

export function UserStatusForm({ userId, isActive, canWrite, isSelf }: { userId: string; isActive: boolean; canWrite: boolean; isSelf: boolean }) {
  const [state, formAction] = useActionState(setUserActiveAction, null)
  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (isActive && !window.confirm('Désactiver ce compte ? Ses sessions seront révoquées immédiatement.')) e.preventDefault()
      }}
      className="space-y-3"
    >
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="active" value={isActive ? '0' : '1'} />
      {state?.message && <Alert tone={state.ok ? 'success' : 'error'}>{state.message}</Alert>}
      <p className="text-sm text-ink-soft">
        {isActive ? 'Le compte est actif : l’utilisateur peut se connecter.' : 'Le compte est désactivé : toute connexion est refusée.'}
      </p>
      {canWrite && (
        <SubmitButton variant={isActive ? 'danger' : 'primary'} disabled={isActive && isSelf} pendingText="Mise à jour…">
          {isActive ? 'Désactiver le compte' : 'Réactiver le compte'}
        </SubmitButton>
      )}
      {isActive && isSelf && <p className="text-xs text-ink-faint">Vous ne pouvez pas désactiver votre propre compte.</p>}
    </form>
  )
}

export function RevokeSessionsForm({ userId }: { userId: string }) {
  const [state, formAction] = useActionState(revokeUserSessionsAction, null)
  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="userId" value={userId} />
      {state?.message && <Alert tone={state.ok ? 'success' : 'error'}>{state.message}</Alert>}
      <SubmitButton variant="secondary" pendingText="Révocation…">Déconnecter tous ses appareils</SubmitButton>
    </form>
  )
}
