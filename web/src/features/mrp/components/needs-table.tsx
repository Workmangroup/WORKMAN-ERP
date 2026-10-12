import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { MATERIAL_CATEGORIES, formatQty, label, unitLabel } from '@/lib/bom/options'
import { cn } from '@/lib/utils'
import type { PeggingRow, RunMaterial } from '../types'
import { ALERT_INFO, Projection, daysFrom, fmtDate } from './mrp-widgets'

/** Besoins par composant : brut → disponible → net → quantité à commander, avec projection datée et origine des besoins. */
export function NeedsTable({ rows, asOf, pegging }: { rows: RunMaterial[]; asOf: string; pegging: Record<string, PeggingRow[]> }) {
  if (rows.length === 0) return <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">Aucun besoin : aucune commande confirmée ni prévision sur l’horizon, ou aucune nomenclature validée.</p>
  return (
    <div className="space-y-2">
      <p className="text-xs text-ink-soft">Disponible = en stock − réservé. Besoin net = ce qu’il faut acheter pour couvrir le besoin brut et maintenir le stock de sécurité, avant arrondi (MOQ / multiple).</p>
      <div className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
        <table className="w-full min-w-[60rem] text-sm">
          <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft">
            <tr><th className="px-4 py-2 font-semibold">Composant</th><th className="px-2 py-2 text-right font-semibold">Besoin brut</th><th className="px-2 py-2 text-right font-semibold">En stock</th><th className="px-2 py-2 text-right font-semibold">Réservé</th><th className="px-2 py-2 text-right font-semibold">Sécurité</th><th className="px-2 py-2 text-right font-semibold">Réceptions</th><th className="px-2 py-2 text-right font-semibold">Besoin net</th><th className="px-2 py-2 text-right font-semibold">À commander</th><th className="px-4 py-2 font-semibold">État</th></tr>
          </thead>
          {rows.map((r) => (
            <tbody key={r.material_id} className="border-b border-line last:border-0">
              <tr className={cn(r.alert === 'critical' && 'bg-danger-bg/40')}>
                <td className="px-4 py-2"><span className="font-medium">{r.name}</span><span className="ml-2 font-mono text-xs text-ink-faint">{r.code}</span><span className="block text-xs text-ink-soft">{label(MATERIAL_CATEGORIES, r.category)}{r.first_need_date ? ` · 1er besoin le ${fmtDate(r.first_need_date)}` : ''}</span></td>
                <td className="px-2 py-2 text-right tabular-nums">{formatQty(r.gross)} {unitLabel(r.unit)}</td>
                <td className="px-2 py-2 text-right tabular-nums">{formatQty(r.on_hand)}</td>
                <td className="px-2 py-2 text-right tabular-nums text-ink-soft">{formatQty(r.reserved)}</td>
                <td className="px-2 py-2 text-right tabular-nums text-ink-soft">{formatQty(r.safety)}</td>
                <td className="px-2 py-2 text-right tabular-nums text-ink-soft">{formatQty(r.receipts)}</td>
                <td className="px-2 py-2 text-right tabular-nums">{formatQty(r.net)}</td>
                <td className="px-2 py-2 text-right font-semibold tabular-nums">{r.suggested > 0 ? formatQty(r.suggested) : '—'}</td>
                <td className="px-4 py-2">{r.alert ? <Badge tone={ALERT_INFO[r.alert].tone}>{ALERT_INFO[r.alert].label}</Badge> : <Badge tone="success">Couvert</Badge>}</td>
              </tr>
              <tr><td colSpan={9} className="px-4 pb-2">
                <details className="text-xs text-ink-soft">
                  <summary className="cursor-pointer text-brand-600">Projection et origine des besoins</summary>
                  <div className="mt-2 grid gap-4 lg:grid-cols-2">
                    <div>
                      <Projection timeline={r.timeline} safety={r.safety} asOf={asOf} />
                      <p className="mt-1">Délai {r.lead_time_days} j{r.moq > 0 ? ` · MOQ ${formatQty(r.moq)}` : ''}{r.order_multiple > 0 ? ` · multiple ${formatQty(r.order_multiple)}` : ''}{r.shortage_date ? ` · rupture le ${fmtDate(r.shortage_date)} (J+${daysFrom(asOf, r.shortage_date)})` : ''}</p>
                      <table className="mt-2 w-full max-w-md text-right tabular-nums">
                        <thead className="text-ink-faint"><tr><th className="text-left font-medium">Date</th><th className="font-medium">Besoin</th><th className="font-medium">Réception</th><th className="font-medium">Achat</th><th className="font-medium">Stock projeté</th></tr></thead>
                        <tbody>{r.timeline.map((t) => <tr key={t.date} className={t.projected - t.planned < 0 ? 'text-danger-text' : ''}><td className="text-left">{fmtDate(t.date)}</td><td>{t.gross ? formatQty(t.gross) : ''}</td><td>{t.receipts ? formatQty(t.receipts) : ''}</td><td className="font-semibold text-success-text">{t.planned ? `+${formatQty(t.planned)}` : ''}</td><td>{formatQty(t.projected)}</td></tr>)}</tbody>
                      </table>
                    </div>
                    <div>
                      <p className="mb-1 font-semibold text-ink">Origine du besoin brut</p>
                      {(pegging[r.material_id] ?? []).length === 0 ? <p>Aucun besoin lié (réassort du stock de sécurité).</p> : (
                        <table className="w-full text-right tabular-nums">
                          <thead className="text-ink-faint"><tr><th className="text-left font-medium">Source</th><th className="text-left font-medium">Article</th><th className="font-medium">Qté</th><th className="font-medium">Besoin le</th><th className="font-medium">{r.unit}</th></tr></thead>
                          <tbody>{(pegging[r.material_id] ?? []).map((p, i) => <tr key={i}><td className="text-left">{p.source_href ? <Link href={p.source_href} className="text-brand-600 hover:underline">{p.source_label}</Link> : p.source_label}</td><td className="text-left">{p.article_ref}</td><td>{formatQty(p.demand_qty)}</td><td>{fmtDate(p.need_date)}</td><td>{formatQty(p.qty)}</td></tr>)}</tbody>
                        </table>
                      )}
                    </div>
                  </div>
                </details>
              </td></tr>
            </tbody>
          ))}
        </table>
      </div>
    </div>
  )
}
