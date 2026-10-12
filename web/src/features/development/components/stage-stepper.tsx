import { Check } from 'lucide-react'
import { STAGES, stageIndex } from '@/lib/development/options'
import { cn } from '@/lib/utils'

/** Frise du workflow : demande → projet → prototype → échantillon → BAT → validation → industrialisation → série. */
export function StageStepper({ stage, dim = false }: { stage: string; dim?: boolean }) {
  const cur = stageIndex(stage)
  return (
    <ol className="flex w-full items-start gap-1 overflow-x-auto pb-1" aria-label="Avancement du projet">
      {STAGES.map((s, i) => {
        const done = i < cur
        const current = i === cur
        return (
          <li key={s.id} className="flex min-w-[5.5rem] flex-1 flex-col items-center gap-1 text-center" aria-current={current ? 'step' : undefined}>
            <div className="flex w-full items-center">
              <span className={cn('h-0.5 flex-1', i === 0 ? 'bg-transparent' : done || current ? 'bg-brand-500' : 'bg-line')} />
              <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 text-xs font-semibold',
                done ? 'border-brand-500 bg-brand-500 text-white' : current ? cn('border-brand-500 bg-white text-brand-700 ring-4 ring-brand-100', dim && 'ring-0 opacity-60') : 'border-line-strong bg-white text-ink-faint')}>
                {done ? <Check className="h-3.5 w-3.5" aria-hidden /> : i + 1}
              </span>
              <span className={cn('h-0.5 flex-1', i === STAGES.length - 1 ? 'bg-transparent' : done ? 'bg-brand-500' : 'bg-line')} />
            </div>
            <span className={cn('text-xs leading-tight', current ? 'font-semibold text-brand-700' : done ? 'text-ink' : 'text-ink-faint')}>{s.short}</span>
          </li>
        )
      })}
    </ol>
  )
}
