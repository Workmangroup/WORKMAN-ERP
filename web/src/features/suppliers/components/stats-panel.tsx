import { AlertTriangle, CalendarClock, Clock, ShoppingCart, Wallet } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { PO_STATUS } from '@/lib/suppliers/options'
import type { PurchaseOrder, PurchaseStats } from '../types'

const money = (n: number | string, cur: string) => `${Number(n).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} ${cur}`
const monthLabel = (m: string) => new Date(m + '-01T12:00:00').toLocaleDateString('fr-FR', { month: 'short' })

function Kpi({ icon: Icon, label, value, hint, tone = 'default' }: { icon: React.ElementType; label: string; value: React.ReactNode; hint?: string; tone?: 'default' | 'success' | 'warning' | 'danger' }) {
  const color = { default: 'text-brand-600', success: 'text-success-text', warning: 'text-warn-text', danger: 'text-danger-text' }[tone]
  return (
    <div className="rounded-md border border-line bg-white p-4 shadow-card">
      <p className="flex items-center gap-2 text-xs font-semibold uppercase text-ink-soft"><Icon className={`h-4 w-4 ${color}`} aria-hidden />{label}</p>
      <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-ink-soft">{hint}</p>}
    </div>
  )
}

/** Indicateurs d'achats d'un fournisseur (devise de référence du fournisseur pour l'affichage). */
export function StatsPanel({ stats, currency, leadTimeDays }: { stats: PurchaseStats; currency: string; leadTimeDays: number | null }) {
  const max = Math.max(1, ...stats.by_month.map((m) => Number(m.amount)))
  const leadTone = stats.avg_lead_days !== null && leadTimeDays !== null && stats.avg_lead_days > leadTimeDays ? 'warning' : 'default'
  const onTime = stats.on_time_rate
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi icon={Wallet} label="Total acheté" value={money(stats.total_amount, currency)} hint={`${stats.orders_count} commande(s) · moyenne ${money(stats.avg_order, currency)}`} />
        <Kpi icon={ShoppingCart} label="Commandes ouvertes" value={stats.open_orders} hint={stats.last_order ? `Dernière commande le ${new Date(stats.last_order).toLocaleDateString('fr-FR')}` : 'Aucune commande'} />
        <Kpi icon={CalendarClock} label="Livraison à l’heure" value={onTime === null ? '—' : `${onTime} %`} tone={onTime === null ? 'default' : onTime >= 90 ? 'success' : onTime >= 70 ? 'warning' : 'danger'} hint={`${stats.received_count} commande(s) reçue(s)`} />
        <Kpi icon={Clock} label="Délai moyen réel" value={stats.avg_lead_days === null ? '—' : `${stats.avg_lead_days} j`} tone={leadTone}
          hint={leadTimeDays !== null ? `Délai annoncé : ${leadTimeDays} j` : 'Délai annoncé non renseigné'} />
      </div>

      {stats.late_open > 0 && (
        <p className="flex items-center gap-2 rounded-md border border-danger/30 bg-danger-bg px-3 py-2 text-sm text-danger-text">
          <AlertTriangle className="h-4 w-4" aria-hidden /> {stats.late_open} commande(s) en cours dépassent la date de livraison prévue.
        </p>
      )}

      <Card>
        <CardHeader><CardTitle>Achats des 12 derniers mois</CardTitle></CardHeader>
        <CardContent>
          <div className="flex h-44 items-end gap-1.5 sm:gap-2" role="img" aria-label="Histogramme des montants achetés par mois">
            {stats.by_month.map((m) => (
              <div key={m.month} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1" title={`${m.month} : ${money(m.amount, currency)} (${m.count} commande(s))`}>
                <div className="w-full rounded-t-sm bg-brand-500/80 transition-colors hover:bg-brand-600" style={{ height: `${Math.max(Number(m.amount) > 0 ? 4 : 0, (Number(m.amount) / max) * 100)}%` }} />
                <span className="text-[10px] uppercase text-ink-soft">{monthLabel(m.month)}</span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-ink-faint">Les commandes annulées sont exclues. Les montants sont additionnés tels quels : ils supposent des commandes dans la devise du fournisseur.</p>
        </CardContent>
      </Card>
    </div>
  )
}

export function OrdersTable({ orders, supplierCurrency }: { orders: PurchaseOrder[]; supplierCurrency: string }) {
  if (orders.length === 0) return <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">Aucune commande d’achat pour ce fournisseur.</p>
  const date = (d: string | null) => (d ? new Date(d + 'T12:00:00').toLocaleDateString('fr-FR') : '—')
  return (
    <>
      <ul className="grid gap-3 md:hidden">
        {orders.map((o) => (
          <li key={o.id} className="rounded-md border border-line bg-white p-4 shadow-card">
            <div className="flex items-center justify-between gap-2"><span className="font-mono text-sm font-semibold">{o.po_no}</span><Badge tone={PO_STATUS[o.status].tone}>{PO_STATUS[o.status].label}</Badge></div>
            <p className="mt-1 text-sm">{money(o.total_amount, o.currency)}</p>
            <p className="text-xs text-ink-soft">Commandée le {date(o.order_date)} · prévue {date(o.expected_date)}{o.received_date ? ` · reçue ${date(o.received_date)}` : ''}</p>
          </li>
        ))}
      </ul>
      <div className="hidden overflow-x-auto rounded-md border border-line bg-white shadow-card md:block">
        <table className="w-full text-left text-sm">
          <thead className="bg-canvas text-xs uppercase text-ink-soft">
            <tr><th className="px-4 py-2 font-semibold">N°</th><th className="px-3 py-2 font-semibold">Statut</th><th className="px-3 py-2 font-semibold">Commandée</th><th className="px-3 py-2 font-semibold">Prévue</th><th className="px-3 py-2 font-semibold">Reçue</th><th className="px-4 py-2 text-right font-semibold">Montant</th></tr>
          </thead>
          <tbody>
            {orders.map((o) => {
              const late = o.expected_date && (o.status === 'sent' || o.status === 'partial') && new Date(o.expected_date + 'T23:59:59') < new Date()
              const lateReceipt = o.received_date && o.expected_date && o.received_date > o.expected_date
              return (
                <tr key={o.id} className="border-t border-line">
                  <td className="px-4 py-2.5 font-mono">{o.po_no}</td>
                  <td className="px-3 py-2.5"><Badge tone={PO_STATUS[o.status].tone}>{PO_STATUS[o.status].label}</Badge></td>
                  <td className="px-3 py-2.5 text-ink-soft">{date(o.order_date)}</td>
                  <td className={`px-3 py-2.5 ${late ? 'font-semibold text-danger-text' : 'text-ink-soft'}`}>{date(o.expected_date)}{late ? ' · en retard' : ''}</td>
                  <td className={`px-3 py-2.5 ${lateReceipt ? 'text-warn-text' : 'text-ink-soft'}`}>{date(o.received_date)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{money(o.total_amount, o.currency || supplierCurrency)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </>
  )
}
