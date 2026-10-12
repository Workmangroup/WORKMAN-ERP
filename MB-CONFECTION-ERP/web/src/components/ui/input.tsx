import * as React from 'react'
import { cn } from '@/lib/utils'

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type = 'text', ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        'h-9 w-full rounded-sm border border-line-strong bg-white px-3 text-sm text-ink placeholder:text-ink-faint',
        'hover:border-ink-soft focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500',
        'aria-[invalid=true]:border-danger aria-[invalid=true]:focus:ring-danger disabled:bg-canvas disabled:text-ink-faint',
        className,
      )}
      {...props}
    />
  ),
)
Input.displayName = 'Input'
