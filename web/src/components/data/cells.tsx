import { AlertTriangle, OctagonAlert, Info } from 'lucide-react'
import { cn } from '@/lib/utils'

/** Statut en couleur : toujours accompagné d'un libellé (jamais la couleur seule). */
export type Tone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger'
const PILL: Record<Tone, string> = {
  neutral: 'bg-canvas text-ink-soft border-line',
  brand: 'bg-brand-50 text-brand-700 border-brand-200',
  success: 'bg-success-bg text-success-text border-success/30',
  warning: 'bg-warn-bg text-warn-text border-warn/30',
  danger: 'bg-danger-bg text-danger-text border-danger/30',
}
const DOT: Record<Tone, string> = { neutral: 'bg-ink-faint', brand: 'bg-brand-500', success: 'bg-success', warning: 'bg-warn', danger: 'bg-danger' }

export function StatusPill({ label, tone }: { label: string; tone: Tone }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium', PILL[tone])}>
      <span className={cn('h-1.5 w-1.5 rounded-full', DOT[tone])} aria-hidden />
      {label}
    </span>
  )
}

const AVATAR_TONES = ['bg-brand-500', 'bg-accent', 'bg-warn', 'bg-danger', 'bg-chart-5', 'bg-ink-soft']
/** Avatar : initiales sur une couleur stable dérivée du nom. */
export function Avatar({ name, title }: { name: string | null | undefined; title?: string }) {
  const clean = (name ?? '').trim()
  if (!clean) return <span className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-dashed border-line-strong text-[10px] text-ink-faint" title="Non attribué">–</span>
  const initials = clean.split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('')
  const hash = [...clean].reduce((h, c) => h + c.charCodeAt(0), 0)
  return (
    <span className="inline-flex items-center gap-2" title={title ?? clean}>
      <span className={cn('inline-flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-semibold text-white', AVATAR_TONES[hash % AVATAR_TONES.length])} aria-hidden>{initials}</span>
      <span className="truncate text-sm">{clean}</span>
    </span>
  )
}

/** Progression : barre + pourcentage, couleur selon le niveau. */
export function Progress({ value, max, label }: { value: number; max: number; label?: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0
  const tone = pct >= 100 ? 'bg-success' : pct >= 50 ? 'bg-brand-500' : 'bg-warn'
  return (
    <div className="min-w-[7rem]">
      <div className="mb-1 flex justify-between text-[11px] text-ink-soft tabular-nums"><span>{label ?? ''}</span><span>{pct} %</span></div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-canvas" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className={cn('h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none', tone)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

/** Alerte : icône + libellé, gravité explicite. */
export function AlertBadge({ severity, text }: { severity: 'critical' | 'warning' | 'info'; text: string }) {
  const Icon = severity === 'critical' ? OctagonAlert : severity === 'warning' ? AlertTriangle : Info
  const cls = severity === 'critical' ? 'text-danger-text' : severity === 'warning' ? 'text-warn-text' : 'text-brand-600'
  return (
    <span className={cn('inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium', cls)}>
      <Icon className="h-3.5 w-3.5" aria-hidden /> {text}
    </span>
  )
}
