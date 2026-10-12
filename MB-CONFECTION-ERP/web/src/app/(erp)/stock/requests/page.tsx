import type { Metadata } from 'next'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { StockToolbar } from '@/features/stock/components/stock-toolbar'
import { NewRequestDialog, RequestActions, CancelMovementDialog } from '@/features/stock/components/requests-components'
import { listJournal, listLocationOptions, listRequests, requestHistory } from '@/features/stock/services/requests.service'
import { stockContext } from '@/features/stock/services/stock.service'
import { WarehouseTimeline } from '@/features/warehouses/components/timeline'
import { formatMoney, formatQty } from '@/lib/bom/options'
import { REQUEST_STATUS, kindLabel, kindTone } from '@/lib/stock/movement-kinds'
import { P } from '@/lib/rbac/permissions'
import { cn, formatDateTime } from '@/lib/utils'

export const metadata: Metadata = { title: 'Demandes et journal de stock' }

type SP = Partial<Record<'vue' | 'statut' | 'detail', string>>
const STATUSES = ['pending', 'posted', 'rejected', 'cancelled'] as const

const APPROVAL = ['Aucune validation', 'Validation niveau 1', 'Validation niveau 2']

export default async function StockRequestsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await requirePermission(P.STOCK_READ)
  const sp = await searchParams
  const vue = sp.vue === 'journal' ? 'journal' : 'demandes'
  const statut = (STATUSES as readonly string[]).includes(sp.statut ?? '') ? (sp.statut as string) : null
  const canWrite = ctx.permissions.includes(P.STOCK_WRITE)
  const canAdjust = ctx.permissions.includes(P.STOCK_ADJUST)
  const canApprove = ctx.permissions.includes(P.STOCK_APPROVE)
  const canApproveHigh = ctx.permissions.includes(P.STOCK_APPROVE_HIGH)
  const costs = ctx.permissions.includes(P.COSTS_READ)

  const [sc, locations, requests, journal, history] = await Promise.all([
    stockContext(ctx.permissions),
    listLocationOptions(),
    vue === 'demandes' ? listRequests(statut) : Promise.resolve([]),
    vue === 'journal' ? listJournal() : Promise.resolve([]),
    sp.detail && vue === 'demandes' ? requestHistory(sp.detail) : Promise.resolve([]),
  ])
  const wh = new Map(sc.warehouses.map((w) => [w.id, w]))
  const mat = new Map(sc.materials.map((m) => [m.id, m]))
  const tabHref = (v: string, extra: Record<string, string> = {}) => {
    const p = new URLSearchParams({ vue: v, ...extra })
    return `/stock/requests?${p.toString()}`
  }

  return (
    <>
      <PageHeader title="Demandes et journal de stock" description="Chaque mouvement est numéroté, validé selon son niveau de risque et tracé. Les annulations passent par une réversion."
        actions={(canWrite || canAdjust) && <NewRequestDialog materials={sc.materials} warehouses={sc.warehouses} locations={locations} />} />
      <div className="space-y-4 p-4 sm:p-6">
        <StockToolbar ctx={sc} />
        <nav aria-label="Vues du stock" className="-mx-4 flex gap-1 overflow-x-auto border-b border-line px-4 sm:mx-0 sm:px-0">
          {[{ v: 'demandes', l: 'Demandes et validations' }, { v: 'journal', l: 'Journal numéroté' }].map((t) => (
            <Link key={t.v} href={tabHref(t.v)} aria-current={vue === t.v ? 'page' : undefined}
              className={cn('-mb-px whitespace-nowrap border-b-2 px-4 py-2 text-sm', vue === t.v ? 'border-brand-500 font-semibold text-brand-700' : 'border-transparent text-ink-soft hover:text-ink')}>{t.l}</Link>
          ))}
        </nav>

        {vue === 'demandes' && (
          <>
            <div className="flex flex-wrap gap-2 text-sm">
              {[{ s: null, l: 'Toutes' }, ...STATUSES.map((s) => ({ s, l: REQUEST_STATUS[s].label }))].map((f) => (
                <Link key={f.l} href={tabHref('demandes', f.s ? { statut: f.s } : {})}
                  className={cn('rounded-full border px-3 py-1', statut === f.s ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-line bg-white text-ink-soft hover:text-ink')}>{f.l}</Link>
              ))}
            </div>
            {requests.length === 0 ? (
              <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">Aucune demande.</p>
            ) : (
              <div className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
                <table className="w-full min-w-[68rem] text-sm">
                  <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft">
                    <tr><th className="px-4 py-2 font-semibold">Demande</th><th className="px-2 py-2 font-semibold">Type</th><th className="px-2 py-2 font-semibold">Composant</th><th className="px-2 py-2 text-right font-semibold">Quantité</th><th className="px-2 py-2 font-semibold">Entrepôt</th>{costs && <th className="px-2 py-2 text-right font-semibold">Valeur</th>}<th className="px-2 py-2 font-semibold">Statut</th><th className="px-2 py-2 font-semibold">Validations</th><th className="px-2 py-2" /></tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {requests.map((r) => {
                      const m = mat.get(r.material_id)
                      const st = REQUEST_STATUS[r.status] ?? REQUEST_STATUS.pending
                      const awaitingLevel2 = Boolean(r.level1_at) && r.approval_level === 2
                      return (
                        <tr key={r.id} className="align-top">
                          <td className="whitespace-nowrap px-4 py-2"><span className="font-mono text-xs">{r.number}</span><span className="block text-xs text-ink-soft">{formatDateTime(r.requested_at)} · {r.requester}</span>
                            {r.movement_id && <span className="block font-mono text-[10px] text-ink-faint">posté</span>}
                            {r.reversal_of && <span className="block text-xs text-ink-soft">Annulation d’un mouvement</span>}</td>
                          <td className="px-2 py-2"><Badge tone={kindTone(r.kind)}>{kindLabel(r.kind)}</Badge></td>
                          <td className="px-2 py-2">{m ? <><span className="font-medium">{m.name}</span><span className="ml-2 font-mono text-xs text-ink-faint">{m.code}</span></> : '—'}
                            {r.reason && <span className="mt-1 block text-xs text-ink-soft">Motif : {r.reason}</span>}
                            {r.reference && <span className="block text-xs text-ink-soft">Réf. {r.reference}</span>}</td>
                          <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{formatQty(r.qty)} {m?.unit}</td>
                          <td className="px-2 py-2 text-xs">{wh.get(r.warehouse_id)?.code ?? '—'}{r.to_warehouse_id && <span className="block text-ink-soft">→ {wh.get(r.to_warehouse_id)?.code ?? '?'}</span>}</td>
                          {costs && <td className="px-2 py-2 text-right tabular-nums">{r.value ? formatMoney(r.value) : '—'}</td>}
                          <td className="px-2 py-2"><Badge tone={st.tone}>{st.label}</Badge>{r.decision_note && r.status !== 'pending' && <span className="mt-1 block text-xs text-ink-soft">{r.decision_note}</span>}</td>
                          <td className="px-2 py-2 text-xs text-ink-soft">
                            {r.approval_level === 0 ? 'Aucune' : <>{APPROVAL[r.approval_level]}{r.level1_name && <span className="block">1 : {r.level1_name}</span>}{r.level2_name && <span className="block">2 : {r.level2_name}</span>}</>}
                          </td>
                          <td className="px-2 py-2">
                            <div className="flex flex-col items-end gap-2">
                              <RequestActions id={r.id} status={r.status} requestedByMe={r.requested_by === ctx.profile.id} canApprove={canApprove} canApproveHigh={canApproveHigh} awaitingLevel2={awaitingLevel2} />
                              <Link href={tabHref('demandes', { ...(statut ? { statut } : {}), detail: r.id })} className="text-xs text-brand-700 hover:underline">Historique</Link>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {sp.detail && (
              <section className="rounded-md border border-line bg-white p-4 shadow-card" aria-label="Historique de la demande">
                <h2 className="mb-3 text-sm font-semibold">Historique de la demande</h2>
                <WarehouseTimeline rows={history} />
              </section>
            )}
          </>
        )}

        {vue === 'journal' && (
          journal.length === 0 ? (
            <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">Aucun mouvement enregistré.</p>
          ) : (
            <div className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
              <table className="w-full min-w-[60rem] text-sm">
                <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft">
                  <tr><th className="px-4 py-2 font-semibold">Numéro</th><th className="px-2 py-2 font-semibold">Type</th><th className="px-2 py-2 font-semibold">Composant</th><th className="px-2 py-2 text-right font-semibold">Quantité</th><th className="px-2 py-2 font-semibold">Entrepôt</th><th className="px-2 py-2 font-semibold">Référence</th><th className="px-2 py-2 font-semibold">Validé par</th><th className="px-2 py-2" /></tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {journal.map((j) => {
                    const sign = j.direction === 'in' ? '+' : j.direction === 'out' ? '−' : '⇄'
                    const cancellable = canWrite && !j.reversed && !j.reversal_of && j.kind !== 'annulation' && j.kind !== 'inventaire'
                    return (
                      <tr key={j.id} className={cn('align-top', j.reversed && 'text-ink-faint')}>
                        <td className="whitespace-nowrap px-4 py-2"><span className="font-mono text-xs">{j.number}</span><span className="block text-xs text-ink-soft">{formatDateTime(j.created_at)}</span></td>
                        <td className="px-2 py-2"><Badge tone={kindTone(j.kind)}>{kindLabel(j.kind)}</Badge>{j.reversed && <span className="mt-1 block text-xs text-ink-soft">Annulé</span>}{j.reversal_of && <span className="mt-1 block text-xs text-ink-soft">Réversion</span>}</td>
                        <td className="px-2 py-2">{j.material_name}<span className="ml-2 font-mono text-xs text-ink-faint">{j.material_code}</span></td>
                        <td className={cn('whitespace-nowrap px-2 py-2 text-right font-semibold tabular-nums', j.direction === 'in' ? 'text-success-text' : j.direction === 'out' ? 'text-danger-text' : '')}>{sign} {formatQty(j.qty)}</td>
                        <td className="px-2 py-2 text-xs">{j.warehouse_code}{j.to_warehouse_id && <span className="block text-ink-soft">→ {wh.get(j.to_warehouse_id)?.code ?? '?'}</span>}</td>
                        <td className="px-2 py-2 text-xs text-ink-soft">{j.reference ?? '—'}</td>
                        <td className="px-2 py-2 text-xs text-ink-soft">{j.approved_by ? 'Validé' : j.requested_by ? 'Direct' : '—'}</td>
                        <td className="px-2 py-2 text-right">{cancellable && <CancelMovementDialog movementId={j.id} number={j.number} />}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )
        )}
      </div>
    </>
  )
}
