'use client'

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Info, OctagonAlert, RefreshCw } from 'lucide-react'
import Link from 'next/link'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { formatMoney } from '@/lib/bom/options'
import { refreshExecutiveAction } from '../actions'
import type { ExecutiveAlert, ExecutiveSnapshot } from '../types'
import { BarChart, Gauge, HBars, LineChart } from './charts'

const REFRESH_MS = 30_000
const PERIODS = [3, 6, 12, 24]
const STATUS_LABEL: Record<string, string> = {
  planned: 'Planifié', launched: 'Lancé', in_progress: 'En cours', suspended: 'Suspendu', done: 'Terminé',
  preparing: 'En préparation', picking: 'Prélèvement', packed: 'Colisée', shipped: 'Expédiée', delivered: 'Livrée', cancelled: 'Annulée',
}
const SEV_TONE: Record<string, 'danger' | 'warning' | 'brand'> = { critical: 'danger', warning: 'warning', info: 'brand' }
const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %`)
const num = (v: number | null | undefined, unit = '') => (v === null || v === undefined ? '—' : `${v.toLocaleString('fr-FR', { maximumFractionDigits: 1 })}${unit ? ` ${unit}` : ''}`)
const monthLabel = (m: string) => { const [y, mm] = m.split('-'); return `${mm}/${y.slice(2)}` }

export function ExecutiveLive({ initial, initialMonths }: { initial: ExecutiveSnapshot; initialMonths: number }) {
  const [snap, setSnap] = useState<ExecutiveSnapshot>(initial)
  const [months, setMonths] = useState(initialMonths)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [loaded, setLoaded] = useState(() => Date.now())

  const refresh = useCallback(async (m: number) => {
    const r = await refreshExecutiveAction(m)
    if (r.ok) { setSnap(r.data); setError(null); setLoaded(Date.now()) } else setError(r.message)
  }, [])

  // Temps réel : rafraîchissement toutes les 30 secondes, et à chaque changement de période.
  useEffect(() => {
    const id = setInterval(() => { void refresh(months) }, REFRESH_MS)
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => { clearInterval(id); clearInterval(tick) }
  }, [months, refresh])

  const changeMonths = (m: number) => { setMonths(m); void refresh(m) }
  const ago = Math.max(0, Math.round((now - loaded) / 1000))
  const a = snap.access
  const ca = snap.ca
  const marge = snap.marge
  const serie = ca?.series ?? []
  const detail = serie.find((s) => s.month === selected)
  const margeDetail = marge?.series.find((s) => s.month === selected)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2 text-sm">
          {PERIODS.map((p) => (
            <button key={p} type="button" onClick={() => changeMonths(p)} aria-pressed={months === p}
              className={`rounded-full border px-3 py-1 ${months === p ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-line bg-white text-ink-soft hover:text-ink'}`}>{p} mois</button>
          ))}
        </div>
        <div className="flex items-center gap-2 text-xs text-ink-soft" aria-live="polite">
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          Mise à jour il y a {ago} s · actualisation toutes les 30 s
          <button type="button" onClick={() => void refresh(months)} className="ml-2 rounded-md border border-line-strong px-2 py-0.5 hover:text-ink">Actualiser</button>
        </div>
      </div>
      {error && <p role="alert" className="rounded-md border border-danger/30 bg-danger-bg px-3 py-2 text-sm text-danger-text">{error}</p>}

      {/* Alertes stratégiques */}
      <section aria-label="Alertes stratégiques" className="space-y-2">
        {snap.alerts.length === 0 ? (
          <p className="rounded-md border border-success/30 bg-success-bg px-3 py-2 text-sm text-success-text">Aucune alerte stratégique.</p>
        ) : snap.alerts.map((al: ExecutiveAlert, i) => {
          const Icon = al.severity === 'critical' ? OctagonAlert : al.severity === 'warning' ? AlertTriangle : Info
          return (
            <Link key={i} href={al.link} className="flex items-start gap-3 rounded-md border border-line bg-white p-3 shadow-card hover:border-brand-400">
              <Icon className={`mt-0.5 h-4 w-4 ${al.severity === 'critical' ? 'text-danger-text' : al.severity === 'warning' ? 'text-warn-text' : 'text-brand-600'}`} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2"><span className="font-semibold">{al.title}</span><Badge tone={SEV_TONE[al.severity] ?? 'brand'}>{al.module}</Badge></span>
                <span className="block text-sm text-ink-soft">{al.detail}</span>
              </span>
            </Link>
          )
        })}
      </section>

      {/* Indicateurs clés */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-5">
        {[
          a.ca && { l: 'CA du mois', v: formatMoney(ca?.current_month ?? 0), s: `Mois précédent ${formatMoney(ca?.previous_month ?? 0)}` },
          a.marge && { l: 'Marge estimée du mois', v: pct(marge?.current_month_rate_pct ?? null), s: marge?.estimate ?? '' },
          a.stocks && { l: 'Produits finis en stock', v: num(snap.stocks?.finished_units), s: `Valeur ${formatMoney(snap.stocks?.finished_value ?? 0)}` },
          a.production && { l: 'Ordres ouverts', v: num(snap.production?.open), s: `${snap.production?.late ?? 0} en retard` },
          a.achats && { l: 'Commandes d’achat ouvertes', v: num(snap.achats?.open_orders), s: `${formatMoney(snap.achats?.open_value ?? 0)}` },
          a.finance && { l: 'Trésorerie', v: formatMoney(snap.finance?.treasury.balance ?? 0), s: `Créances échues ${formatMoney(snap.finance?.receivables_overdue ?? 0)}` },
          a.qualite && { l: 'Non-conformités ouvertes', v: num(snap.qualite?.nc_open), s: `${snap.qualite?.actions_overdue ?? 0} action(s) en retard` },
          a.expeditions && { l: 'Expéditions ouvertes', v: num(snap.expeditions?.open), s: `${snap.expeditions?.late_open ?? 0} en retard` },
          a.mrp && { l: 'Besoins MRP à commander', v: num(snap.mrp?.proposed), s: `${snap.mrp?.late ?? 0} en retard · ${snap.mrp?.run ?? ''}` },
        ].filter(Boolean).map((k) => k && (
          <Card key={k.l}><CardContent className="p-3"><p className="text-xs text-ink-soft">{k.l}</p><p className="mt-1 text-lg font-semibold tabular-nums">{k.v}</p><p className="truncate text-xs text-ink-soft">{k.s}</p></CardContent></Card>
        ))}
      </div>

      {/* CA et marge : graphique interactif */}
      {ca && (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader><CardTitle>Chiffre d’affaires mensuel</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <BarChart label="CA par mois" selected={selected} onSelect={(k) => setSelected(selected === k ? null : k)}
                data={serie.map((s) => ({ key: s.month, label: monthLabel(s.month), value: s.amount }))} />
              <p className="text-xs text-ink-soft">Cliquez sur un mois pour voir le détail{detail ? ` : ${monthLabel(detail.month)} — ${formatMoney(detail.amount)}${margeDetail ? `, marge estimée ${formatMoney(margeDetail.margin)}` : ''}` : '.'}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Indicateurs CA</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p className="flex justify-between"><span className="text-ink-soft">Cumul de l’année</span><span className="tabular-nums">{formatMoney(ca.ytd)}</span></p>
              <p className="flex justify-between"><span className="text-ink-soft">Solde client ouvert</span><span className="tabular-nums">{formatMoney(ca.open_balance)}</span></p>
              {marge && <p className="flex justify-between"><span className="text-ink-soft">Marge estimée (mois)</span><span className="tabular-nums">{pct(marge.current_month_rate_pct)}</span></p>}
            </CardContent>
          </Card>
        </div>
      )}

      {marge && (
        <Card>
          <CardHeader><CardTitle>Marge estimée par mois</CardTitle></CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full min-w-[32rem] text-sm">
              <thead className="border-b border-line text-left text-xs text-ink-soft"><tr><th className="py-2">Mois</th><th className="text-right">CA</th><th className="text-right">Achats fournisseurs</th><th className="text-right">Marge</th><th className="text-right">Taux</th></tr></thead>
              <tbody className="divide-y divide-line">{marge.series.map((s) => (
                <tr key={s.month} className={s.month === selected ? 'bg-brand-50' : ''} onClick={() => setSelected(s.month)}>
                  <td className="py-2">{monthLabel(s.month)}</td><td className="text-right tabular-nums">{formatMoney(s.revenue)}</td><td className="text-right tabular-nums">{formatMoney(s.cost)}</td>
                  <td className={`text-right tabular-nums ${s.margin < 0 ? 'text-danger-text' : ''}`}>{formatMoney(s.margin)}</td><td className="text-right tabular-nums">{pct(s.rate_pct)}</td>
                </tr>
              ))}</tbody>
            </table>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {a.finance && snap.finance && (
          <Card>
            <CardHeader><CardTitle>Trésorerie prévisionnelle (13 semaines)</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <LineChart label="Solde prévu par semaine" points={snap.finance.forecast.map((f) => ({ label: `S${f.week}`, value: f.balance }))} />
              <div className="grid grid-cols-3 gap-2 text-xs">
                <p>DSO : <span className="font-semibold">{num(snap.finance.dso_days, 'j')}</span></p>
                <p>Dettes 14 j : <span className="font-semibold">{formatMoney(snap.finance.payables_due_14d)}</span></p>
                <p>Relances : <span className="font-semibold">{snap.finance.reminders_pending}</span></p>
              </div>
            </CardContent>
          </Card>
        )}
        {a.production && snap.production && (
          <Card>
            <CardHeader><CardTitle>Production</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-3 gap-2">
                <Gauge value={snap.production.yield_pct} label="Rendement" />
                <div className="flex flex-col items-center justify-center text-center"><p className="text-xs text-ink-soft">Productivité</p><p className="text-lg font-semibold">{num(snap.production.productivity, 'pc/h')}</p></div>
                <div className="flex flex-col items-center justify-center text-center"><p className="text-xs text-ink-soft">Retards</p><p className={`text-lg font-semibold ${snap.production.late > 0 ? 'text-danger-text' : ''}`}>{snap.production.late}</p></div>
              </div>
              <HBars label="Charge atelier par poste (jours)" unit="j" items={snap.production.workload.map((w) => ({ label: `${w.code} ${w.name}`, value: w.load_days ?? 0, tone: w.overloaded ? 'danger' : 'brand' }))} />
            </CardContent>
          </Card>
        )}
        {a.qualite && snap.qualite && (
          <Card>
            <CardHeader><CardTitle>Qualité</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-2">
                <Gauge value={snap.qualite.action_effectiveness_pct} label="Efficacité des actions" />
                <div className="space-y-1 text-sm">
                  {Object.entries(snap.qualite.nc_by_severity ?? {}).map(([s, n]) => <p key={s} className="flex justify-between"><span className="text-ink-soft">NC {s}</span><span className="font-semibold">{n}</span></p>)}
                  <p className="flex justify-between"><span className="text-ink-soft">Actions en retard</span><span className="font-semibold">{snap.qualite.actions_overdue}</span></p>
                </div>
              </div>
              <HBars label="Défauts les plus fréquents" items={snap.qualite.pareto.map((p) => ({ label: `${p.code} ${p.label ?? ''}`, value: Number(p.qty) }))} />
            </CardContent>
          </Card>
        )}
        {a.expeditions && snap.expeditions && (
          <Card>
            <CardHeader><CardTitle>Expéditions</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-3 gap-2">
                <Gauge value={snap.expeditions.on_time_pct} label="Livraisons à temps" />
                <Gauge value={snap.expeditions.fill_rate_pct} label="Remplissage" />
                <div className="flex flex-col items-center justify-center text-center"><p className="text-xs text-ink-soft">Délai moyen</p><p className="text-lg font-semibold">{num(snap.expeditions.avg_lead_time_days, 'j')}</p></div>
              </div>
              <HBars label="Expéditions par statut" items={Object.entries(snap.expeditions.by_status ?? {}).map(([s, n]) => ({ label: STATUS_LABEL[s] ?? s, value: Number(n) }))} />
            </CardContent>
          </Card>
        )}
        {a.achats && snap.achats && (
          <Card>
            <CardHeader><CardTitle>Achats</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p className="flex justify-between"><span className="text-ink-soft">Commandes ouvertes</span><span className="font-semibold">{snap.achats.open_orders}</span></p>
              <p className="flex justify-between"><span className="text-ink-soft">Valeur ouverte</span><span className="tabular-nums">{formatMoney(snap.achats.open_value)}</span></p>
              <p className="flex justify-between"><span className="text-ink-soft">Commandes en retard</span><span className={`font-semibold ${snap.achats.late_orders > 0 ? 'text-danger-text' : ''}`}>{snap.achats.late_orders}</span></p>
              <p className="flex justify-between"><span className="text-ink-soft">Reçu ce mois</span><span className="tabular-nums">{formatMoney(snap.achats.received_this_month)}</span></p>
            </CardContent>
          </Card>
        )}
        {a.stocks && snap.stocks && (
          <Card>
            <CardHeader><CardTitle>Stocks</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p className="flex justify-between"><span className="text-ink-soft">Produits finis (unités)</span><span className="font-semibold">{snap.stocks.finished_units}</span></p>
              <p className="flex justify-between"><span className="text-ink-soft">Réservés</span><span>{snap.stocks.finished_reserved}</span></p>
              <p className="flex justify-between"><span className="text-ink-soft">Valeur produits finis</span><span className="tabular-nums">{formatMoney(snap.stocks.finished_value)}</span></p>
              <p className="flex justify-between"><span className="text-ink-soft">Matières en stock</span><span>{snap.stocks.raw_materials_in_stock} référence(s)</span></p>
            </CardContent>
          </Card>
        )}
        {a.mrp && snap.mrp && (
          <Card>
            <CardHeader><CardTitle>MRP</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p className="flex justify-between"><span className="text-ink-soft">Dernier calcul</span><span>{snap.mrp.run}</span></p>
              <p className="flex justify-between"><span className="text-ink-soft">Besoins à commander</span><span className="font-semibold">{snap.mrp.proposed}</span></p>
              <p className="flex justify-between"><span className="text-ink-soft">Dont en retard</span><span className={`font-semibold ${snap.mrp.late > 0 ? 'text-danger-text' : ''}`}>{snap.mrp.late}</span></p>
            </CardContent>
          </Card>
        )}
      </div>
      {!Object.values(a).some(Boolean) && <p className="text-sm text-ink-soft">Votre droit ne donne accès à aucun module.</p>}
    </div>
  )
}
