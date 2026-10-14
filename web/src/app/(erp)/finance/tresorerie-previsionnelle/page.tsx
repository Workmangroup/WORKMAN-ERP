import type { Metadata } from 'next'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { RpcButton } from '@/features/stock/components/rpc-button'
import { TaxForm } from '@/features/finance/components/tax-form'
import { cashHypothesisCreateAction, cashHypothesisValidateAction, cashForecastRunAction } from '@/features/finance/collections-actions'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Trésorerie prévisionnelle' }

const money = (v: unknown) => (v === null || v === undefined ? '—' : new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2 }).format(Number(v)))

/** Prévision 13 semaines : hypothèses signées, exécutions figées, chaque ligne rattachée à sa pièce ou à sa promesse. */
export default async function TresoreriePrevisionnellePage({ searchParams }: { searchParams: Promise<{ run?: string }> }) {
  const ctx = await requirePermission(P.FINANCE_READ)
  const canWrite = ctx.permissions.includes(P.COLLECTIONS_WRITE)
  const canValidate = ctx.permissions.includes(P.COLLECTIONS_VALIDATE)
  const sp = await searchParams
  const run = /^[0-9a-f-]{36}$/.test(sp.run ?? '') ? (sp.run as string) : null
  const supabase = await createClient()

  const [hyps, runs] = await Promise.all([
    supabase.from('cash_forecast_hypotheses').select('id,code,effective_from,collect_pct_not_due,collect_pct_overdue,delay_days,promise_pct,supplier_pay_pct,supplier_disputed_pct,status').order('effective_from', { ascending: false }).limit(20),
    supabase.from('cash_forecast_runs').select('id,as_of,weeks,opening_balance,receipts_total,payments_total,excluded_fx_missing,excluded_beyond_horizon,created_at').order('created_at', { ascending: false }).limit(10),
  ])
  const weeks = run ? await supabase.rpc('cash_forecast_weeks', { p_run: run }) : null
  const check = run ? await supabase.rpc('cash_forecast_check', { p_run: run }) : null
  const sources = run ? await supabase.from('cash_forecast_lines').select('week_no,direction,source_type,source_ref,amount,expected_on,basis').eq('run_id', run).order('week_no').limit(300) : null

  return (
    <>
      <PageHeader title="Trésorerie prévisionnelle" description="Prévision sur 13 semaines à partir du solde réel. Chaque exécution est figée ; chaque ligne renvoie à sa pièce ou à sa promesse. Les hypothèses sont signées et révisables." />
      <div className="space-y-4 p-4 sm:p-6">
        <Card>
          <CardHeader><CardTitle>Hypothèses de recouvrement et de paiement</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-ink-soft">Aucune hypothèse par défaut. Les litiges clients sont toujours retirés de l’exigible ; une pièce sans taux applicable est exclue et comptée.</p>
            <ul className="space-y-1">{((hyps.data ?? []) as Record<string, string | number>[]).map((h) => (
              <li key={String(h.id)} className="flex flex-wrap items-center gap-2">{h.code} · effet {h.effective_from} · non échu {h.collect_pct_not_due} % · échu {h.collect_pct_overdue} % · délai {h.delay_days} j · promesse {h.promise_pct} % · fournisseur {h.supplier_pay_pct} % (litige {h.supplier_disputed_pct} %) · {h.status === 'valide' ? 'signée' : 'à signer'} <span className="text-ink-soft">({h.id})</span>
                {h.status !== 'valide' && canValidate && <RpcButton action={cashHypothesisValidateAction} fields={{ id: String(h.id), validate: 'true' }} variant="secondary">Signer</RpcButton>}</li>))}</ul>
            {canWrite && <TaxForm action={cashHypothesisCreateAction} submit="Créer l’hypothèse" fields={[
              { name: 'code', label: 'Code', required: true }, { name: 'effective_from', label: 'Date d’effet', type: 'date', required: true },
              { name: 'pct_not_due', label: '% recouvrement non échu', type: 'number', required: true }, { name: 'pct_overdue', label: '% recouvrement échu', type: 'number', required: true },
              { name: 'delay_days', label: 'Délai de paiement (jours)', type: 'number', required: true }, { name: 'promise_pct', label: '% promesse tenue', type: 'number', required: true },
              { name: 'supplier_pay_pct', label: '% fournisseurs payé', type: 'number', required: true }, { name: 'supplier_disputed_pct', label: '% fournisseurs en litige payé', type: 'number', required: true }]} />}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Exécutions figées</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <ul className="space-y-1">{((runs.data ?? []) as Record<string, string | number>[]).map((r) => (
              <li key={String(r.id)}><a className="underline" href={`?run=${r.id}`}>{r.as_of}</a> · {r.weeks} semaines · solde d’ouverture {money(r.opening_balance)} · encaissements {money(r.receipts_total)} · décaissements {money(r.payments_total)} · sans taux {r.excluded_fx_missing} · hors horizon {r.excluded_beyond_horizon}</li>))}</ul>
            {canWrite && <TaxForm action={cashForecastRunAction} submit="Figer une prévision" fields={[
              { name: 'hypothesis', label: 'Hypothèse signée (identifiant)', required: true }, { name: 'as_of', label: 'Date', type: 'date', required: true },
              { name: 'weeks', label: 'Horizon (semaines)', type: 'number', required: true }]} />}
          </CardContent>
        </Card>

        {weeks?.data && (
          <Card>
            <CardHeader><CardTitle>Semaines de l’exécution</CardTitle></CardHeader>
            <CardContent className="overflow-x-auto p-0">
              {check?.data && <p className="px-4 pt-4 text-sm">Contrôle : {(check.data as { ok: boolean }).ok ? 'lignes et totaux concordants, toutes sourcées' : 'écart détecté'}</p>}
              <table className="w-full min-w-[40rem] text-sm">
                <thead className="text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-medium">Semaine</th><th className="font-medium">Début</th><th className="font-medium">Encaissements</th><th className="font-medium">Décaissements</th><th className="font-medium">Net</th><th className="font-medium">Solde projeté</th></tr></thead>
                <tbody>{((weeks.data ?? []) as { week_no: number; week_start: string; receipts: number; payments: number; net: number; projected_balance: number }[]).map((w) => (
                  <tr key={w.week_no} className="border-t border-line"><td className="px-4 py-2">{w.week_no}</td><td>{w.week_start}</td><td>{money(w.receipts)}</td><td>{money(w.payments)}</td><td>{money(w.net)}</td><td>{money(w.projected_balance)}</td></tr>))}</tbody>
              </table>
              <div className="space-y-1 p-4 text-sm">
                <p className="font-medium">Sources</p>
                <ul className="max-h-96 space-y-1 overflow-y-auto">{((sources?.data ?? []) as { week_no: number; direction: string; source_type: string; source_ref: string; amount: number; expected_on: string; basis: string }[]).map((l, i) => (
                  <li key={i}>S{l.week_no} · {l.direction === 'receipt' ? 'encaissement' : 'décaissement'} · {l.source_ref} ({l.source_type}) · {money(l.amount)} · attendu le {l.expected_on} · {l.basis}</li>))}</ul>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </>
  )
}
