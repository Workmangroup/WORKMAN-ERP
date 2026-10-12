import * as React from 'react'
import { cn } from '@/lib/utils'

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, defaultValue, ...props }, ref) => (
    // key = valeur par défaut : après une erreur de formulaire (React 19 réinitialise le formulaire), le <select> est remonté
    // avec la valeur saisie par l'utilisateur (React n'actualise pas defaultValue d'un select déjà monté).
    <select
      key={defaultValue === undefined ? undefined : String(defaultValue)}
      defaultValue={defaultValue}
      ref={ref}
      className={cn(
        'h-9 w-full rounded-sm border border-line-strong bg-white px-2 text-sm text-ink',
        'hover:border-ink-soft focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500',
        'aria-[invalid=true]:border-danger disabled:bg-canvas disabled:text-ink-faint',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  ),
)
Select.displayName = 'Select'
