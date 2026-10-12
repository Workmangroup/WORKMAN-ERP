'use client'

import { useActionState, useMemo, useState } from 'react'
import { Lock } from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { SubmitButton } from '@/components/auth/submit-button'
import { cn } from '@/lib/utils'
import { saveRolePermissionsAction } from '../actions'

export interface PermissionGroup {
  module: string
  label: string
  permissions: { code: string; label: string; description: string | null }[]
}

/**
 * Éditeur de permissions d'un rôle, groupé par module.
 *  - `canEdit` faux : lecture seule ;
 *  - `grantable` : permissions que l'acteur a le droit d'accorder (anti-escalade) ;
 *  - `locked` : permissions imposées (ex. administration du rôle Administrateur).
 */
export function PermissionsEditor({
  roleId,
  groups,
  initial,
  canEdit,
  grantable,
  locked,
}: {
  roleId: string
  groups: PermissionGroup[]
  initial: string[]
  canEdit: boolean
  grantable: string[]
  locked: string[]
}) {
  const [state, formAction] = useActionState(saveRolePermissionsAction, null)
  const [selected, setSelected] = useState<Set<string>>(new Set(initial))
  const initialSet = useMemo(() => new Set(initial), [initial])
  const grantableSet = useMemo(() => new Set(grantable), [grantable])
  const lockedSet = useMemo(() => new Set(locked), [locked])

  const canToggle = (code: string) => canEdit && !lockedSet.has(code) && (selected.has(code) || grantableSet.has(code) || initialSet.has(code))
  const added = [...selected].filter((c) => !initialSet.has(c)).length
  const removed = [...initialSet].filter((c) => !selected.has(c)).length
  const dirty = added + removed > 0

  const toggle = (code: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(code)) next.delete(code)
      else next.add(code)
      return next
    })

  const toggleGroup = (g: PermissionGroup, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev)
      for (const p of g.permissions) {
        if (!canToggle(p.code)) continue
        if (on) next.add(p.code)
        else next.delete(p.code)
      }
      return next
    })

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="roleId" value={roleId} />
      {[...selected].map((code) => (
        <input key={code} type="hidden" name="perm" value={code} />
      ))}

      {state?.message && <Alert tone={state.ok ? 'success' : 'error'}>{state.message}</Alert>}

      <div className="grid gap-4 lg:grid-cols-2">
        {groups.map((g) => {
          const toggleable = g.permissions.filter((p) => canToggle(p.code))
          const allOn = toggleable.length > 0 && toggleable.every((p) => selected.has(p.code))
          const count = g.permissions.filter((p) => selected.has(p.code)).length
          return (
            <fieldset key={g.module} className="rounded-md border border-line">
              <legend className="sr-only">{g.label}</legend>
              <div className="flex items-center justify-between border-b border-line bg-canvas px-4 py-2">
                <span className="text-sm font-semibold">
                  {g.label} <span className="font-normal text-ink-soft">({count}/{g.permissions.length})</span>
                </span>
                {toggleable.length > 0 && (
                  <button type="button" onClick={() => toggleGroup(g, !allOn)} className="text-xs text-brand-600 hover:underline">
                    {allOn ? 'Tout retirer' : 'Tout cocher'}
                  </button>
                )}
              </div>
              <ul className="divide-y divide-line">
                {g.permissions.map((p) => {
                  const disabled = !canToggle(p.code)
                  const isOn = selected.has(p.code)
                  return (
                    <li key={p.code} className={cn('flex items-start gap-3 px-4 py-2.5', disabled && 'bg-white')}>
                      <Checkbox
                        id={`perm-${p.code}`}
                        checked={isOn}
                        disabled={disabled}
                        onChange={() => toggle(p.code)}
                        className="mt-0.5"
                        aria-describedby={`perm-${p.code}-code`}
                      />
                      <label htmlFor={`perm-${p.code}`} className={cn('min-w-0 flex-1 text-sm', disabled ? 'cursor-not-allowed' : 'cursor-pointer')}>
                        <span className="flex items-center gap-1 font-medium">
                          {p.label ?? p.code}
                          {lockedSet.has(p.code) && <Lock className="h-3 w-3 text-ink-faint" aria-label="Permission imposée" />}
                        </span>
                        <span id={`perm-${p.code}-code`} className="block font-mono text-xs text-ink-soft">{p.code}</span>
                        {p.description && <span className="block text-xs text-ink-faint">{p.description}</span>}
                        {canEdit && !isOn && !grantableSet.has(p.code) && !initialSet.has(p.code) && !lockedSet.has(p.code) && (
                          <span className="block text-xs text-warn-text">Vous ne détenez pas cette permission : impossible de l’accorder.</span>
                        )}
                      </label>
                    </li>
                  )
                })}
              </ul>
            </fieldset>
          )
        })}
      </div>

      {canEdit && (
        <div className="sticky bottom-0 -mx-1 flex items-center justify-between gap-3 border-t border-line bg-white/95 px-1 py-3 backdrop-blur">
          <p className="text-sm text-ink-soft" aria-live="polite">
            {dirty ? <>Modifications non enregistrées : <strong className="text-success-text">+{added}</strong> / <strong className="text-danger-text">−{removed}</strong></> : `${selected.size} permission(s) accordée(s)`}
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" disabled={!dirty} onClick={() => setSelected(new Set(initial))}>
              Annuler
            </Button>
            <SubmitButton disabled={!dirty} pendingText="Enregistrement…">Enregistrer les permissions</SubmitButton>
          </div>
        </div>
      )}
    </form>
  )
}
