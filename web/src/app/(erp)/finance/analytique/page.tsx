import type { Metadata } from 'next'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { RpcButton } from '@/features/stock/components/rpc-button'
import { TaxForm } from '@/features/finance/components/tax-form'
import {
  analyticMemberCreateAction, analyticKeyCreateAction, analyticKeyVersionCreateAction, analyticKeyVersionValidateAction,
  analyticBudgetVersionCreateAction, analyticBudgetLinesSetAction, analyticBudgetValidateAction, analyticCommitmentAddAction, analyticCommitmentCloseAction,
} from '@/features/finance/analytic-actions'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Analytique, budgets et marges' }

type Member = { id: string; axis: string; code: string; label: string }
type Version = { id: string; budget_kind: string; fiscal_year: number; version: number; status: string }
type Key = { id: string; code: string; label: string }
type Ver = { id: string; key_id: string; version: number; status: string; effective_from: string }
type Pos = { center_code: string; budget_initial: number | null; budget_revised: number | null; forecast: number | null; actual: number | null; committed_open: number | null }

const money = (v: unknown) => (v === null || v === undefined ? '—' : new Intl.NumberFormat('fr-FR', { style: 'decimal', minimumFractionDigits: 2 }).format(Number(v)))

/** Membres, clés d'allocation, budgets versionnés, engagements et position par centre. Marges et écarts : droit costs.read. */
export default async function AnalyticPage({ searchParams }: { searchParams: Promise<{ year?: string; month?: string; from?: string; to?: string }> }) {
  const ctx = await requirePermission(P.FINANCE_READ)
  const canWrite = ctx.permissions.includes(P.ANALYTIC_WRITE)
  const canValidate = ctx.permissions.includes(P.ANALYTIC_VALIDATE)
  const canCosts = ctx.permissions.includes(P.COSTS_READ)
  const sp = await searchParams
  const now = new Date()
  const year = Number(sp.year) || now.getUTCFullYear()
  const month = Number(sp.month) || now.getUTCMonth() + 1
  const from = /^\d{4}-\d{2}-\d{2}$/.test(sp.from ?? '') ? (sp.from as string) : `${year}-01-01`
  const to = /^\d{4}-\d{2}-\d{2}$/.test(sp.to ?? '') ? (sp.to as string) : `${year}-12-31`
  const supabase = await createClient()

  const [members, keys, keyVers, budgets, commitments, pos] = await Promise.all([
    supabase.from('analytic_members').select('id,axis,code,label').order('axis').order('code').limit(200),
    supabase.from('analytic_allocation_keys').select('id,code,label').order('code').limit(100),
    supabase.from('analytic_allocation_key_versions').select('id,key_id,version,status,effective_from').order('version').limit(200),
    supabase.from('analytic_budget_versions').select('id,budget_kind,fiscal_year,version,status').order('fiscal_year', { ascending: false }).order('version', { ascending: false }).limit(60),
    supabase.from('analytic_commitments').select('id,amount,reference,status,member_id').eq('status', 'open').limit(100),
    supabase.rpc('analytic_center_position', { p_year: year, p_month: month }),
  ])
  const memberRows = (members.data ?? []) as Member[]
  const keyRows = (keys.data ?? []) as Key[]
  const verRows = (keyVers.data ?? []) as Ver[]
  const budgetRows = (budgets.data ?? []) as Version[]
  const posRows = (pos.data ?? []) as Pos[]
  const commitRows = (commitments.data ?? []) as { id: string; amount: number; reference: string; member_id: string }[]
  const memberCode = new Map(memberRows.map((m) => [m.id, m.code]))
  const margin = canCosts ? await supabase.rpc('analytic_margin_report', { p_from: from, p_to: to }) : null
  const recon = canCosts ? await supabase.rpc('analytic_margin_reconcile', { p_from: from, p_to: to }) : null
  const variance = canCosts ? await supabase.rpc('analytic_variance_decompose', { p_year: year, p_month_from: 1, p_month_to: month, p_budget_kind: 'initial' }) : null

  return (
    <>
      <PageHeader title="Analytique, budgets et marges" description="Centres de coûts et de profit, produits, commandes, ateliers et canaux ; clés d’allocation versionnées et signées ; budgets initial, révisés et prévision (historisés) ; réalisé, engagé et prévision distincts. Marges : droit de lecture des coûts." />
      <div className="space-y-4 p-4 sm:p-6">
        <Card>
          <CardHeader><CardTitle>Position par centre ({month}/{year})</CardTitle></CardHeader>
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full min-w-[40rem] text-sm">
              <thead className="text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-medium">Centre</th><th className="font-medium">Budget initial</th><th className="font-medium">Budget révisé</th><th className="font-medium">Prévision</th><th className="font-medium">Réalisé</th><th className="font-medium">Engagé ouvert</th></tr></thead>
              <tbody>{posRows.map((r) => (
                <tr key={r.center_code} className="border-t border-line"><td className="px-4 py-2 font-medium">{r.center_code}</td><td>{money(r.budget_initial)}</td><td>{money(r.budget_revised)}</td><td>{money(r.forecast)}</td><td>{money(r.actual)}</td><td>{money(r.committed_open)}</td></tr>))}</tbody>
            </table>
            <form method="get" className="flex flex-wrap items-end gap-2 p-4 text-sm">
              <label className="flex flex-col gap-1">Année<input name="year" type="number" defaultValue={year} className="h-8 rounded-md border border-line-strong px-2" /></label>
              <label className="flex flex-col gap-1">Mois<input name="month" type="number" defaultValue={month} className="h-8 rounded-md border border-line-strong px-2" /></label>
              <label className="flex flex-col gap-1">Du<input name="from" type="date" defaultValue={from} className="h-8 rounded-md border border-line-strong px-2" /></label>
              <label className="flex flex-col gap-1">Au<input name="to" type="date" defaultValue={to} className="h-8 rounded-md border border-line-strong px-2" /></label>
              <button className="h-8 rounded-md border border-line-strong px-3 font-medium">Afficher</button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Membres analytiques</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <ul className="space-y-1">{memberRows.map((m) => <li key={m.id}>{m.axis} · {m.code} — {m.label} <span className="text-ink-soft">({m.id})</span></li>)}</ul>
            {canWrite && <TaxForm action={analyticMemberCreateAction} submit="Créer le membre" fields={[
              { name: 'axis', label: 'Axe (center, product, order, workshop, channel)', required: true }, { name: 'code', label: 'Code', required: true },
              { name: 'label', label: 'Libellé', required: true }, { name: 'kind', label: 'Genre de centre (cost ou profit)' }, { name: 'article', label: 'Article (produit, identifiant)' }]} />}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Clés d’allocation</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            {keyRows.map((k) => (
              <div key={k.id} className="space-y-1 border-t border-line pt-2">
                <p className="font-medium">{k.code} — {k.label}</p>
                <ul className="space-y-1">{verRows.filter((v) => v.key_id === k.id).map((v) => (
                  <li key={v.id} className="flex flex-wrap items-center gap-2">v{v.version} · effet {v.effective_from} · {v.status === 'valide' ? 'signée' : 'à signer'}
                    {v.status !== 'valide' && canValidate && <RpcButton action={analyticKeyVersionValidateAction} fields={{ id: v.id }} variant="secondary">Signer</RpcButton>}</li>))}</ul>
              </div>))}
            {canWrite && <TaxForm action={analyticKeyCreateAction} submit="Créer la clé" fields={[{ name: 'code', label: 'Code', required: true }, { name: 'label', label: 'Libellé', required: true }]} />}
            {canWrite && <TaxForm action={analyticKeyVersionCreateAction} submit="Ajouter une version" fields={[
              { name: 'key', label: 'Clé (identifiant)', required: true }, { name: 'effective_from', label: 'Date d’effet', type: 'date', required: true },
              { name: 'weights', label: 'Pourcentages « membre-uuid:pourcentage ; … » (total 100)', required: true }]} />}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Budgets</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <ul className="space-y-1">{budgetRows.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center gap-2">{b.budget_kind} {b.fiscal_year} v{b.version} · {b.status === 'valide' ? 'validé (figé)' : 'à valider'}
                {b.status !== 'valide' && canValidate && <RpcButton action={analyticBudgetValidateAction} fields={{ version: b.id }} variant="secondary">Valider</RpcButton>}</li>))}</ul>
            {canWrite && <TaxForm action={analyticBudgetVersionCreateAction} submit="Créer la version" fields={[
              { name: 'kind', label: 'Nature (initial, revised, forecast)', required: true }, { name: 'year', label: 'Année', type: 'number', required: true },
              { name: 'reason', label: 'Motif (révisé)' }]} />}
            {canWrite && <TaxForm action={analyticBudgetLinesSetAction} submit="Enregistrer les lignes" fields={[
              { name: 'version', label: 'Version (identifiant)', required: true },
              { name: 'lines', label: 'Lignes JSON [{kind, member, month, qty, unit_price, unit_cost | amount}]', required: true, multiline: true }]} />}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Engagements ouverts</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <ul className="space-y-1">{commitRows.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2">{c.reference} · {memberCode.get(c.member_id) ?? c.member_id} · {money(c.amount)}
                {canWrite && <TaxForm action={analyticCommitmentCloseAction} hidden={{ id: c.id }} submit="Clôturer" fields={[{ name: 'reason', label: 'Motif', required: true }]} />}</li>))}</ul>
            {canWrite && <TaxForm action={analyticCommitmentAddAction} submit="Enregistrer l’engagement" fields={[
              { name: 'member', label: 'Centre (identifiant)', required: true }, { name: 'amount', label: 'Montant', type: 'number', required: true },
              { name: 'reference', label: 'Référence', required: true }, { name: 'commitment_date', label: 'Date', type: 'date', required: true }]} />}
          </CardContent>
        </Card>

        {canCosts && (
          <Card>
            <CardHeader><CardTitle>Marges par article ({from} → {to})</CardTitle></CardHeader>
            <CardContent className="space-y-3 overflow-x-auto p-0">
              {margin?.error ? <p className="p-6 text-sm text-warn-text">{margin.error.message}</p> : (
                <table className="w-full min-w-[40rem] text-sm">
                  <thead className="text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-medium">Article</th><th className="font-medium">Quantité</th><th className="font-medium">Revenu</th><th className="font-medium">Marge</th><th className="font-medium">Marge %</th><th className="font-medium">Couverture coût %</th></tr></thead>
                  <tbody>{((margin?.data ?? []) as { article_code: string; qty: number; revenue: number; margin: number | null; margin_pct: number | null; cost_coverage_pct: number | null }[]).map((r) => (
                    <tr key={r.article_code} className="border-t border-line"><td className="px-4 py-2">{r.article_code}</td><td>{money(r.qty)}</td><td>{money(r.revenue)}</td><td>{money(r.margin)}</td><td>{r.margin_pct ?? '—'}</td><td>{r.cost_coverage_pct ?? '—'}</td></tr>))}</tbody>
                </table>
              )}
              {recon?.data && <p className="px-4 pb-4 text-sm">Rapprochement au compte 701 : revenu {money((recon.data as { revenue_lines: number }).revenue_lines)}, grand livre {money((recon.data as { ledger_701: number }).ledger_701)}, écart {money((recon.data as { difference: number }).difference)}.</p>}
            </CardContent>
          </Card>
        )}

        {canCosts && (
          <Card>
            <CardHeader><CardTitle>Écarts de marge (budget initial, {year} jusqu’au mois {month})</CardTitle></CardHeader>
            <CardContent className="overflow-x-auto p-0">
              {variance?.error ? <p className="p-6 text-sm text-warn-text">{variance.error.message}</p> : (
                <table className="w-full min-w-[48rem] text-sm">
                  <thead className="text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-medium">Article</th><th className="font-medium">Qté budget</th><th className="font-medium">Qté réelle</th><th className="font-medium">Volume</th><th className="font-medium">Mix</th><th className="font-medium">Prix</th><th className="font-medium">Coût / rendement</th><th className="font-medium">Total</th></tr></thead>
                  <tbody>{((variance?.data ?? []) as { article_code: string; qty_budget: number; qty_actual: number; volume: number; mix: number; price: number; cost_yield: number; total: number }[]).map((r) => (
                    <tr key={r.article_code} className="border-t border-line"><td className="px-4 py-2">{r.article_code}</td><td>{money(r.qty_budget)}</td><td>{money(r.qty_actual)}</td><td>{money(r.volume)}</td><td>{money(r.mix)}</td><td>{money(r.price)}</td><td>{money(r.cost_yield)}</td><td>{money(r.total)}</td></tr>))}</tbody>
                </table>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </>
  )
}
