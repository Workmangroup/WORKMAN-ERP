import * as React from 'react'
import { Label } from '@/components/ui/label'

/** Champ de formulaire accessible : label, aide, message d'erreur lié via aria-describedby. */
export function FormField({
  id,
  label,
  errors,
  hint,
  children,
  action,
}: {
  id: string
  label: string
  errors?: string[]
  hint?: string
  children: React.ReactNode
  action?: React.ReactNode
}) {
  const err = errors?.[0]
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <Label htmlFor={id}>{label}</Label>
        {action}
      </div>
      {children}
      {hint && !err && <p id={`${id}-hint`} className="mt-1 text-xs text-ink-soft">{hint}</p>}
      {err && (
        <p id={`${id}-error`} role="alert" className="mt-1 text-xs text-danger-text">
          {err}
        </p>
      )}
    </div>
  )
}
