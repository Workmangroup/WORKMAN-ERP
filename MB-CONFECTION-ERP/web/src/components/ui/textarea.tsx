import * as React from 'react'
import { cn } from '@/lib/utils'

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        'min-h-20 w-full rounded-sm border border-line-strong bg-white px-3 py-2 text-sm text-ink placeholder:text-ink-faint',
        'hover:border-ink-soft focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500',
        'disabled:bg-canvas disabled:text-ink-faint',
        className,
      )}
      {...props}
    />
  ),
)
Textarea.displayName = 'Textarea'
