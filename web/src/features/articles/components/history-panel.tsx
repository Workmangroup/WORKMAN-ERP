import { CheckCircle2, FilePlus2, ImageIcon, Link2, Pencil, PlusCircle, Star, Trash2, Unlink, type LucideIcon } from 'lucide-react'
import { ACTION_LABELS } from '@/lib/rbac/audit-labels'
import { ARTICLE_FIELD_LABELS, ARTICLE_STATUS, FAMILIES, SPEC_SECTIONS, label } from '@/lib/articles/options'
import { formatDateTime } from '@/lib/utils'
import type { AuditRow } from '@/features/rbac/types'

const ICONS: Record<string, LucideIcon> = {
  'article.create': PlusCircle, 'article.update': Pencil, 'article.delete': Trash2, 'article.spec_update': Pencil, 'article.version_new': FilePlus2,
  'article.version_validate': CheckCircle2, 'article.version_discard': Trash2, 'article.photo_add': ImageIcon, 'article.photo_delete': Trash2,
  'article.photo_main': Star, 'article.document_link': Link2, 'article.document_unlink': Unlink,
}

const show = (k: string, v: unknown) => {
  if (v === null || v === undefined || v === '') return '—'
  if (k === 'family') return label(FAMILIES, String(v))
  if (k === 'status') return ARTICLE_STATUS[v as keyof typeof ARTICLE_STATUS]?.label ?? String(v)
  const s = String(v)
  return s.length > 120 ? s.slice(0, 117) + '…' : s
}
const sectionSummary = (k: string, b: unknown, a: unknown) => {
  const n = (x: unknown) => (Array.isArray(x) ? x.length : x && typeof x === 'object' ? Object.keys(x as object).length : 0)
  return Array.isArray(a) || Array.isArray(b) ? `${n(b)} → ${n(a)}` : 'modifié'
}

export function ArticleHistory({ rows }: { rows: AuditRow[] }) {
  if (rows.length === 0) return <p className="rounded-md border border-dashed border-line-strong p-8 text-center text-sm text-ink-soft">Aucun historique.</p>
  return (
    <ol className="relative border-l-2 border-line pl-6">
      {rows.map((r) => {
        const Icon = ICONS[r.action] ?? Pencil
        const m = r.metadata ?? {}
        const before = r.before_data ?? {}
        const after = r.after_data ?? {}
        return (
          <li key={r.id} className="relative pb-6 last:pb-0">
            <span className="absolute -left-[34px] flex h-6 w-6 items-center justify-center rounded-full border-2 border-white bg-brand-100 text-brand-700 shadow-card"><Icon className="h-3 w-3" aria-hidden /></span>
            <div className="flex flex-wrap items-baseline gap-x-2">
              <p className="font-semibold">{ACTION_LABELS[r.action] ?? r.action}{typeof m.version === 'number' ? ` · v${m.version}` : ''}</p>
              <p className="text-xs text-ink-soft">par {r.actor_email ?? 'le système'} · {formatDateTime(r.created_at)}</p>
            </div>
            <div className="mt-1 space-y-0.5 text-xs text-ink-soft">
              {typeof m.note === 'string' && m.note && <p>Note : {m.note}</p>}
              {typeof m.comment === 'string' && m.comment && <p>« {m.comment} »</p>}
              {typeof m.file_name === 'string' && <p>{m.file_name}</p>}
              {typeof m.document === 'string' && <p>Document : {m.document}</p>}
              {r.action === 'article.spec_update' && Object.keys(after).map((k) => (
                <p key={k}><span className="font-medium text-ink">{SPEC_SECTIONS[k] ?? k}</span> : {sectionSummary(k, before[k], after[k])}</p>
              ))}
              {(r.action === 'article.update') && Object.keys(after).map((k) => (
                <p key={k}><span className="font-medium text-ink">{ARTICLE_FIELD_LABELS[k] ?? k}</span> :{' '}
                  <span className="text-danger-text line-through decoration-danger/50">{show(k, before[k])}</span> → <span className="text-success-text">{show(k, after[k])}</span></p>
              ))}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
