import type { Metadata } from 'next'
import Link from 'next/link'
import { Plus } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { getAuthContext } from '@/features/auth/services/access.service'
import { OpportunityCreateForm, StageMoveForm } from '@/features/commercial/components/pipeline-forms'
import { getPipelineBoard, getPipelineSummary, type PipelineOpportunity } from '@/features/commercial/services/pipeline.service'
import { fmtDay, money } from '@/features/commercial/status'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'
import { cn } from '@/lib/utils'

export const metadata: Metadata = { title: 'Pipeline des opportunités' }

const STATUS_TONE = { open: 'brand', won: 'success', lost: 'danger' } as const
const STATUS_LABEL = { open: 'Ouverte', won: 'Gagnée', lost: 'Perdue' } as const

function Figure({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-ink-soft">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
      <p className="mt-1 text-xs text-ink-faint">{note}</p>
    </Card>
  )
}

export default async function OpportunityPipelinePage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const ctx = await requirePermission(P.OPPORTUNITIES_READ)
  const canWrite = ctx.permissions.includes(P.OPPORTUNITIES_WRITE)
  const sp = await searchParams
  const view = sp.view === 'liste' ? 'liste' : 'kanban'
  const year = new Date().getUTCFullYear()
  const [board, summary] = await Promise.all([getPipelineBoard(), getPipelineSummary(`${year}-01-01`, `${year}-12-31`)])
  const base = summary?.base_currency ?? 'EUR'
  const supabase = await createClient()
  const [{ data: clients }, { data: currencies }] = canWrite
    ? await Promise.all([
        supabase.from('clients').select('id,name').is('archived_at', null).order('name').limit(500),
        supabase.from('currencies').select('code').order('code'),
      ])
    : [{ data: [] }, { data: [] }]
  const today = new Date().toISOString().slice(0, 10)
  const stages = board.stages
  const unclassified = board.opportunities.filter((o) => o.stage === null)

  const card = (o: PipelineOpportunity) => {
    const late = o.status === 'open' && o.next_action_date && o.next_action_date < today
    return (
      <li key={o.id} className="rounded-md border border-line bg-white p-3 shadow-card">
        <p className="font-semibold text-ink">{o.name}</p>
        <p className="mt-1 text-sm font-semibold tabular-nums">{money(o.amount, o.currency ?? undefined)}</p>
        <p className="text-xs text-ink-soft">
          {o.currency ? '' : 'Devise non saisie · '}
          {o.probability_pct === null ? 'probabilité non saisie' : `${o.probability_pct} %`}
          {o.expected_close ? ` · attendu ${fmtDay(o.expected_close)}` : ''}
        </p>
        {o.next_action && <p className={cn('mt-1 text-xs', late ? 'font-semibold text-danger-text' : 'text-ink-soft')}>{late ? '⚠ ' : ''}{o.next_action}{o.next_action_date ? ` · ${fmtDay(o.next_action_date)}` : ''}</p>}
        <div className="mt-2 flex items-center justify-between gap-2">
          <Badge tone={STATUS_TONE[o.status]}>{STATUS_LABEL[o.status]}</Badge>
          {canWrite && o.status === 'open' && <StageMoveForm id={o.id} current={o.stage} stages={stages} />}
        </div>
      </li>
    )
  }

  return (
    <>
      <PageHeader
        title="Pipeline des opportunités"
        description="Trois chiffres distincts : pondéré (opportunités ouvertes × probabilité de l’étape, au taux validé), commandes (quantités), CA (factures émises moins avoirs)."
        actions={<Link href="/commercial/pipeline/prospects" className="text-sm font-semibold text-brand-700 underline">Pipeline des prospects</Link>}
      />
      <div className="space-y-4 p-4 sm:p-6">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Figure label="Pipeline pondéré" value={summary?.pipeline ? money(summary.pipeline.weighted, base) : '—'}
            note={summary?.pipeline ? `${summary.pipeline.open_count} ouverte(s) · exclues : ${summary.pipeline.excluded.no_probability} sans probabilité, ${summary.pipeline.excluded.no_currency} sans devise, ${summary.pipeline.excluded.no_rate} sans taux validé` : 'Accès non autorisé'} />
          <Figure label="Pipeline brut (mêmes opportunités)" value={summary?.pipeline ? money(summary.pipeline.gross, base) : '—'} note="Montants convertis, avant probabilité" />
          <Figure label={`Commandes confirmées ${year}`} value={summary?.orders ? `${summary.orders.confirmed_count}` : '—'} note={summary?.orders ? `${summary.orders.confirmed_qty} unité(s) commandée(s) · quantités, sans montant` : 'Accès non autorisé'} />
          <Figure label={`CA net HT ${year}`} value={summary?.revenue ? money(summary.revenue.net_ht, base) : '—'} note={summary?.revenue ? `${summary.revenue.invoices_counted} facture(s) comptée(s) · factures émises moins avoirs` : 'Accès non autorisé'} />
        </div>

        {canWrite && (
          <details className="rounded-md border border-line bg-white p-4 shadow-card">
            <summary className="cursor-pointer text-sm font-semibold text-brand-700"><Plus className="mr-1 inline h-4 w-4" />Nouvelle opportunité</summary>
            <div className="mt-3">
              <OpportunityCreateForm clients={(clients ?? []) as { id: string; name: string }[]} currencies={((currencies ?? []) as { code: string }[]).map((c) => c.code)} />
            </div>
          </details>
        )}

        <nav className="flex gap-2 text-sm" aria-label="Affichage">
          <Link href="/commercial/pipeline" className={cn('rounded-sm px-3 py-1', view === 'kanban' ? 'bg-brand-500 text-white' : 'border border-line')}>Kanban</Link>
          <Link href="/commercial/pipeline?view=liste" className={cn('rounded-sm px-3 py-1', view === 'liste' ? 'bg-brand-500 text-white' : 'border border-line')}>Liste</Link>
        </nav>

        {view === 'kanban' ? (
          <div className="overflow-x-auto">
            <div className="grid min-w-[72rem] grid-flow-col auto-cols-[minmax(14rem,1fr)] gap-3">
              {stages.map((s) => {
                const col = board.opportunities.filter((o) => o.stage === s.code)
                const sum = col.reduce((a, o) => a + (o.currency ? o.amount : 0), 0)
                return (
                  <section key={s.code} aria-label={s.label} className="rounded-md border border-line bg-canvas/60">
                    <header className="border-b border-line px-3 py-2">
                      <div className="flex items-center justify-between"><span className="text-sm font-semibold">{s.label}</span><span className="text-xs text-ink-soft">{col.length}</span></div>
                      <p className="mt-1 text-xs text-ink-soft tabular-nums">{s.probability_pct === null ? 'probabilité non saisie' : `${s.probability_pct} %`} · {money(sum, base)} (saisi, devise de l’opportunité)</p>
                    </header>
                    <ul className="space-y-2 p-2">{col.length === 0 ? <li className="p-3 text-center text-xs text-ink-faint">Aucune opportunité</li> : col.map(card)}</ul>
                  </section>
                )
              })}
              {unclassified.length > 0 && (
                <section aria-label="Sans étape" className="rounded-md border border-line bg-canvas/60">
                  <header className="border-b border-line px-3 py-2"><span className="text-sm font-semibold">Sans étape (anciennes)</span></header>
                  <ul className="space-y-2 p-2">{unclassified.map(card)}</ul>
                </section>
              )}
            </div>
          </div>
        ) : (
          <Card className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-ink-soft"><tr><th className="p-3">Opportunité</th><th className="p-3">Étape</th><th className="p-3">Montant</th><th className="p-3">Probabilité</th><th className="p-3">Date attendue</th><th className="p-3">Prochaine action</th><th className="p-3">Statut</th></tr></thead>
              <tbody>
                {board.opportunities.length === 0 ? (
                  <tr><td colSpan={7} className="p-4 text-ink-soft">Aucune opportunité visible.</td></tr>
                ) : board.opportunities.map((o) => (
                  <tr key={o.id} className="border-t border-line">
                    <td className="p-3 font-semibold">{o.name}</td>
                    <td className="p-3">{board.stages.find((s) => s.code === o.stage)?.label ?? '—'}</td>
                    <td className="p-3 tabular-nums">{o.currency ? money(o.amount, o.currency) : `${o.amount} (devise non saisie)`}</td>
                    <td className="p-3">{o.probability_pct === null ? '—' : `${o.probability_pct} %`}</td>
                    <td className="p-3">{fmtDay(o.expected_close)}</td>
                    <td className="p-3">{o.next_action ?? '—'}{o.next_action_date ? ` · ${fmtDay(o.next_action_date)}` : ''}</td>
                    <td className="p-3"><Badge tone={STATUS_TONE[o.status]}>{STATUS_LABEL[o.status]}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>
    </>
  )
}
