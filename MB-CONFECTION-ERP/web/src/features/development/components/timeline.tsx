import { ArrowRightLeft, Bell, CheckCircle2, FileText, FlaskConical, Link2, MessageSquare, Pencil, PlusCircle, Send, Shirt, Unlink, Wrench, type LucideIcon } from 'lucide-react'
import { ACTION_LABELS } from '@/lib/rbac/audit-labels'
import { DEV_FIELD_LABELS, PRIORITY, PROJECT_STATUS, PROTO_STATUS, SAMPLE_STATUS, VALIDATION_KIND, VALIDATION_STATUS, stageInfo, INDUSTRIALIZATION_STATUS, DEV_DOC_KINDS, label } from '@/lib/development/options'
import { formatDateTime } from '@/lib/utils'
import type { AuditRow } from '@/features/rbac/types'

const ICONS: Record<string, LucideIcon> = {
  'dev.create': PlusCircle, 'dev.update': Pencil, 'dev.stage': ArrowRightLeft, 'dev.status': Pencil, 'dev.prototype_add': FlaskConical, 'dev.prototype_update': Pencil, 'dev.prototype_status': FlaskConical,
  'dev.cost_add': FileText, 'dev.cost_update': FileText, 'dev.cost_delete': FileText, 'dev.sample_add': Shirt, 'dev.sample_update': Pencil, 'dev.sample_status': Shirt,
  'dev.validation_submit': Send, 'dev.validation_update': Pencil, 'dev.validation_decide': CheckCircle2, 'dev.validation_remind': Bell, 'dev.exchange_add': MessageSquare,
  'dev.document_link': Link2, 'dev.document_unlink': Unlink, 'dev.industrialization_update': Wrench, 'dev.industrialization_status': Wrench,
}
const day = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? `${v.slice(8, 10)}/${v.slice(5, 7)}/${v.slice(0, 4)}` : String(v))
const show = (k: string, v: unknown, action = '') => {
  if (v === null || v === undefined || v === '') return '—'
  if (k === 'stage') return stageInfo(String(v)).label
  if (k === 'priority') return PRIORITY[v as keyof typeof PRIORITY]?.label ?? String(v)
  if (k === 'due_date' || k === 'target_date' || k === 'started_on') return day(v)
  if (k === 'status') {
    const s = String(v)
    if (action === 'dev.industrialization_status') return INDUSTRIALIZATION_STATUS[s as keyof typeof INDUSTRIALIZATION_STATUS]?.label ?? s
    return PROJECT_STATUS[s as keyof typeof PROJECT_STATUS]?.label ?? PROTO_STATUS[s as keyof typeof PROTO_STATUS]?.label ?? SAMPLE_STATUS[s as keyof typeof SAMPLE_STATUS]?.label ?? VALIDATION_STATUS[s as keyof typeof VALIDATION_STATUS]?.label ?? INDUSTRIALIZATION_STATUS[s as keyof typeof INDUSTRIALIZATION_STATUS]?.label ?? s
  }
  const s = String(v)
  return s.length > 120 ? `${s.slice(0, 117)}…` : s
}

/** Chronologie d'un projet de développement (audit_logs, entity_type = 'dev_project') : étapes, validations, échanges, pièces jointes. Jamais de montant de coût. */
export function DevTimeline({ rows }: { rows: AuditRow[] }) {
  if (rows.length === 0) return <p className="rounded-md border border-dashed border-line-strong p-8 text-center text-sm text-ink-soft">Aucun historique.</p>
  return (
    <ol className="relative border-l-2 border-line pl-6">
      {rows.map((r) => {
        const Icon = ICONS[r.action] ?? Pencil
        const m = r.metadata ?? {}
        const before = r.before_data ?? {}
        const after = r.after_data ?? {}
        const diff = ['dev.update', 'dev.stage', 'dev.status', 'dev.prototype_status', 'dev.prototype_update', 'dev.sample_status', 'dev.sample_update', 'dev.validation_decide', 'dev.validation_update', 'dev.industrialization_status', 'dev.industrialization_update'].includes(r.action)
        return (
          <li key={r.id} className="relative pb-6 last:pb-0">
            <span className="absolute -left-[34px] flex h-6 w-6 items-center justify-center rounded-full border-2 border-white bg-brand-100 text-brand-700 shadow-card"><Icon className="h-3 w-3" aria-hidden /></span>
            <div className="flex flex-wrap items-baseline gap-x-2">
              <p className="font-semibold">{ACTION_LABELS[r.action] ?? r.action}{typeof m.version === 'number' ? ` · v${m.version}` : ''}{typeof m.kind === 'string' && (r.action.startsWith('dev.validation')) ? ` · ${VALIDATION_KIND[m.kind as keyof typeof VALIDATION_KIND] ?? m.kind}` : ''}</p>
              <p className="text-xs text-ink-soft">par {r.actor_email ?? 'le système'} · {formatDateTime(r.created_at)}</p>
            </div>
            <div className="mt-1 space-y-0.5 text-xs text-ink-soft">
              {m.backward === true && <p className="font-medium text-warn-text">Retour en arrière</p>}
              {typeof m.reason === 'string' && m.reason && <p>Motif : {m.reason}</p>}
              {typeof m.comment === 'string' && m.comment && <p>« {m.comment} »</p>}
              {typeof m.feedback === 'string' && m.feedback && <p>Retour : {m.feedback}</p>}
              {typeof m.contact === 'string' && m.contact && <p>Contact : {m.contact}</p>}
              {typeof m.subject === 'string' && <p>{m.subject}</p>}
              {typeof m.description === 'string' && r.action.startsWith('dev.cost') && <p>{m.description}</p>}
              {typeof m.document === 'string' && <p>Document : {m.document}{typeof m.kind === 'string' ? ` (${label(DEV_DOC_KINDS, m.kind)})` : ''}</p>}
              {typeof m.tracking === 'string' && m.tracking && <p>Suivi : {m.tracking}</p>}
              {r.action === 'dev.validation_remind' && typeof m.reminder === 'number' && <p>Relance n° {m.reminder}</p>}
              {Array.isArray(m.toggled) && (m.toggled as { label: string; done: boolean }[]).map((t) => <p key={t.label}>{t.done ? '☑' : '☐'} {t.label}</p>)}
              {r.action === 'dev.create' && <p>{[after.code, after.name, after.due_date && `échéance ${day(after.due_date)}`].filter(Boolean).join(' · ')}</p>}
              {diff && Object.keys(after).filter((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null)).map((k) => (
                <p key={k}><span className="font-medium text-ink">{DEV_FIELD_LABELS[k] ?? k}</span> : <span className="text-danger-text line-through decoration-danger/50">{show(k, before[k], r.action)}</span> → <span className="text-success-text">{show(k, after[k], r.action)}</span></p>
              ))}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
