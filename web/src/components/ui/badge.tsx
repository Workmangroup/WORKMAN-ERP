import * as React from 'react'
import { cn } from '@/lib/utils'

const tones = {
  neutral: 'bg-canvas text-ink-soft border-line',
  brand: 'bg-brand-50 text-brand-700 border-brand-200',
  success: 'bg-success-bg text-success-text border-success/30',
  danger: 'bg-danger-bg text-danger-text border-danger/30',
  warning: 'bg-warn-bg text-warn-text border-warn/30',
}

export function Badge({
  tone = 'neutral',
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: keyof typeof tones }) {
  return (
    <span
      className={cn('inline-flex items-center rounded-sm border px-2 py-0.5 text-xs font-semibold', tones[tone], className)}
      {...props}
    />
  )
}
