import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PageHeader } from '@/components/layout/page-header'
import { requireAnyPermission } from '@/features/auth/guards'
import { getStats } from '@/features/purchases/services/purchases.service'
import { fmtDay } from '@/features/purchases/status'
import { formatMoney, formatQty, unitLabel } from '@/lib/bom/options'
import { P } from '@/lib/rbac/permissions'
import { cn } from '@/lib/utils'

export const metadata: Metadata = { title: 'Achats — statistiques' }

const Kpi = ({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'warning' | 'danger' | 'success' }) => (
  <div className={cn('rounded-md border p-3 shadow-card', tone === 'danger' ? 'border-danger/40 bg-danger-bg' : tone === 'warning' ? 'border-warn/40 bg-warn-bg' : tone === 'success' ? 'border-success/30 bg-success-bg' : 'border-line bg-white')}>
    <p className="text-xs text-ink-soft">{label}</p><p className="text-xl font-semibold tabular-nums">{value}</p>{hint && <p className="text-[11px] text-ink-faint">{hint}</p>}
  </div>
)
const pct = (v: number | null) => (v === null || v === undefined ? '—' : `${String(v).replace('.', ',')} %`)

export default async function PurchasesHome({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const ctx = await requireAnyPermission(P.PURCHASES_READ, P.PURCHASES_REQUEST)
  if (!ctx.permissions.includes(P.PURCHASES_READ)) redirect('/purchases/requests')
  const sp = await searchParams
  const st = await getStats(sp.from, sp.to)
  const max = Math.max(1, ...(st?.by_month ?? []).map((m) => Number(m.amount)))
  return (
    <>
      <PageHeader title="Achats — statistiques" description="Demande d’achat → validation → commande → réception : volumes, délais, ponctualité et retours." />
      <div className="space-y-5 p-4 sm:p-6">
        <form action="/purchases" className="flex flex-wrap items-end gap-3 rounded-md border border-line bg-white p-4 shadow-card">
          <div><Label htmlFor="from">Du</Label><Input id="from" name="from" type="date" defaultValue={sp.from ?? st?.period.from.slice(0, 10)} className="w-44" /></div>
          <div><Label htmlFor="to">Au</Label><Input id="to" name="to" type="date" defaultValue={sp.to ?? st?.period.to.slice(0, 10)} className="w-44" /></div>
          <Button type="submit">Appliquer</Button>
          {(sp.from || sp.to) && <Link href="/purchases" className="text-sm text-brand-600 hover:underline">12 derniers mois</Link>}
        </form>
        {!st ? <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">Statistiques indisponibles.</p> : (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Kpi label="Commandes passées" value={String(st.orders)} hint={`${formatMoney(st.avg_order)} en moyenne`} />
              <Kpi label="Montant commandé" value={formatMoney(st.amount)} />
              <Kpi label="En cours" value={`${st.open_count} · ${formatMoney(st.open_amount)}`} hint={st.late_open > 0 ? `${st.late_open} en retard` : 'aucune en retard'} tone={st.late_open > 0 ? 'danger' : undefined} />
              <Kpi label="Ponctualité fournisseurs" value={pct(st.on_time_rate)} hint={st.avg_delay_days !== null ? `retard moyen ${String(st.avg_delay_days).replace('.', ',')} j` : undefined} tone={st.on_time_rate !== null && st.on_time_rate < 80 ? 'warning' : undefined} />
              <Kpi label="Délai moyen commande → réception" value={st.avg_lead_days === null ? '—' : `${String(st.avg_lead_days).replace('.', ',')} j`} />
              <Kpi label="Valeur réceptionnée" value={formatMoney(st.received_amount)} />
              <Kpi label="Valeur retournée" value={formatMoney(st.returned_amount)} hint={`taux de retour ${pct(st.return_rate)}`} tone={st.return_rate !== null && st.return_rate > 5 ? 'warning' : undefined} />
              <Kpi label="Demandes à traiter" value={`${st.requests.submitted} à valider · ${st.requests.approved} à commander`} hint={st.requests.avg_approval_hours !== null ? `validation en ${String(st.requests.avg_approval_hours).replace('.', ',')} h en moyenne` : undefined} tone={st.requests.submitted > 0 ? 'warning' : undefined} />
            </div>

            <section className="space-y-2">
              <h2 className="text-base font-semibold">Montant commandé par mois</h2>
              <div className="rounded-md border border-line bg-white p-4 shadow-card">
                <ul className="flex h-40 items-end gap-1.5" aria-label="Montant commandé par mois">
                  {st.by_month.map((m) => (
                    <li key={m.month} className="flex h-full flex-1 flex-col items-center justify-end gap-1" title={`${m.month} : ${formatMoney(m.amount)} (${m.count} commande(s))`}>
                      <span className="w-full rounded-t-sm bg-brand-500" style={{ height: `${(Number(m.amount) / max) * 100}%`, minHeight: Number(m.amount) > 0 ? 3 : 0 }} />
                      <span className="text-[10px] text-ink-faint">{m.month.slice(5)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </section>

            <div className="grid gap-5 lg:grid-cols-2">
              <section className="space-y-2">
                <h2 className="text-base font-semibold">Principaux fournisseurs</h2>
                <div className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
                  <table className="w-full min-w-[28rem] text-sm">
                    <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Fournisseur</th><th className="px-2 py-2 text-right font-semibold">Cmd</th><th className="px-2 py-2 text-right font-semibold">Montant</th><th className="px-2 py-2 text-right font-semibold">À l’heure</th><th className="px-4 py-2 text-right font-semibold">Délai</th></tr></thead>
                    <tbody className="divide-y divide-line">
                      {st.by_supplier.length === 0 && <tr><td colSpan={5} className="p-6 text-center text-ink-soft">Aucune commande sur la période.</td></tr>}
                      {st.by_supplier.map((s) => <tr key={s.supplier_id}><td className="px-4 py-2"><Link href={`/suppliers/${s.supplier_id}`} className="font-medium text-brand-700 hover:underline">{s.name}</Link></td><td className="px-2 py-2 text-right tabular-nums">{s.orders}</td><td className="px-2 py-2 text-right tabular-nums">{formatMoney(s.amount)}</td><td className="px-2 py-2 text-right tabular-nums">{pct(s.on_time_rate)}</td><td className="px-4 py-2 text-right tabular-nums">{s.avg_lead_days === null ? '—' : `${String(s.avg_lead_days).replace('.', ',')} j`}</td></tr>)}
                    </tbody>
                  </table>
                </div>
              </section>
              <section className="space-y-2">
                <h2 className="text-base font-semibold">Composants les plus achetés</h2>
                <div className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
                  <table className="w-full min-w-[28rem] text-sm">
                    <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Composant</th><th className="px-2 py-2 text-right font-semibold">Quantité</th><th className="px-4 py-2 text-right font-semibold">Montant</th></tr></thead>
                    <tbody className="divide-y divide-line">
                      {st.top_materials.length === 0 && <tr><td colSpan={3} className="p-6 text-center text-ink-soft">Aucune ligne sur la période.</td></tr>}
                      {st.top_materials.map((m) => <tr key={m.material_id}><td className="px-4 py-2">{m.name}<span className="ml-2 font-mono text-xs text-ink-faint">{m.code}</span></td><td className="px-2 py-2 text-right tabular-nums">{formatQty(m.qty)} {unitLabel(m.unit)}</td><td className="px-4 py-2 text-right tabular-nums">{formatMoney(m.amount)}</td></tr>)}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>
            <p className="text-xs text-ink-soft">Période du {fmtDay(st.period.from)} au {fmtDay(st.period.to)} (commandes envoyées, partielles ou reçues ; les brouillons et annulations sont exclus).</p>
          </>
        )}
      </div>
    </>
  )
}
