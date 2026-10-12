import * as React from 'react'
import { cn } from '@/lib/utils'

/** Case à cocher native stylée (accessible clavier / lecteur d'écran). */
export const Checkbox = React.forwardRef<HTMLInputElement, Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      type="checkbox"
      className={cn(
        'h-4 w-4 shrink-0 cursor-pointer rounded-sm border border-line-strong accent-brand-500',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
)
Checkbox.displayName = 'Checkbox'
