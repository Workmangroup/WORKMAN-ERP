import { AlertTriangle, TrendingDown, TrendingUp } from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatMoney, formatPct } from '@/lib/bom/options'
import { cn, formatDateTime } from '@/lib/utils'
import { costBreakdown, type TreeItem } from '../tree-model'
import type { CostResult, TreeNode } from '../types'

const BAR_TONE: Record<string, string> = { ops: 'bg-warn', overhead: 'bg-ink-faint' }

/** Coût matière / main-d'œuvre / revient, ventilation par catégorie, écart avec le coût figé à la validation. */
export function CostsPanel({ cost, root, node, status }: { cost: CostResult; root: TreeItem; node: TreeNode; status: 'draft' | 'validated' | 'obsolete' }) {
  const { live, frozen } = cost
  const breakdown = costBreakdown(root)
  const total = live.total || 1
  const delta = frozen ? live.total - frozen.total : null
  const deltaPct = frozen && frozen.total > 0 && delta !== null ? (delta / frozen.total) * 100 : null

  return (
    <div className="space-y-4">
      {live.missing.length > 0 && (
        <Alert tone="warning">Prix manquant pour : <strong>{live.missing.join(', ')}</strong>. Le coût ci-dessous est incomplet ; la validation sera refusée tant que ces prix ne sont pas renseignés (menu « Composants »).</Alert>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {([['Coût matière', live.material, 'Σ quantité × (1 + perte) × prix'], ['Coût main-d’œuvre', live.labor, `${live.minutes} min × ${formatMoney(node.hourly_rate)} / h`], ['Frais généraux', live.overhead, `${formatPct(node.overhead_pct)} de matière + main-d’œuvre`], ['Coût de revient', live.total, 'par pièce finie']] as const).map(([k, v, hint], i) => (
          <div key={k} className={cn('rounded-md border p-4 shadow-card', i === 3 ? 'border-brand-300 bg-brand-50' : 'border-line bg-white')}>
            <p className="text-xs text-ink-soft">{k}</p>
            <p className={cn('mt-1 tabular-nums', i === 3 ? 'text-2xl font-semibold text-brand-700' : 'text-xl font-semibold')}>{formatMoney(v)}</p>
            <p className="mt-1 text-[11px] text-ink-faint">{hint}</p>
          </div>
        ))}
      </div>

      {status === 'validated' && frozen && (
        <Card>
          <CardHeader><CardTitle>Coût figé à la validation</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>Coût de revient validé le {formatDateTime(frozen.frozen_at)} : <strong className="tabular-nums">{formatMoney(frozen.total)}</strong> (matière {formatMoney(frozen.material)} · main-d’œuvre {formatMoney(frozen.labor)} · frais généraux {formatMoney(frozen.overhead)}).</p>
            {delta !== null && Math.abs(delta) >= 0.005 ? (
              <p className={cn('flex items-center gap-1.5 font-medium', delta > 0 ? 'text-danger-text' : 'text-success-text')}>
                {delta > 0 ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
                Aux prix actuels : {delta > 0 ? '+' : ''}{formatMoney(delta)}{deltaPct !== null ? ` (${delta > 0 ? '+' : ''}${deltaPct.toFixed(1).replace('.', ',')} %)` : ''} par rapport au coût figé.
              </p>
            ) : <p className="text-success-text">Aux prix actuels, le coût est identique au coût figé.</p>}
            {delta !== null && Math.abs(delta) >= 0.005 && <p className="text-xs text-ink-soft">Les prix des composants ou une version de sous-ensemble ont changé depuis la validation. Créez une nouvelle version pour figer le nouveau coût.</p>}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle>Ventilation du coût de revient</CardTitle></CardHeader>
        <CardContent>
          {breakdown.length === 0 ? <p className="text-sm text-ink-soft">Aucun coût à ventiler.</p> : (
            <>
              <div className="mb-4 flex h-3 overflow-hidden rounded-full bg-canvas" role="img" aria-label="Répartition du coût de revient">
                {breakdown.map((b) => <span key={b.key} className={cn('h-full', BAR_TONE[b.key] ?? 'bg-brand-500')} style={{ width: `${(b.cost / total) * 100}%`, opacity: BAR_TONE[b.key] ? 1 : 0.35 + 0.65 * (b.cost / (breakdown[0]?.cost || 1)) }} title={`${b.label} : ${formatMoney(b.cost)}`} />)}
              </div>
              <ul className="space-y-2 text-sm">
                {breakdown.map((b) => (
                  <li key={b.key} className="flex items-center gap-3">
                    <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', BAR_TONE[b.key] ?? 'bg-brand-500')} />
                    <span className="flex-1">{b.label}</span>
                    <span className="w-14 text-right tabular-nums text-ink-soft">{((b.cost / total) * 100).toFixed(1).replace('.', ',')} %</span>
                    <span className="w-24 text-right font-medium tabular-nums">{formatMoney(b.cost)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </CardContent>
      </Card>

      <p className="flex items-start gap-2 text-xs text-ink-soft"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />Montants en euros, hors marge. Les sous-ensembles sont valorisés avec leur version validée (matière + main-d’œuvre) ; les frais généraux ne s’appliquent qu’une fois, au produit fini.</p>
    </div>
  )
}
