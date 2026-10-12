import { Boxes, Building2, Layers, MapPin, Pencil, PlusCircle, ShieldCheck, ShieldOff, type LucideIcon } from 'lucide-react'
import { ACTION_LABELS } from '@/lib/rbac/audit-labels'
import { WAREHOUSE_FIELD_LABELS, kindLabel, roleLabel, zoneTypeLabel } from '@/lib/warehouses/options'
import { formatDateTime } from '@/lib/utils'
import type { AuditRow } from '@/features/rbac/types'

const ICONS: Record<string, LucideIcon> = {
  'warehouse.create': Building2, 'warehouse.update': Pencil, 'warehouse.zone_add': Layers, 'warehouse.zone_update': Pencil, 'warehouse.zone_archive': Layers,
  'warehouse.location_add': MapPin, 'warehouse.location_update': Pencil, 'warehouse.access_grant': ShieldCheck, 'warehouse.access_revoke': ShieldOff,
  'warehouse.archive': Boxes, 'warehouse.restore': Boxes,
}
const val = (k: string, v: unknown) => {
  if (v === null || v === undefined || v === '') return '—'
  if (k === 'kind') return kindLabel(String(v))
  if (k === 'zone_type' || k === 'type') return zoneTypeLabel(String(v))
  if (k === 'role') return roleLabel(String(v))
  return String(v)
}

/** Traçabilité d'un entrepôt : création, modifications, zones, emplacements, accès accordés et retirés (qui, quand, quel rôle). */
export function WarehouseTimeline({ rows }: { rows: AuditRow[] }) {
  if (rows.length === 0) return <p className="rounded-md border border-dashed border-line-strong p-8 text-center text-sm text-ink-soft">Aucun événement enregistré.</p>
  return (
    <ol className="relative border-l-2 border-line pl-6">
      {rows.map((r) => {
        const Icon = ICONS[r.action] ?? Pencil
        const m = r.metadata ?? {}
        const before = r.before_data ?? {}
        const after = r.after_data ?? {}
        return (
          <li key={r.id} className="relative pb-5 last:pb-0">
            <span className="absolute -left-[34px] flex h-6 w-6 items-center justify-center rounded-full border-2 border-white bg-brand-100 text-brand-700 shadow-card"><Icon className="h-3 w-3" aria-hidden /></span>
            <div className="flex flex-wrap items-baseline gap-x-2"><p className="font-semibold">{ACTION_LABELS[r.action] ?? r.action}</p><p className="text-xs text-ink-soft">par {r.actor_email ?? 'le système'} · {formatDateTime(r.created_at)}</p></div>
            <div className="mt-1 space-y-0.5 text-xs text-ink-soft">
              {r.action === 'warehouse.access_grant' && <p>{String(after.user ?? '')} · rôle {val('role', after.role)}</p>}
              {r.action === 'warehouse.access_revoke' && <p>{String(before.user ?? '')} · ancien rôle {val('role', before.role)}{typeof m.email === 'string' ? ` (${m.email})` : ''}</p>}
              {(r.action === 'warehouse.zone_add') && <p>Zone {String(after.zone ?? m.zone ?? '')} · {String(after.name ?? '')} · {val('type', after.type)}</p>}
              {(r.action === 'warehouse.zone_update' || r.action === 'warehouse.zone_archive') && Object.keys(after).map((k) => <p key={k}>{WAREHOUSE_FIELD_LABELS[k] ?? k} : <span className="line-through decoration-danger/50">{val(k, before[k])}</span> → <span className="text-success-text">{val(k, after[k])}</span></p>)}
              {r.action === 'warehouse.location_add' && <p>Emplacement {String(after.location ?? '')} · {String(after.name ?? '')}</p>}
              {r.action === 'warehouse.location_update' && Object.keys(after).map((k) => <p key={k}>{k} : <span className="line-through decoration-danger/50">{val(k, before[k])}</span> → <span className="text-success-text">{val(k, after[k])}</span></p>)}
              {r.action === 'warehouse.create' && <p>{String(after.code ?? (r.entity_label ?? ''))}</p>}
              {r.action === 'warehouse.update' && Object.keys(after).map((k) => <p key={k}>{WAREHOUSE_FIELD_LABELS[k] ?? k} : <span className="line-through decoration-danger/50">{val(k, before[k])}</span> → <span className="text-success-text">{val(k, after[k])}</span></p>)}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
