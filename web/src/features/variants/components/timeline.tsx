import { Barcode, Boxes, Download, Layers, Pencil, PlusCircle, Tag, Trash2, type LucideIcon } from 'lucide-react'
import { ACTION_LABELS } from '@/lib/rbac/audit-labels'
import { MOVE_LABELS, VARIANT_FIELD_LABELS } from '@/lib/variants/options'
import { formatDateTime } from '@/lib/utils'
import type { AuditRow } from '@/features/rbac/types'

const ICONS: Record<string, LucideIcon> = {
  'variant.add': PlusCircle, 'variant.update': Pencil, 'variant.delete': Trash2, 'variant.generate': Layers, 'variant.sync_spec': Download, 'variant.bulk_update': Tag,
  'variant.barcodes': Barcode, 'variant.stock_move': Boxes, 'variant.stock_reserve': Boxes, 'variant.stock_safety': Boxes,
}
const val = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'boolean' ? (v ? 'Oui' : 'Non') : String(v))

/** Chronologie des variantes d'un produit (audit_logs, entity_type = 'variant') : génération, prix, codes-barres, nomenclature, stock. */
export function VariantsTimeline({ rows }: { rows: AuditRow[] }) {
  if (rows.length === 0) return <p className="rounded-md border border-dashed border-line-strong p-8 text-center text-sm text-ink-soft">Aucun historique.</p>
  return (
    <ol className="relative border-l-2 border-line pl-6">
      {rows.map((r) => {
        const Icon = ICONS[r.action] ?? Pencil
        const m = r.metadata ?? {}
        const changes = Array.isArray(m.changes) ? (m.changes as { sku: string; field: string; from: unknown; to: unknown }[]) : []
        return (
          <li key={r.id} className="relative pb-5 last:pb-0">
            <span className="absolute -left-[34px] flex h-6 w-6 items-center justify-center rounded-full border-2 border-white bg-brand-100 text-brand-700 shadow-card"><Icon className="h-3 w-3" aria-hidden /></span>
            <div className="flex flex-wrap items-baseline gap-x-2"><p className="font-semibold">{ACTION_LABELS[r.action] ?? r.action}{typeof m.sku === 'string' ? ` · ${m.sku}` : ''}</p><p className="text-xs text-ink-soft">par {r.actor_email ?? 'le système'} · {formatDateTime(r.created_at)}</p></div>
            <div className="mt-1 space-y-0.5 text-xs text-ink-soft">
              {r.action === 'variant.generate' && <p>{String(m.created)} variante(s) créée(s) ({String(m.colors)} couleur(s) × {String(m.sizes)} taille(s) sélectionnées)</p>}
              {r.action === 'variant.sync_spec' && <p>{String(m.variants_created)} variante(s), {String(m.colors_created)} couleur(s), {String(m.sizes_created)} taille(s) créées</p>}
              {r.action === 'variant.barcodes' && <p>{String(m.assigned)} code(s)-barres EAN-13 attribué(s)</p>}
              {r.action === 'variant.bulk_update' && <><p>{String(m.count)} variante(s) modifiée(s)</p>{changes.slice(0, 12).map((c, i) => <p key={i}><span className="font-mono">{c.sku}</span> · <span className="font-medium text-ink">{VARIANT_FIELD_LABELS[c.field] ?? c.field}</span> : <span className="text-danger-text line-through decoration-danger/50">{val(c.from)}</span> → <span className="text-success-text">{val(c.to)}</span></p>)}{changes.length > 12 && <p>… et {changes.length - 12} autre(s) modification(s)</p>}</>}
              {r.action === 'variant.update' && Object.keys(r.after_data ?? {}).map((k) => <p key={k}><span className="font-medium text-ink">{VARIANT_FIELD_LABELS[k] ?? k}</span> : <span className="text-danger-text line-through decoration-danger/50">{val((r.before_data ?? {})[k])}</span> → <span className="text-success-text">{val((r.after_data ?? {})[k])}</span></p>)}
              {r.action === 'variant.stock_move' && <p>{typeof m.type === 'string' ? (MOVE_LABELS[m.type] ?? m.type) : ''} {m.qty !== undefined ? `${Number(m.qty) > 0 ? '+' : ''}${String(m.qty)}` : ''}{typeof m.warehouse === 'string' ? ` · ${m.warehouse}` : ''}{typeof m.from === 'string' ? ` · ${m.from} → ${String(m.to)}` : ''}{m.balance !== undefined ? ` · solde ${String(m.balance)}` : ''}{typeof m.reference === 'string' ? ` · ${m.reference}` : ''}{typeof m.reason === 'string' ? ` — ${m.reason}` : ''}</p>}
              {r.action === 'variant.stock_reserve' && <p>{Number(m.delta) > 0 ? '+' : ''}{String(m.delta)} · réservé {String(m.reserved)}</p>}
              {r.action === 'variant.stock_safety' && <p>{typeof m.warehouse === 'string' ? `${m.warehouse} : ` : ''}{val((r.before_data ?? {}).safety)} → {val((r.after_data ?? {}).safety)}</p>}
              {r.action === 'variant.delete' && <p>{val((r.before_data ?? {}).sku)}</p>}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
