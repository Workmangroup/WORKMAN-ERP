import Link from 'next/link'
import { AlertTriangle, Bell, Clock } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { ALERT_TYPES } from '@/lib/development/options'
import { fmtDay } from '@/features/orders/status'
import type { DevAlert } from '../types'
import { RemindButton } from './validations-panel'

const when = (a: DevAlert) => {
  if (a.type === 'stage_stuck') return `${a.days} jours dans la même étape`
  if (a.days > 0) return `en retard de ${a.days} jour${a.days > 1 ? 's' : ''}`
  if (a.days === 0) return 'échéance aujourd’hui'
  return `dans ${-a.days} jour${-a.days > 1 ? 's' : ''}`
}

/** Liste d'alertes de développement (validations client, retards de projet, prototypes, échantillons). */
export function AlertsList({ alerts, canWrite, limit }: { alerts: DevAlert[]; canWrite: boolean; limit?: number }) {
  const rows = limit ? alerts.slice(0, limit) : alerts
  if (rows.length === 0) return <p className="rounded-md border border-dashed border-line-strong bg-white p-8 text-center text-sm text-ink-soft">Aucune alerte : toutes les validations sont dans les temps.</p>
  return (
    <ul className="divide-y divide-line rounded-md border border-line bg-white shadow-card" aria-label="Alertes">
      {rows.map((a, i) => {
        const t = ALERT_TYPES[a.type] ?? { label: a.type, tone: 'neutral' as const }
        const Icon = a.severity === 'high' ? AlertTriangle : a.type.startsWith('validation') ? Bell : Clock
        return (
          <li key={`${a.type}-${a.project_id}-${a.ref_id ?? i}`} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <Icon className={a.severity === 'high' ? 'h-5 w-5 text-danger-text' : 'h-5 w-5 text-warn-text'} aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-2 text-sm"><Badge tone={t.tone}>{t.label}</Badge><Link href={`/development/projects/${a.project_id}${a.type.startsWith('validation') ? '?tab=validations' : ''}`} className="font-semibold text-brand-700 hover:underline"><span className="font-mono text-xs">{a.code}</span> {a.name}</Link></p>
              <p className="text-xs text-ink-soft">{a.client_name} · {a.ref}{a.due_date ? ` · échéance ${fmtDay(a.due_date)}` : ''} · {when(a)}{a.reminders > 0 ? ` · ${a.reminders} relance(s)` : ''}</p>
            </div>
            {canWrite && a.type.startsWith('validation') && a.ref_id && <RemindButton id={a.ref_id} projectId={a.project_id} />}
          </li>
        )
      })}
    </ul>
  )
}
