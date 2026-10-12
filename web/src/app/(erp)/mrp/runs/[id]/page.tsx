import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { z } from 'zod'
import { Alert } from '@/components/ui/alert'
import { buttonVariants } from '@/components/ui/button'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { NeedsTable } from '@/features/mrp/components/needs-table'
import { AlertsTable, Kpi } from '@/features/mrp/components/mrp-widgets'
import { requestFromMrpAction } from '@/features/purchases/actions'
import { RpcButton } from '@/features/stock/components/rpc-button'
import { SuggestionsPanel } from '@/features/mrp/components/suggestions-panel'
import { getRun, runMaterials, runPegging, runSuggestions } from '@/features/mrp/services/mrp.service'
import type { PeggingRow } from '@/features/mrp/types'
import { formatQty } from '@/lib/bom/options'
import { P } from '@/lib/rbac/permissions'
import { cn, formatDateTime } from '@/lib/utils'

export const metadata: Metadata = { title: 'Simulation MRP' }

const TABS = [{ id: 'alerts', label: 'Alertes de rupture' }, { id: 'needs', label: 'Besoins' }, { id: 'purchases', label: 'Suggestions d’achat' }] as const

export default async function RunPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const ctx = await requirePermission(P.MRP_READ)
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const sp = await searchParams
  const run = await getRun(id)
  if (!run) notFound()
  const tab = TABS.find((t) => t.id === sp.tab)?.id ?? 'alerts'
  const costs = ctx.permissions.includes(P.COSTS_READ)
  const canWrite = ctx.permissions.includes(P.MRP_WRITE)
  const mats = await runMaterials(id)
  const sugg = tab === 'purchases' ? await runSuggestions(id) : []
  const pegging: Record<string, PeggingRow[]> = {}
  if (tab === 'needs') await Promise.all(mats.filter((m) => m.gross > 0).slice(0, 60).map(async (m) => { pegging[m.material_id] = await runPegging(id, m.material_id) }))
  const s = run.summary
  const p = run.params

  return (
    <>
      <PageHeader title={`${run.code} — ${run.name}`} description={`Calculée le ${formatDateTime(run.created_at)} · horizon ${p.horizon_days} j · production ${p.offset_days} j avant livraison`}
        actions={<Link href="/mrp/runs" className={buttonVariants({ variant: 'command', size: 'sm' })}><ArrowLeft className="h-4 w-4" /> Simulations</Link>} />
      <div className="space-y-4 p-4 sm:p-6">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Kpi label="Ruptures imminentes" value={String(s.critical)} tone={s.critical ? 'danger' : 'success'} />
          <Kpi label="Ruptures prévues" value={String(s.high)} tone={s.high ? 'warning' : 'success'} />
          <Kpi label="Sous la sécurité" value={String(s.low)} />
          <Kpi label="Composants" value={String(s.materials)} />
          <Kpi label="Suggestions" value={String(s.suggestions)} hint={`${s.late_suggestions} en retard`} tone={s.late_suggestions ? 'warning' : undefined} />
        </div>
        <p className="text-xs text-ink-soft">
          Demande : {s.orders_lines} ligne(s) de commande{p.include_forecasts ? ` + ${s.forecast_lines} prévision(s)` : ' (sans prévisions)'}{p.include_draft_orders ? ', brouillons inclus' : ''} · {p.use_safety ? 'stock de sécurité maintenu' : 'sans stock de sécurité'} · délai par défaut {p.default_lead_days} j.
        </p>
        {s.warnings.length > 0 && <Alert tone="warning">Nomenclature manquante ou incomplète pour : {s.warnings.map((w) => `${w.ref} (${formatQty(w.qty)} pce)`).join(', ')}. Leurs besoins ne sont pas calculés.</Alert>}

        <nav aria-label="Sections de la simulation" className="-mx-4 flex gap-1 overflow-x-auto border-b border-line px-4 sm:mx-0 sm:px-0">
          {TABS.map((t) => (
            <Link key={t.id} href={`/mrp/runs/${id}?tab=${t.id}`} aria-current={tab === t.id ? 'page' : undefined}
              className={cn('-mb-px whitespace-nowrap border-b-2 px-4 py-2 text-sm', tab === t.id ? 'border-brand-500 font-semibold text-brand-700' : 'border-transparent text-ink-soft hover:text-ink')}>{t.label}</Link>
          ))}
        </nav>

        {tab === 'alerts' && <AlertsTable rows={mats} asOf={run.as_of} costs={costs} />}
        {tab === 'needs' && <NeedsTable rows={mats} asOf={run.as_of} pegging={pegging} />}
        {tab === 'purchases' && (ctx.permissions.includes(P.PURCHASES_REQUEST) || ctx.permissions.includes(P.PURCHASES_WRITE)) && sugg.some((x) => x.status === 'accepted') && (
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-brand-200 bg-brand-50 p-3 text-sm">
            <span>{sugg.filter((x) => x.status === 'accepted').length} suggestion(s) acceptée(s) : créez une demande d’achat à valider.</span>
            <RpcButton action={requestFromMrpAction} fields={{ id: run.id }} size="sm">Créer la demande d’achat</RpcButton>
          </div>)}
        {tab === 'purchases' && <SuggestionsPanel rows={sugg} asOf={run.as_of} canWrite={canWrite} costs={costs} />}
      </div>
    </>
  )
}
