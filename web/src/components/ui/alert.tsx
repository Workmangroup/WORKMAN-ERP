import * as React from 'react'
import { AlertCircle, CheckCircle2, Info, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'

type Tone = 'error' | 'success' | 'warning' | 'info'

const tones: Record<Tone, { box: string; icon: React.ElementType }> = {
  error: { box: 'bg-danger-bg text-danger-text border-danger/30', icon: AlertCircle },
  success: { box: 'bg-success-bg text-success-text border-success/30', icon: CheckCircle2 },
  warning: { box: 'bg-warn-bg text-warn-text border-warn/30', icon: TriangleAlert },
  info: { box: 'bg-brand-50 text-brand-700 border-brand-200', icon: Info },
}

export function Alert({
  tone = 'info',
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { tone?: Tone }) {
  const { box, icon: Icon } = tones[tone]
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn('flex items-start gap-2 rounded-sm border px-3 py-2 text-sm', box, className)}
      {...props}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div>{children}</div>
    </div>
  )
}
