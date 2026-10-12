import type { Metadata } from 'next'
import Link from 'next/link'
import { AlertTriangle, ClipboardList, FileWarning } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { RunDialog } from '@/features/mrp/components/run-dialog'
import { AlertsTable, Kpi, fmtDate } from '@/features/mrp/components/mrp-widgets'
import { latestRun, runMaterials, runSuggestions } from '@/features/mrp/services/mrp.service'
import { formatMoney, formatQty } from '@/lib/bom/options'
import { P } from '@/lib/rbac/permissions'
import { formatDateTime } from '@/lib/utils'

export const metadata: Metadata = { title: 'MRP' }

export default async function MrpDashboard() {
  const ctx = await requirePermission(P.MRP_READ)
  const canWrite = ctx.permissions.includes(P.MRP_WRITE)
  const costs = ctx.permissions.includes(P.COSTS_READ)
  const run = await latestRun()
  const [mats, sugg] = run ? await Promise.all([runMaterials(run.id), runSuggestions(run.id)]) : [[], []]
  const s = run?.summary
  const open = sugg.filter((x) => x.status === 'proposed')
  const value = costs ? open.reduce((a, r) => a + (r.unit_cost === null ? 0 : r.unit_cost * r.qty), 0) : null
  // couverture : top des besoins bruts, part couverte par le stock disponible + réceptions
  const top = [...mats].filter((m) => m.gross > 0).sort((a, b) => b.gross - a.gross).slice(0, 8)

  return (
    <>
      <PageHeader title="MRP — Tableau de bord" description="Besoins en composants issus des commandes client, prévisions et nomenclatures validées, nets du stock disponible et du stock de sécurité."
        actions={<>
          {canWrite && <RunDialog />}
          {run && <Link href={`/mrp/runs/${run.id}?tab=purchases`} className={buttonVariants({ variant: 'command', size: 'sm' })}><ClipboardList className="h-4 w-4" /> Suggestions d’achat</Link>}
        </>} />
      <div className="space-y-5 p-4 sm:p-6">
        {!run || !s ? (
          <div className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center">
            <p className="font-semibold">Aucune simulation pour le moment</p>
            <p className="mx-auto mt-1 max-w-lg text-sm text-ink-soft">Le MRP lit les commandes client confirmées (menu Commandes), les prévisions, les nomenclatures validées (BOM) et le stock. Lancez une première simulation pour obtenir les besoins, les suggestions d’achat et les alertes de rupture.</p>
            {canWrite && <div className="mt-4 flex justify-center"><RunDialog /></div>}
          </div>
        ) : (
          <>
            <p className="text-sm text-ink-soft">Dernière simulation : <Link href={`/mrp/runs/${run.id}`} className="font-semibold text-brand-700 hover:underline">{run.code} — {run.name}</Link> · {formatDateTime(run.created_at)} · horizon {run.params.horizon_days} j · production {run.params.offset_days} j avant livraison</p>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
              <Kpi label="Ruptures imminentes" value={String(s.critical)} tone={s.critical > 0 ? 'danger' : 'success'} hint="avant livraison possible" />
              <Kpi label="Ruptures prévues" value={String(s.high)} tone={s.high > 0 ? 'warning' : 'success'} hint="commande encore possible" />
              <Kpi label="Sous le stock de sécurité" value={String(s.low)} />
              <Kpi label="Composants analysés" value={String(s.materials)} />
              <Kpi label="Achats à traiter" value={String(open.length)} hint={`${s.late_suggestions} en retard`} tone={s.late_suggestions > 0 ? 'warning' : undefined} />
              {value !== null ? <Kpi label="Valeur à commander" value={formatMoney(value)} hint="suggestions à traiter" /> : <Kpi label="Lignes de demande" value={String(s.orders_lines + s.forecast_lines)} hint={`${s.orders_lines} commandes · ${s.forecast_lines} prévisions`} />}
            </div>

            {s.warnings.length > 0 && (
              <div className="rounded-md border border-warn/40 bg-warn-bg p-4 text-sm text-warn-text">
                <p className="flex items-center gap-2 font-semibold"><FileWarning className="h-4 w-4" /> Demande non explosée : nomenclature manquante ou incomplète</p>
                <ul className="mt-2 list-inside list-disc text-xs">
                  {s.warnings.map((w) => <li key={w.article_id}><span className="font-mono font-semibold">{w.ref}</span> {w.name} — {formatQty(w.qty)} pièce(s) : {w.issue === 'no_bom' ? 'aucune BOM validée' : 'sous-ensemble non validé ou archivé'}. <Link href={`/bom/new?article=${w.article_id}`} className="underline">Créer / compléter la BOM</Link></li>)}
                </ul>
              </div>
            )}

            <section className="space-y-2">
              <h2 className="flex items-center gap-2 text-base font-semibold"><AlertTriangle className="h-4 w-4 text-warn-text" /> Alertes de rupture</h2>
              <AlertsTable rows={mats} asOf={run.as_of} runId={run.id} costs={costs} />
            </section>

            {top.length > 0 && (
              <section className="space-y-2">
                <h2 className="text-base font-semibold">Couverture des plus gros besoins</h2>
                <ul className="space-y-2 rounded-md border border-line bg-white p-4 shadow-card">
                  {top.map((m) => {
                    const cover = Math.max(0, m.on_hand - m.reserved) + m.receipts
                    const pct = Math.min(100, (cover / m.gross) * 100)
                    return (
                      <li key={m.material_id} className="grid grid-cols-[minmax(0,12rem)_1fr_auto] items-center gap-3 text-sm">
                        <span className="truncate">{m.name}</span>
                        <span className="h-2.5 overflow-hidden rounded-full bg-canvas" role="img" aria-label={`Couverture ${pct.toFixed(0)} %`}><span className={`block h-full ${pct >= 100 ? 'bg-success' : pct >= 50 ? 'bg-warn' : 'bg-danger'}`} style={{ width: `${pct}%` }} /></span>
                        <span className="w-44 text-right text-xs text-ink-soft tabular-nums">{formatQty(cover)} / {formatQty(m.gross)} {m.unit === 'pc' ? 'pce' : m.unit}{m.shortage_date ? <Badge tone="danger" className="ml-2">rupture {fmtDate(m.shortage_date)}</Badge> : null}</span>
                      </li>
                    )
                  })}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </>
  )
}
