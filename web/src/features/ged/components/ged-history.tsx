import {
  ArchiveRestore, CheckCircle2, FilePlus2, FolderInput, FolderPlus, History, MessageSquare, Pencil, Send, ShieldX, Trash2,
  Download, XCircle, type LucideIcon,
} from 'lucide-react'
import { ACTION_LABELS } from '@/lib/rbac/audit-labels'
import { humanSize } from '@/lib/ged/constants'
import { formatDateTime } from '@/lib/utils'
import type { AuditRow } from '@/features/rbac/types'

const ICONS: Record<string, LucideIcon> = {
  'ged.create': FilePlus2, 'ged.version_add': History, 'ged.update': Pencil, 'ged.move': FolderInput, 'ged.submit': Send,
  'ged.validate': CheckCircle2, 'ged.reject': XCircle, 'ged.invalidate': ShieldX, 'ged.trash': Trash2, 'ged.restore': ArchiveRestore,
  'ged.purge': Trash2, 'ged.comment_add': MessageSquare, 'ged.comment_delete': MessageSquare, 'ged.download': Download,
  'ged.folder_create': FolderPlus, 'ged.folder_rename': Pencil, 'ged.folder_delete': Trash2,
}
const LABELS: Record<string, string> = { title: 'Titre', description: 'Description', tags: 'Mots-clés', valid_until: 'Validité', folder: 'Dossier', name: 'Nom' }

const show = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : Array.isArray(v) ? (v.length ? v.join(', ') : '—') : String(v))

function Details({ row }: { row: AuditRow }) {
  const m = row.metadata ?? {}
  const before = row.before_data ?? {}
  const after = row.after_data ?? {}
  const keys = Object.keys(after)
  return (
    <div className="mt-1 space-y-0.5 text-xs text-ink-soft">
      {typeof m.version === 'number' && (
        <p>Version {m.version}{typeof m.file_name === 'string' ? ` · ${m.file_name}` : ''}{typeof m.size_bytes === 'number' ? ` · ${humanSize(m.size_bytes)}` : ''}</p>
      )}
      {typeof m.note === 'string' && m.note && <p>Note : {m.note}</p>}
      {typeof m.comment === 'string' && m.comment && <p>« {m.comment} »</p>}
      {typeof m.folder === 'string' && row.action === 'ged.create' && <p>Dossier : {m.folder}</p>}
      {typeof m.reason === 'string' && <p>Raison : {m.reason === 'retention' ? 'purge automatique (30 jours)' : m.reason === 'empty_trash' ? 'corbeille vidée' : 'suppression manuelle'}</p>}
      {keys.map((k) => (
        <p key={k}>
          <span className="font-medium text-ink">{LABELS[k] ?? k}</span> :{' '}
          <span className="text-danger-text line-through decoration-danger/50">{show(before[k])}</span> →{' '}
          <span className="text-success-text">{show(after[k])}</span>
        </p>
      ))}
    </div>
  )
}

export function GedHistory({ rows, showTitle = false }: { rows: AuditRow[]; showTitle?: boolean }) {
  if (rows.length === 0) return <p className="rounded-md border border-dashed border-line-strong p-8 text-center text-sm text-ink-soft">Aucune activité.</p>
  return (
    <ol className="relative border-l-2 border-line pl-6">
      {rows.map((r) => {
        const Icon = ICONS[r.action] ?? Pencil
        return (
          <li key={r.id} className="relative pb-5 last:pb-0">
            <span className="absolute -left-[34px] flex h-6 w-6 items-center justify-center rounded-full border-2 border-white bg-brand-100 text-brand-700 shadow-card">
              <Icon className="h-3 w-3" aria-hidden />
            </span>
            <div className="flex flex-wrap items-baseline gap-x-2">
              <p className="font-semibold">{ACTION_LABELS[r.action] ?? r.action}</p>
              {showTitle && r.entity_label && <p className="text-sm text-ink">« {r.entity_label} »</p>}
              <p className="text-xs text-ink-soft">par {r.actor_email ?? 'le système'} · {formatDateTime(r.created_at)}</p>
            </div>
            <Details row={r} />
          </li>
        )
      })}
    </ol>
  )
}
