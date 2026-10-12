import { Archive, ArchiveRestore, FilePlus2, FileX2, Pencil, PlusCircle, Trash2, UserPlus, UserX, type LucideIcon } from 'lucide-react'
import { ACTION_LABELS } from '@/lib/rbac/audit-labels'
import { PAYMENT_METHODS, countryName, label } from '@/lib/clients/options'
import { QUALIFICATIONS, SUPPLIER_CATEGORIES, SUPPLIER_DOC_TYPES, SUPPLIER_FIELD_LABELS } from '@/lib/suppliers/options'
import { formatDateTime } from '@/lib/utils'
import type { AuditRow } from '@/features/rbac/types'

const ICONS: Record<string, LucideIcon> = {
  'supplier.create': PlusCircle, 'supplier.update': Pencil, 'supplier.archive': Archive, 'supplier.restore': ArchiveRestore, 'supplier.delete': Trash2,
  'supplier.contact_create': UserPlus, 'supplier.contact_update': Pencil, 'supplier.contact_delete': UserX,
  'supplier.document_create': FilePlus2, 'supplier.document_update': Pencil, 'supplier.document_delete': FileX2,
}

export interface Resolvers {
  users: Map<string, { full_name: string }>
  terms: Map<string, { label: string }>
}

function show(key: string, value: unknown, r: Resolvers): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'boolean') return value ? 'Oui' : 'Non'
  const s = String(value)
  switch (key) {
    case 'country': return countryName(s)
    case 'buyer_id': return r.users.get(s)?.full_name ?? 'Utilisateur supprimé'
    case 'payment_terms_id': return r.terms.get(s)?.label ?? '—'
    case 'payment_method': return label(PAYMENT_METHODS, s)
    case 'category': return label(SUPPLIER_CATEGORIES, s)
    case 'qualification': return label(QUALIFICATIONS, s)
    case 'doc_type': return label(SUPPLIER_DOC_TYPES, s)
    case 'lead_time_days': return `${s} j`
    case 'size_bytes': return `${Math.round(Number(s) / 1024)} Ko`
    default: return s.length > 120 ? s.slice(0, 117) + '…' : s
  }
}

function Changes({ row, r }: { row: AuditRow; r: Resolvers }) {
  const before = row.before_data ?? {}
  const after = row.after_data ?? {}
  const isCreate = row.action.endsWith('_create') || row.action === 'supplier.create'
  const isDelete = row.action.endsWith('_delete') || row.action === 'supplier.delete'
  const keys = Object.keys(isDelete ? before : after).filter((k) => !['id', 'supplier_id', 'mime_type'].includes(k))
  const meta = row.metadata ?? {}
  const subject = (meta.contact ?? meta.document) as string | undefined
  const bag = isDelete ? before : after
  return (
    <div className="mt-1.5 space-y-1 text-xs text-ink-soft">
      {subject && <p className="text-sm text-ink">{subject}</p>}
      {typeof meta.reason === 'string' && meta.reason && <p>Motif : {meta.reason}</p>}
      {row.action === 'supplier.delete' && typeof meta.contacts === 'number' && <p>{String(meta.contacts)} contact(s), {String(meta.documents)} document(s) supprimés.</p>}
      {keys.length > 0 && !isCreate && !isDelete && (
        <ul className="space-y-0.5">
          {keys.map((k) => (
            <li key={k}><span className="font-medium text-ink">{SUPPLIER_FIELD_LABELS[k] ?? k}</span> :{' '}
              <span className="text-danger-text line-through decoration-danger/50">{show(k, before[k], r)}</span> → <span className="text-success-text">{show(k, after[k], r)}</span></li>
          ))}
        </ul>
      )}
      {keys.length > 0 && (isCreate || isDelete) && row.action !== 'supplier.delete' && (
        <details>
          <summary className="cursor-pointer text-brand-600 hover:underline">Détails</summary>
          <ul className="mt-1 space-y-0.5">
            {keys.filter((k) => bag[k] !== null && bag[k] !== '').map((k) => <li key={k}><span className="font-medium text-ink">{SUPPLIER_FIELD_LABELS[k] ?? k}</span> : {show(k, bag[k], r)}</li>)}
          </ul>
        </details>
      )}
    </div>
  )
}

export function SupplierHistory({ rows, resolvers }: { rows: AuditRow[]; resolvers: Resolvers }) {
  if (rows.length === 0) return <p className="rounded-md border border-dashed border-line-strong p-8 text-center text-sm text-ink-soft">Aucun historique.</p>
  return (
    <ol className="relative border-l-2 border-line pl-6">
      {rows.map((row) => {
        const Icon = ICONS[row.action] ?? Pencil
        return (
          <li key={row.id} className="relative pb-6 last:pb-0">
            <span className="absolute -left-[34px] flex h-6 w-6 items-center justify-center rounded-full border-2 border-white bg-brand-100 text-brand-700 shadow-card"><Icon className="h-3 w-3" aria-hidden /></span>
            <div className="flex flex-wrap items-baseline gap-x-2">
              <p className="font-semibold">{ACTION_LABELS[row.action] ?? row.action}</p>
              <p className="text-xs text-ink-soft">par {row.actor_email ?? 'le système'} · {formatDateTime(row.created_at)}</p>
            </div>
            <Changes row={row} r={resolvers} />
          </li>
        )
      })}
    </ol>
  )
}
