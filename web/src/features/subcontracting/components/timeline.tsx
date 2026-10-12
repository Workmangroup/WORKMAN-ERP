import { Ban, CheckCircle2, FileText, PackageCheck, Pencil, PlusCircle, Send, ShieldCheck, Trash2, Truck, Warehouse, type LucideIcon } from 'lucide-react'
import { ACTION_LABELS } from '@/lib/rbac/audit-labels'
import { ORDER_STATUS, QC_STATUS, serviceLabel } from '@/lib/subcontracting/options'
import { formatDateTime } from '@/lib/utils'
import type { AuditRow } from '@/features/rbac/types'

const ICONS: Record<string, LucideIcon> = {
  'subcontractor.create': PlusCircle, 'subcontractor.update': Pencil, 'subcontractor.status': CheckCircle2, 'subcontract.create': PlusCircle, 'subcontract.update': Pencil,
  'subcontract.send': Send, 'subcontract.cancel': Ban, 'subcontract.shipment': Truck, 'subcontract.receipt': PackageCheck, 'subcontract.qc': ShieldCheck,
  'subcontract.stock': Warehouse, 'subcontract.close': CheckCircle2, 'subcontract.cost_add': FileText, 'subcontract.cost_update': FileText, 'subcontract.cost_delete': Trash2,
}
const statusLabel = (v: unknown) => ORDER_STATUS[String(v) as keyof typeof ORDER_STATUS]?.label ?? String(v)

/** Chronologie de la commande (audit_logs, entity_type = 'subcontract') : envois, retours, contrôles, stock, clôture. Sans montant. */
export function SubcontractTimeline({ rows }: { rows: AuditRow[] }) {
  if (rows.length === 0) return <p className="rounded-md border border-dashed border-line-strong p-8 text-center text-sm text-ink-soft">Aucun historique.</p>
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
              {typeof m.reason === 'string' && <p>Motif : {m.reason}</p>}
              {typeof m.notes === 'string' && m.notes && <p>{m.notes}</p>}
              {typeof m.tracking === 'string' && m.tracking && <p>Suivi : {m.tracking}</p>}
              {typeof m.due_date === 'string' && <p>Retour attendu le {m.due_date}</p>}
              {typeof m.service === 'string' && r.action === 'subcontract.create' && <p>{serviceLabel(m.service)} · {String(m.qty)} pièce(s)</p>}
              {r.action === 'subcontract.shipment' && <p>Envoi #{String(after.number)} · {String(after.qty)} pièce(s){typeof m.tracking === 'string' ? '' : ''}</p>}
              {r.action === 'subcontract.receipt' && <p>Retour #{String(m.receipt)} · {String(m.qty)} pièce(s)</p>}
              {r.action === 'subcontract.qc' && <p>Retour #{String(m.receipt)} : {QC_STATUS[String(m.result) as keyof typeof QC_STATUS]?.label ?? String(m.result)} · {String(after.accepted)} acceptée(s), {String(after.rejected)} rejetée(s){typeof m.notes === 'string' && m.notes ? ` — ${m.notes}` : ''}</p>}
              {r.action === 'subcontract.stock' && <p>Retour #{String(m.receipt)} · {String(after.qty ?? '')} pièce(s) entrée(s) en stock</p>}
              {r.action === 'subcontract.cost_add' || r.action === 'subcontract.cost_delete' ? <p>{String(m.kind ?? '')}{typeof m.description === 'string' ? ` · ${m.description}` : ''}</p> : null}
              {(r.action === 'subcontract.send' || r.action === 'subcontract.receipt' || r.action === 'subcontract.close' || r.action === 'subcontract.cancel') && typeof before.status === 'string' && typeof after.status === 'string' && (
                <p>Statut : <span className="line-through decoration-danger/50">{statusLabel(before.status)}</span> → <span className="text-success-text">{statusLabel(after.status)}</span></p>
              )}
              {r.action === 'subcontract.update' && Object.keys(after).map((k) => <p key={k}>{k} : <span className="line-through decoration-danger/50">{String(before[k] ?? '—')}</span> → <span className="text-success-text">{String(after[k] ?? '—')}</span></p>)}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
