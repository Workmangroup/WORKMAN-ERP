import { Archive, ArchiveRestore, CheckCircle2, Copy, FilePlus2, Minus, Pencil, PlusCircle, Trash2, type LucideIcon } from 'lucide-react'
import { ACTION_LABELS } from '@/lib/rbac/audit-labels'
import { formatMinutes, formatMoney, formatPct, formatQty } from '@/lib/bom/options'
import { formatDateTime } from '@/lib/utils'
import type { AuditRow } from '@/features/rbac/types'

const ICONS: Record<string, LucideIcon> = {
  'bom.create': PlusCircle, 'bom.update': Pencil, 'bom.delete': Trash2, 'bom.duplicate': Copy, 'bom.archive': Archive, 'bom.restore': ArchiveRestore,
  'bom.line_add': PlusCircle, 'bom.line_update': Pencil, 'bom.line_delete': Minus, 'bom.op_add': PlusCircle, 'bom.op_update': Pencil, 'bom.op_delete': Minus,
  'bom.costing_update': Pencil, 'bom.version_new': FilePlus2, 'bom.version_validate': CheckCircle2, 'bom.version_discard': Trash2,
}
const n = (v: unknown) => (typeof v === 'number' || (typeof v === 'string' && v !== '' && !Number.isNaN(Number(v))) ? Number(v) : null)
const arrow = (b: string, a: string) => (
  <><span className="text-danger-text line-through decoration-danger/50">{b}</span> → <span className="text-success-text">{a}</span></>
)

export function BomHistory({ rows }: { rows: AuditRow[] }) {
  if (rows.length === 0) return <p className="rounded-md border border-dashed border-line-strong p-8 text-center text-sm text-ink-soft">Aucun historique.</p>
  return (
    <ol className="relative border-l-2 border-line pl-6">
      {rows.map((r) => {
        const Icon = ICONS[r.action] ?? Pencil
        const m = r.metadata ?? {}
        const b = r.before_data ?? {}
        const a = r.after_data ?? {}
        return (
          <li key={r.id} className="relative pb-6 last:pb-0">
            <span className="absolute -left-[34px] flex h-6 w-6 items-center justify-center rounded-full border-2 border-white bg-brand-100 text-brand-700 shadow-card"><Icon className="h-3 w-3" aria-hidden /></span>
            <div className="flex flex-wrap items-baseline gap-x-2">
              <p className="font-semibold">{ACTION_LABELS[r.action] ?? r.action}{typeof m.version === 'number' ? ` · v${m.version}` : ''}</p>
              <p className="text-xs text-ink-soft">par {r.actor_email ?? 'le système'} · {formatDateTime(r.created_at)}</p>
            </div>
            <div className="mt-1 space-y-0.5 text-xs text-ink-soft">
              {typeof m.component === 'string' && <p>{m.component}</p>}
              {typeof m.note === 'string' && m.note && <p>Note : {m.note}</p>}
              {typeof m.comment === 'string' && m.comment && <p>« {m.comment} »</p>}
              {typeof m.reason === 'string' && m.reason && <p>Motif : {m.reason}</p>}
              {typeof m.source_code === 'string' && <p>Copie de {m.source_code}{typeof m.source_version === 'number' ? ` (v${m.source_version})` : ''}</p>}
              {r.action === 'bom.line_add' && n(a.quantity) !== null && <p>Quantité : {formatQty(n(a.quantity))}{n(a.waste_pct) ? ` · perte ${formatPct(n(a.waste_pct))}` : ''}</p>}
              {r.action === 'bom.line_delete' && n(b.quantity) !== null && <p>Quantité retirée : {formatQty(n(b.quantity))}</p>}
              {r.action === 'bom.line_update' && <p>Quantité : {arrow(formatQty(n(b.quantity)), formatQty(n(a.quantity)))}{n(b.waste_pct) !== n(a.waste_pct) ? <> · perte {arrow(formatPct(n(b.waste_pct)), formatPct(n(a.waste_pct)))}</> : null}</p>}
              {r.action === 'bom.op_add' && <p>{String(a.name)} · {formatMinutes(n(a.minutes) ?? 0)}</p>}
              {r.action === 'bom.op_delete' && <p>{String(b.name)} · {formatMinutes(n(b.minutes) ?? 0)}</p>}
              {r.action === 'bom.op_update' && <p>{arrow(`${String(b.name)} · ${formatMinutes(n(b.minutes) ?? 0)}`, `${String(a.name)} · ${formatMinutes(n(a.minutes) ?? 0)}`)}</p>}
              {r.action === 'bom.costing_update' && <p>Taux horaire {arrow(formatMoney(n(b.hourly_rate)), formatMoney(n(a.hourly_rate)))} · frais généraux {arrow(formatPct(n(b.overhead_pct)), formatPct(n(a.overhead_pct)))}</p>}
              {r.action === 'bom.update' && Object.keys(a).map((k) => <p key={k}><span className="font-medium text-ink">{k === 'name' ? 'Nom' : k === 'description' ? 'Description' : k === 'article_id' ? 'Article' : k}</span> : {arrow(String(b[k] ?? '—').slice(0, 80), String(a[k] ?? '—').slice(0, 80))}</p>)}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
