'use client'

import Link from 'next/link'
import { DataTable, type ColumnDef, type RowAction } from '@/components/data/data-table'
import { Avatar, AlertBadge, Progress, StatusPill, type Tone } from '@/components/data/cells'
import { ORDER_STATUS, orderStatusLabel } from '@/lib/production/options'
import { Eye } from 'lucide-react'

export interface OrderRow {
  id: string
  number: string
  article: string
  article_ref: string
  status: string
  qty_good: number
  qty_planned: number
  work_center: string
  planned_end: string
  late_days: number
  owner: string
  closed: boolean
}

const TONE = (s: string): Tone => (ORDER_STATUS[s]?.tone ?? 'neutral') as Tone

const COLUMNS: ColumnDef<OrderRow>[] = [
  { id: 'number', label: 'Ordre', locked: true, value: (r) => r.number,
    render: (r) => <Link href={`/production/ordres/${r.id}`} className="font-mono text-xs font-semibold text-brand-700 hover:underline">{r.number}</Link> },
  { id: 'article', label: 'Article', value: (r) => r.article,
    render: (r) => <span><span className="font-mono text-[11px] text-ink-faint">{r.article_ref}</span> <span className="font-medium">{r.article}</span></span> },
  { id: 'progress', label: 'Avancement', value: (r) => r.qty_good, align: 'right', searchable: false,
    render: (r) => <Progress value={r.qty_good} max={r.qty_planned} label={`${r.qty_good} / ${r.qty_planned}`} /> },
  { id: 'status', label: 'Statut', filterable: true, value: (r) => orderStatusLabel(r.status),
    render: (r) => <StatusPill label={orderStatusLabel(r.status)} tone={TONE(r.status)} /> },
  { id: 'work_center', label: 'Poste', filterable: true, value: (r) => r.work_center || 'À affecter' },
  { id: 'planned_end', label: 'Fin prévue', value: (r) => r.planned_end, searchable: false },
  { id: 'owner', label: 'Responsable', filterable: true, value: (r) => r.owner || 'Non attribué',
    render: (r) => <Avatar name={r.owner} /> },
  { id: 'alerts', label: 'Alertes', align: 'right', searchable: false, value: (r) => r.late_days,
    render: (r) => r.late_days > 0 ? <AlertBadge severity="critical" text={`En retard de ${r.late_days} j`} /> : <span className="text-xs text-ink-faint">—</span> },
]

const ACTIONS: RowAction<OrderRow>[] = [
  { id: 'open', label: 'Ouvrir la fiche', icon: <Eye className="h-3.5 w-3.5" aria-hidden />, href: (r) => `/production/ordres/${r.id}` },
]

export function OrdersTable({ rows }: { rows: OrderRow[] }) {
  return (
    <DataTable<OrderRow>
      tableId="production-orders"
      title="Ordres de fabrication"
      rows={rows}
      columns={COLUMNS}
      rowKey={(r) => r.id}
      actions={ACTIONS}
      emptyText="Aucun ordre dans cette vue."
      exportName="ordres-de-fabrication"
    />
  )
}
