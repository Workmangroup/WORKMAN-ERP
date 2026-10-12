import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { z } from 'zod'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { OrderActions, RescheduleDialog } from '@/features/production/components/production-forms'
import { getOrder, listLogs, listWorkCenters, orderHistory } from '@/features/production/services/production.service'
import { WarehouseTimeline } from '@/features/warehouses/components/timeline'
import { ORDER_STATUS, orderStatusLabel } from '@/lib/production/options'
import { P } from '@/lib/rbac/permissions'
import { formatDateTime } from '@/lib/utils'

export const metadata: Metadata = { title: 'Ordre de fabrication' }

const n = (v: number | null | undefined, unit = '') => (v === null || v === undefined ? '—' : `${v.toLocaleString('fr-FR', { maximumFractionDigits: 2 })}${unit ? ` ${unit}` : ''}`)

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePermission(P.PRODUCTION_READ)
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const o = await getOrder(id)
  if (!o) notFound()
  const canPlan = ctx.permissions.includes(P.PRODUCTION_PLAN)
  const canWrite = ctx.permissions.includes(P.PRODUCTION_WRITE)
  const [logs, history, workCenters] = await Promise.all([listLogs(id), orderHistory(id), canPlan ? listWorkCenters() : Promise.resolve([])])
  const today = new Date().toISOString().slice(0, 10)
  const remaining = o.qty_planned - o.qty_good - o.qty_scrap
  const open = !o.closed_at
  return (
    <>
      <PageHeader title={`${o.number} — ${o.article_name}`} description={`${o.article_ref} · ${o.qty_planned} pièce(s) · ${n(o.std_minutes_per_unit, 'min / pièce')}`}
        actions={<Link href="/production/ordres" className={buttonVariants({ variant: 'command', size: 'sm' })}><ArrowLeft className="h-4 w-4" /> Ordres</Link>} />
      <div className="space-y-4 p-4 sm:p-6">
        <div className="flex flex-wrap items-center gap-3">
          <Badge tone={ORDER_STATUS[o.status]?.tone ?? 'neutral'}>{orderStatusLabel(o.status)}</Badge>
          {o.closed_at && <Badge tone="neutral">Clôturé le {formatDateTime(o.closed_at)}</Badge>}
          {o.late_days > 0 && <Badge tone="danger">En retard de {o.late_days} j</Badge>}
          <span className="text-sm text-ink-soft">Poste : {o.work_center_code ?? 'à affecter'}</span>
        </div>
        {(canWrite || canPlan) && (
          <div className="flex flex-wrap items-center gap-2">
            {canWrite && <OrderActions id={id} status={o.status} closed={Boolean(o.closed_at)} today={today} remaining={Math.max(0, remaining)} />}
            {canPlan && open && o.status === 'planned' && (
              <RescheduleDialog orderId={id} qty={o.qty_planned} std={o.std_minutes_per_unit} start={o.planned_start} end={o.planned_end} workCenterId={o.work_center_id} workCenters={workCenters} />
            )}
            {canPlan && o.status === 'done' && open && <span className="text-xs text-ink-soft">La clôture verrouille l’ordre.</span>}
          </div>
        )}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[
            { l: 'Quantité bonne', v: `${n(o.qty_good)} / ${n(o.qty_planned)}` }, { l: 'Rebut', v: n(o.qty_scrap) },
            { l: 'Heures travaillées', v: n(o.hours_worked, 'h') }, { l: 'Heures planifiées', v: n(o.planned_hours, 'h') },
            { l: 'Rendement', v: o.yield_pct === null ? '—' : `${n(o.yield_pct)} %` }, { l: 'Productivité', v: n(o.productivity, 'pc / h') },
            { l: 'Début → fin prévue', v: `${o.planned_start} → ${o.planned_end}` }, { l: 'Retard', v: o.late_days > 0 ? `${o.late_days} j` : '—' },
          ].map((k) => <Card key={k.l}><CardContent className="p-3"><p className="text-xs text-ink-soft">{k.l}</p><p className="mt-1 font-semibold tabular-nums">{k.v}</p></CardContent></Card>)}
        </div>
        <Card>
          <CardHeader><CardTitle>Journal de suivi (immuable)</CardTitle></CardHeader>
          <CardContent className="p-0">
            {logs.length === 0 ? <p className="p-6 text-sm text-ink-soft">Aucune saisie.</p> : (
              <div className="overflow-x-auto"><table className="w-full min-w-[36rem] text-sm">
                <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Date</th><th className="px-2 py-2 text-right font-semibold">Heures</th><th className="px-2 py-2 text-right font-semibold">Bonne</th><th className="px-2 py-2 text-right font-semibold">Rebut</th><th className="px-2 py-2 font-semibold">Note</th></tr></thead>
                <tbody className="divide-y divide-line">{logs.map((l) => (
                  <tr key={l.id}><td className="px-4 py-2">{l.log_date}</td><td className="px-2 py-2 text-right tabular-nums">{n(l.hours)}</td><td className="px-2 py-2 text-right tabular-nums">{n(l.qty_good)}</td><td className="px-2 py-2 text-right tabular-nums">{n(l.qty_scrap)}</td><td className="px-2 py-2 text-ink-soft">{l.note ?? '—'}</td></tr>
                ))}</tbody>
              </table></div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Traçabilité de l’ordre</CardTitle></CardHeader>
          <CardContent><WarehouseTimeline rows={history} /></CardContent>
        </Card>
      </div>
    </>
  )
}
