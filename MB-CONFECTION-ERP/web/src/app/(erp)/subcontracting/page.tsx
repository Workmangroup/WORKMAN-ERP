import type { Metadata } from 'next'
import Link from 'next/link'
import { AlertTriangle, Boxes, CalendarClock, Gauge, Plus, ShieldCheck, Timer, Wallet } from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { getDashboard } from '@/features/subcontracting/services/subcontracting.service'
import { MONTHS_FR, SERVICES, serviceLabel } from '@/lib/subcontracting/options'
import { formatMoney } from '@/lib/bom/options'
import { P } from '@/lib/rbac/permissions'
import { fmtDay } from '@/features/orders/status'

export const metadata: Metadata = { title: 'Sous-traitance' }

type Row = Record<string, unknown>
const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])

export default async function SubcontractingDashboard() {
  const ctx = await requirePermission(P.SUBCONTRACT_READ)
  const d = await getDashboard()
  const canWrite = ctx.permissions.includes(P.SUBCONTRACT_WRITE)
  if (!d) return <div className="p-6"><Alert tone="error">Tableau de bord indisponible.</Alert></div>
  const k = (d.kpi ?? {}) as Row
  const byService = arr<{ service: string; orders: number; received: number }>(d.by_service)
  const byMonth = arr<{ month: string; orders: number }>(d.by_month)
  const overdue = arr<{ id: string; code: string; subcontractor: string; service: string; due_date: string; days: number; qty: number; received: number }>(d.overdue)
  const pending = arr<{ id: string; order_id: string; code: string; receipt: number; qty: number; received_on: string }>(d.pending_qc)
  const costsByMonth = arr<{ month: string; amount: number }>(d.costs_by_month)
  const topSubs = arr<{ name: string; amount: number }>(d.top_subcontractors)
  const costsOn = k.cost_total !== undefined
  const maxS = Math.max(1, ...byService.map((s) => s.orders))
  const maxM = Math.max(1, ...byMonth.map((m) => m.orders))
  const maxC = Math.max(1, ...costsByMonth.map((m) => m.amount))
  const kpi = [
    { l: 'Commandes en cours', v: String(k.open ?? 0), sub: `${k.qty_in_progress ?? 0} pièce(s) attendues`, i: Boxes, t: '' },
    { l: 'En retard', v: String(k.overdue ?? 0), sub: 'retour dépassé', i: CalendarClock, t: Number(k.overdue) > 0 ? 'text-danger-text' : '' },
    { l: 'Retours à contrôler', v: String(k.pending_qc ?? 0), sub: `${k.unposted ?? 0} à entrer en stock`, i: ShieldCheck, t: Number(k.pending_qc) > 0 ? 'text-warn-text' : '' },
    { l: 'Ponctualité', v: k.on_time_rate === null || k.on_time_rate === undefined ? '—' : `${k.on_time_rate} %`, sub: 'commandes livrées dans les temps', i: Gauge, t: '' },
    { l: 'Taux de rejet', v: k.rejection_rate === null || k.rejection_rate === undefined ? '—' : `${k.rejection_rate} %`, sub: `${k.qty_accepted ?? 0} acceptée(s) sur ${k.qty_received ?? 0} reçue(s)`, i: Gauge, t: Number(k.rejection_rate) > 5 ? 'text-warn-text' : '' },
    { l: 'Délai moyen', v: k.avg_lead_days === null || k.avg_lead_days === undefined ? '—' : `${k.avg_lead_days} j`, sub: 'de l’envoi à la réception', i: Timer, t: '' },
    ...(costsOn ? [
      { l: 'Coût sous-traitance', v: formatMoney(Number(k.cost_total)), sub: 'prestations et transport', i: Wallet, t: '' },
      { l: 'Coût par pièce', v: k.cost_per_piece === null || k.cost_per_piece === undefined ? '—' : formatMoney(Number(k.cost_per_piece)), sub: 'sur les pièces acceptées', i: Wallet, t: '' },
    ] : []),
  ]
  return (
    <>
      <PageHeader title="Sous-traitance" description="Broderie, sérigraphie, impression, lavage, finition : envois, retours, contrôle qualité, délais et coûts."
        actions={canWrite && <Link href="/subcontracting/orders/new" className={buttonVariants({ variant: 'command', size: 'sm' })}><Plus className="h-4 w-4" /> Nouvelle commande</Link>} />
      <div className="space-y-4 p-4 sm:p-6">
        {Number(k.overdue) > 0 && <Alert tone="warning"><AlertTriangle className="mr-1 inline h-4 w-4" />{String(k.overdue)} commande(s) en retard de retour : relancez le sous-traitant.</Alert>}
        <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-5" aria-label="Indicateurs">
          {kpi.map((x) => (
            <li key={x.l} className="rounded-md border border-line bg-white p-3 shadow-card">
              <p className="flex items-center gap-1.5 text-xs text-ink-soft"><x.i className="h-3.5 w-3.5" aria-hidden />{x.l}</p>
              <p className={`mt-1 text-2xl font-semibold tabular-nums ${x.t}`}>{x.v}</p>
              <p className="text-xs text-ink-faint">{x.sub}</p>
            </li>
          ))}
        </ul>

        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader><CardTitle>Commandes en retard</CardTitle></CardHeader>
            <CardContent className="p-0">
              {overdue.length === 0 ? <p className="p-6 text-center text-sm text-ink-soft">Aucune commande en retard.</p> : (
                <table className="w-full text-sm"><thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Commande</th><th className="px-2 py-2 font-semibold">Sous-traitant</th><th className="px-2 py-2 font-semibold">Prestation</th><th className="px-2 py-2 text-right font-semibold">Reçu / total</th><th className="px-2 py-2 font-semibold">Retour prévu</th></tr></thead>
                  <tbody className="divide-y divide-line">{overdue.map((o) => (
                    <tr key={o.id}><td className="px-4 py-2"><Link href={`/subcontracting/orders/${o.id}`} className="font-mono font-semibold text-brand-700 hover:underline">{o.code}</Link></td><td className="px-2 py-2">{o.subcontractor}</td><td className="px-2 py-2">{serviceLabel(o.service)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{o.received} / {o.qty}</td><td className="px-2 py-2 text-danger-text">{fmtDay(o.due_date)} <Badge tone="danger">{o.days} j</Badge></td></tr>
                  ))}</tbody></table>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Retours à contrôler</CardTitle></CardHeader>
            <CardContent>
              {pending.length === 0 ? <p className="text-sm text-ink-soft">Aucun retour en attente de contrôle.</p> : (
                <ul className="space-y-2 text-sm">{pending.map((p) => <li key={p.id} className="flex items-center justify-between gap-2"><Link href={`/subcontracting/orders/${p.order_id}`} className="font-mono font-semibold text-brand-700 hover:underline">{p.code} #{p.receipt}</Link><span className="text-ink-soft">{p.qty} pièce(s) · {fmtDay(p.received_on)}</span></li>)}</ul>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          <Card>
            <CardHeader><CardTitle>Commandes par prestation</CardTitle></CardHeader>
            <CardContent>
              <ul className="space-y-2">
                {SERVICES.map((sv) => { const r = byService.find((x) => x.service === sv.value); const n = r?.orders ?? 0; return (
                  <li key={sv.value} className="flex items-center gap-3 text-sm"><span className="w-28 shrink-0">{sv.label}</span><div className="h-4 flex-1 overflow-hidden rounded-sm bg-canvas" role="img" aria-label={`${n} commande(s)`}><div className="h-full bg-brand-500" style={{ width: `${(100 * n) / maxS}%` }} /></div><span className="w-16 text-right tabular-nums">{n} · {r?.received ?? 0} p.</span></li>
                ) })}
              </ul>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Commandes créées (6 mois)</CardTitle></CardHeader>
            <CardContent>
              <ul className="flex h-36 items-end gap-2" aria-label="Commandes par mois">
                {byMonth.map((m) => (
                  <li key={m.month} className="flex flex-1 flex-col items-center justify-end gap-1">
                    <span className="text-xs font-semibold tabular-nums">{m.orders}</span>
                    <div className="w-full rounded-t-sm bg-brand-500" style={{ height: `${Math.max(4, (100 * m.orders) / maxM)}%` }} />
                    <span className="text-[11px] text-ink-soft">{MONTHS_FR[Number(m.month.slice(5)) - 1]}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
          {costsOn ? (
            <Card>
              <CardHeader><CardTitle>Coûts (6 mois)</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <ul className="flex h-28 items-end gap-2" aria-label="Coûts par mois">
                  {costsByMonth.map((m) => (
                    <li key={m.month} className="flex flex-1 flex-col items-center justify-end gap-1">
                      <span className="text-[10px] tabular-nums">{Math.round(m.amount)}</span>
                      <div className="w-full rounded-t-sm bg-warn/70" style={{ height: `${Math.max(3, (100 * m.amount) / maxC)}%` }} />
                      <span className="text-[11px] text-ink-soft">{MONTHS_FR[Number(m.month.slice(5)) - 1]}</span>
                    </li>
                  ))}
                </ul>
                <div className="border-t border-line pt-2 text-sm"><p className="mb-1 text-xs font-semibold text-ink-soft">Principaux sous-traitants</p>
                  <ul className="space-y-1">{topSubs.map((s) => <li key={s.name} className="flex justify-between"><span>{s.name}</span><span className="tabular-nums">{formatMoney(s.amount)}</span></li>)}{topSubs.length === 0 && <li className="text-ink-soft">Aucun coût saisi.</li>}</ul></div>
              </CardContent>
            </Card>
          ) : (
            <Card><CardHeader><CardTitle>Coûts</CardTitle></CardHeader><CardContent><p className="text-sm text-ink-soft">Les coûts de sous-traitance sont réservés aux utilisateurs habilités.</p></CardContent></Card>
          )}
        </div>
      </div>
    </>
  )
}
