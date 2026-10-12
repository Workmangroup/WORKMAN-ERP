import Link from 'next/link'
import { AlertTriangle, CheckCircle2, Clock, OctagonAlert } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { formatMoney, formatQty, unitLabel } from '@/lib/bom/options'
import { cn } from '@/lib/utils'
import type { AlertLevel, RunMaterial, TimelinePoint } from '../types'

export const ALERT_INFO: Record<AlertLevel, { label: string; tone: 'danger' | 'warning' | 'brand'; hint: string }> = {
  critical: { label: 'Rupture imminente', tone: 'danger', hint: 'La rupture arrive avant la livraison possible d’une nouvelle commande' },
  high: { label: 'Rupture prévue', tone: 'warning', hint: 'Rupture prévue : commander avant la date limite' },
  low: { label: 'Sous le stock de sécurité', tone: 'brand', hint: 'Pas de rupture, mais le stock passe sous le seuil de sécurité' },
}

const ymd = (d: string) => d.slice(0, 10)
export const fmtDate = (d: string | null | undefined) => (d ? new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${ymd(d)}T00:00:00Z`)) : '—')
export const daysFrom = (asOf: string, d: string) => Math.round((Date.parse(`${ymd(d)}T00:00:00Z`) - Date.parse(`${ymd(asOf)}T00:00:00Z`)) / 86_400_000)

export function Kpi({ label, value, tone, hint }: { label: string; value: string; tone?: 'danger' | 'warning' | 'success'; hint?: string }) {
  return (
    <div className={cn('rounded-md border p-3 shadow-card', tone === 'danger' ? 'border-danger/40 bg-danger-bg' : tone === 'warning' ? 'border-warn/40 bg-warn-bg' : tone === 'success' ? 'border-success/30 bg-success-bg' : 'border-line bg-white')}>
      <p className="text-xs text-ink-soft">{label}</p>
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="text-[11px] text-ink-faint">{hint}</p>}
    </div>
  )
}

/** Courbe du stock projeté (avec achats suggérés) : zéro, stock de sécurité et dates des besoins. */
export function Projection({ timeline, safety, asOf }: { timeline: TimelinePoint[]; safety: number; asOf: string }) {
  if (timeline.length === 0) return null
  const W = 560, H = 140, PX = 36, PY = 14
  const xs = timeline.map((t) => daysFrom(asOf, t.date))
  const maxX = Math.max(...xs, 1)
  const ys = timeline.flatMap((t) => [t.projected, t.projected - t.planned]).concat([0, safety])
  const minY = Math.min(...ys), maxY = Math.max(...ys, 1)
  const sx = (d: number) => PX + (d / maxX) * (W - PX - 8)
  const sy = (v: number) => H - PY - ((v - minY) / (maxY - minY || 1)) * (H - 2 * PY)
  // escalier : le stock reste constant entre deux événements
  const pts: string[] = []
  timeline.forEach((t, i) => { const x = sx(xs[i]); if (i > 0) pts.push(`${x},${sy(timeline[i - 1].projected)}`); pts.push(`${x},${sy(t.projected - t.planned)}`); if (t.planned > 0) pts.push(`${x},${sy(t.projected)}`) })
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Stock projeté dans le temps" className="h-36 w-full max-w-xl">
      <line x1={PX} x2={W - 8} y1={sy(0)} y2={sy(0)} className="stroke-danger/60" strokeDasharray="4 3" />
      {safety > 0 && <line x1={PX} x2={W - 8} y1={sy(safety)} y2={sy(safety)} className="stroke-warn/70" strokeDasharray="2 3" />}
      <polyline points={pts.join(' ')} fill="none" className="stroke-brand-600" strokeWidth="2" />
      {timeline.map((t, i) => <g key={t.date}>
        <circle cx={sx(xs[i])} cy={sy(t.projected - t.planned)} r="3" className={t.projected - t.planned < 0 ? 'fill-danger' : 'fill-brand-600'} />
        {t.planned > 0 && <rect x={sx(xs[i]) - 3} y={sy(t.projected) - 3} width="6" height="6" className="fill-success" />}
      </g>)}
      <text x="4" y={sy(0) + 4} className="fill-ink-faint text-[9px]">0</text>
      {safety > 0 && <text x="4" y={sy(safety) + 3} className="fill-warn text-[9px]">sécu.</text>}
      <text x={W - 8} y={H - 2} textAnchor="end" className="fill-ink-faint text-[9px]">J+{maxX}</text>
      <text x={PX} y={H - 2} className="fill-ink-faint text-[9px]">J0</text>
    </svg>
  )
}

/** Tableau des alertes de rupture. */
export function AlertsTable({ rows, asOf, runId, costs }: { rows: RunMaterial[]; asOf: string; runId?: string; costs?: boolean }) {
  const list = rows.filter((r) => r.alert)
  if (list.length === 0) return <p className="flex items-center gap-2 rounded-md border border-success/30 bg-success-bg p-4 text-sm text-success-text"><CheckCircle2 className="h-4 w-4" /> Aucune alerte : les stocks, réceptions planifiées et stocks de sécurité couvrent les besoins de l’horizon.</p>
  return (
    <div className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
      <table className="w-full min-w-[56rem] text-sm">
        <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Alerte</th><th className="px-2 py-2 font-semibold">Composant</th><th className="px-2 py-2 text-right font-semibold">Disponible</th><th className="px-2 py-2 text-right font-semibold">Besoin brut</th><th className="px-2 py-2 font-semibold">Rupture le</th><th className="px-2 py-2 font-semibold">Commander avant</th><th className="px-2 py-2 text-right font-semibold">À commander</th>{costs && <th className="px-4 py-2 text-right font-semibold">Valeur</th>}</tr></thead>
        <tbody className="divide-y divide-line">
          {list.map((r) => {
            const a = ALERT_INFO[r.alert!]
            const firstSugg = r.timeline.find((t) => t.planned > 0)
            const release = firstSugg ? new Date(Date.parse(`${firstSugg.date.slice(0, 10)}T00:00:00Z`) - r.lead_time_days * 86_400_000).toISOString().slice(0, 10) : null
            return (
              <tr key={r.material_id} className={r.alert === 'critical' ? 'bg-danger-bg/40' : ''}>
                <td className="px-4 py-2"><Badge tone={a.tone} title={a.hint}>{r.alert === 'critical' ? <OctagonAlert className="mr-1 h-3 w-3" aria-hidden /> : r.alert === 'high' ? <AlertTriangle className="mr-1 h-3 w-3" aria-hidden /> : <Clock className="mr-1 h-3 w-3" aria-hidden />}{a.label}</Badge></td>
                <td className="px-2 py-2"><span className="font-medium">{r.name}</span><span className="ml-2 font-mono text-xs text-ink-faint">{r.code}</span>{r.supplier_name && <span className="block text-xs text-ink-soft">{r.supplier_name} · délai {r.lead_time_days} j</span>}</td>
                <td className="px-2 py-2 text-right tabular-nums">{formatQty(r.on_hand - r.reserved)} {unitLabel(r.unit)}</td>
                <td className="px-2 py-2 text-right tabular-nums">{formatQty(r.gross)}</td>
                <td className="whitespace-nowrap px-2 py-2">{r.shortage_date ? <>{fmtDate(r.shortage_date)}<span className="block text-xs text-ink-soft">dans {daysFrom(asOf, r.shortage_date)} j</span></> : <span className="text-ink-faint">—</span>}</td>
                <td className={cn('whitespace-nowrap px-2 py-2', release && release < asOf.slice(0, 10) && 'font-semibold text-danger-text')}>{release ? <>{fmtDate(release)}{release < asOf.slice(0, 10) && <span className="block text-xs">déjà dépassée</span>}</> : '—'}</td>
                <td className="px-2 py-2 text-right font-semibold tabular-nums">{formatQty(r.suggested)} {unitLabel(r.unit)}</td>
                {costs && <td className="px-4 py-2 text-right tabular-nums">{r.unit_cost === null ? '—' : formatMoney(r.unit_cost * r.suggested)}</td>}
              </tr>
            )
          })}
        </tbody>
      </table>
      {runId && <p className="border-t border-line px-4 py-2 text-xs text-ink-soft"><Link href={`/mrp/runs/${runId}?tab=needs`} className="text-brand-600 hover:underline">Voir le détail des besoins</Link></p>}
    </div>
  )
}
