'use client'

import { Check, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { passwordScore } from '@/features/auth/schemas'

const RULES = ['10 caractères minimum', 'Une minuscule', 'Une majuscule', 'Un chiffre', 'Un symbole']
const LABELS = ['Très faible', 'Faible', 'Moyen', 'Bon', 'Excellent']
const COLORS = ['bg-danger', 'bg-danger', 'bg-[#c19c00]', 'bg-success', 'bg-success']

/** Jauge de robustesse + checklist de la politique de mot de passe. */
export function PasswordStrength({ password }: { password: string }) {
  const { checks, score } = passwordScore(password)
  if (!password) return null
  return (
    <div className="mt-2" aria-live="polite">
      <div className="flex items-center gap-2">
        <div className="flex flex-1 gap-1" aria-hidden>
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className={cn('h-1 flex-1 rounded-full', i < score ? COLORS[score] : 'bg-line')} />
          ))}
        </div>
        <span className="text-xs text-ink-soft">{LABELS[score]}</span>
      </div>
      <ul className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        {RULES.map((rule, i) => (
          <li key={rule} className={cn('flex items-center gap-1', checks[i] ? 'text-success-text' : 'text-ink-soft')}>
            {checks[i] ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
            {rule}
          </li>
        ))}
      </ul>
    </div>
  )
}
