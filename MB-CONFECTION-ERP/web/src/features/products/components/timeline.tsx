import { Archive, ArchiveRestore, CheckCircle2, Copy, FileCheck2, FilePlus2, ImageIcon, Link2, Pencil, PlusCircle, Star, Trash2, Unlink, type LucideIcon } from 'lucide-react'
import { ACTION_LABELS } from '@/lib/rbac/audit-labels'
import { DOC_KINDS, FAMILIES, PRODUCT_FIELD_LABELS, PRODUCT_STATUS, SECTION_LABELS, label } from '@/lib/products/options'
import { formatDateTime } from '@/lib/utils'
import type { AuditRow } from '@/features/rbac/types'

const ICONS: Record<string, LucideIcon> = {
  'product.create': PlusCircle, 'product.update': Pencil, 'product.delete': Trash2, 'product.spec_update': Pencil, 'product.version_new': FilePlus2,
  'product.version_validate': CheckCircle2, 'product.version_discard': Trash2, 'product.photo_add': ImageIcon, 'product.photo_delete': Trash2,
  'product.photo_main': Star, 'product.document_link': Link2, 'product.document_update': Pencil, 'product.document_unlink': Unlink,
  'product.cert_add': FileCheck2, 'product.cert_update': FileCheck2, 'product.cert_delete': Trash2,
  'product.duplicate': Copy, 'product.duplicated_from': Copy, 'product.archive': Archive, 'product.restore': ArchiveRestore,
}

const day = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? `${v.slice(8, 10)}/${v.slice(5, 7)}/${v.slice(0, 4)}` : String(v))
const show = (k: string, v: unknown) => {
  if (v === null || v === undefined || v === '') return '—'
  if (k === 'valid_until' || k === 'issued_on') return day(v)
  if (k === 'family') return label(FAMILIES, String(v))
  if (k === 'status') return PRODUCT_STATUS[v as keyof typeof PRODUCT_STATUS]?.label ?? String(v)
  const s = String(v)
  return s.length > 120 ? `${s.slice(0, 117)}…` : s
}
const CERT_FIELDS: Record<string, string> = { standard_code: 'Norme', label: 'Intitulé', cert_type: 'Type', class_level: 'Classe', certificate_no: 'N° de certificat', issuer: 'Organisme', issued_on: 'Émission', valid_until: 'Validité', status: 'Statut', ged_document_id: 'Justificatif', notes: 'Notes' }
const sectionSummary = (b: unknown, a: unknown) => {
  const n = (x: unknown) => (Array.isArray(x) ? x.length : x && typeof x === 'object' ? Object.keys(x as object).length : 0)
  return Array.isArray(a) || Array.isArray(b) ? `${n(b)} → ${n(a)}` : 'modifié'
}

/** Timeline des modifications du produit (audit_logs, entity_type = 'product'), du plus récent au plus ancien. */
export function ProductTimeline({ rows }: { rows: AuditRow[] }) {
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
              {typeof m.reason === 'string' && m.reason && <p>Motif : {m.reason}</p>}
              {typeof m.file_name === 'string' && <p>{m.file_name}</p>}
              {typeof m.document === 'string' && <p>Document : {m.document}{typeof m.kind === 'string' ? ` (${label(DOC_KINDS, m.kind)})` : ''}</p>}
              {typeof m.standard === 'string' && r.action !== 'product.cert_update' && <p>Norme : {m.standard}</p>}
              {typeof m.new_code === 'string' && <p>Copie créée : {m.new_code}</p>}
              {typeof m.source_code === 'string' && <p>Copié depuis {m.source_code}{typeof m.from_version === 'number' ? ` (v${m.from_version})` : ''}</p>}
              {r.action === 'product.spec_update' && Object.keys(after).map((k) => (
                <p key={k}><span className="font-medium text-ink">{SECTION_LABELS[k] ?? k}</span> : {sectionSummary(before[k], after[k])}</p>
              ))}
              {(r.action === 'product.update' || r.action === 'product.archive' || r.action === 'product.restore') && Object.keys(after).map((k) => (
                <p key={k}><span className="font-medium text-ink">{PRODUCT_FIELD_LABELS[k] ?? k}</span> :{' '}
                  <span className="text-danger-text line-through decoration-danger/50">{show(k, before[k])}</span> → <span className="text-success-text">{show(k, after[k])}</span>
                  {k === 'article_id' && (typeof m.article_to === 'string' || typeof m.article_from === 'string') ? ` (${String(m.article_from ?? '—')} → ${String(m.article_to ?? '—')})` : ''}</p>
              ))}
              {(r.action === 'product.cert_update' || r.action === 'product.document_update') && Object.keys(after).map((k) => (
                <p key={k}><span className="font-medium text-ink">{CERT_FIELDS[k] ?? k}</span> :{' '}
                  <span className="text-danger-text line-through decoration-danger/50">{show(k, before[k])}</span> → <span className="text-success-text">{show(k, after[k])}</span></p>
              ))}
              {r.action === 'product.cert_add' && <p>{[after.standard_code, after.class_level && `classe ${String(after.class_level)}`, after.certificate_no, after.valid_until && `valide jusqu’au ${day(after.valid_until)}`].filter(Boolean).join(' · ')}</p>}
              {r.action === 'product.cert_delete' && <p>{[before.standard_code, before.class_level && `classe ${String(before.class_level)}`, before.certificate_no].filter(Boolean).join(' · ')}</p>}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
