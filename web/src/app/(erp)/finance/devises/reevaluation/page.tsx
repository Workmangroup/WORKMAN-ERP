import type { Metadata } from 'next'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { RpcButton } from '@/features/stock/components/rpc-button'
import { TaxForm } from '@/features/finance/components/tax-form'
import { fxRateSetAction, fxRateValidateAction, fxPolicySetAction, fxPolicyValidateAction, fxRevaluationRunAction, fxRevaluationReverseAction } from '@/features/finance/fx-revaluation-actions'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Taux et réévaluation' }

type Rate = { id: string; currency: string; rate_date: string; version: number; rate: number; status: string; source: string | null }
type Policy = { reval_method: string; rounding: string; status: string } | null
type Run = { id: string; as_of: string; gain_total: number; loss_total: number; net_total: number; reval_method: string; reversed_at: string | null }

const money = (v: unknown) => new Intl.NumberFormat('fr-FR', { style: 'decimal', minimumFractionDigits: 2 }).format(Number(v ?? 0))

/** Taux versionnés et signés, politique de réévaluation, réévaluations et reprises. Aucune réécriture d'un ancien taux. */
export default async function FxRevaluationPage() {
  const ctx = await requirePermission(P.FINANCE_READ)
  const canWrite = ctx.permissions.includes(P.FINANCE_WRITE)
  const supabase = await createClient()
  const [rates, policy, runs] = await Promise.all([
    supabase.from('exchange_rates').select('id,currency,rate_date,version,rate,status,source').order('rate_date', { ascending: false }).order('version', { ascending: false }).limit(60),
    supabase.from('fx_policies').select('reval_method,rounding,status').maybeSingle(),
    supabase.from('fx_revaluation_runs').select('id,as_of,gain_total,loss_total,net_total,reval_method,reversed_at').order('as_of', { ascending: false }).limit(20),
  ])
  const rateRows = (rates.data ?? []) as Rate[]
  const pol = policy.data as Policy
  const runRows = (runs.data ?? []) as Run[]

  return (
    <>
      <PageHeader title="Taux et réévaluation" description="Chaque saisie de taux crée une version : rien n’est écrasé. Un taux se signe par une autre personne avant de servir à une réévaluation. La politique de reprise est signée de la même manière ; sans elle, aucune réévaluation n’est possible." />
      <div className="space-y-4 p-4 sm:p-6">
        <Card>
          <CardHeader><CardTitle>Taux de change (versions)</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] text-sm">
                <thead className="text-left text-xs text-ink-soft"><tr><th className="py-2 font-medium">Date</th><th className="font-medium">Devise</th><th className="font-medium">Version</th><th className="font-medium">Taux</th><th className="font-medium">Source</th><th className="font-medium">Signature</th><th className="font-medium">Action</th></tr></thead>
                <tbody>{rateRows.map((r) => (
                  <tr key={r.id} className="border-t border-line">
                    <td className="py-2">{r.rate_date}</td><td>{r.currency}</td><td>{r.version}</td><td>{Number(r.rate).toFixed(8)}</td><td>{r.source ?? '—'}</td>
                    <td>{r.status === 'valide' ? 'Signé' : 'À signer'}</td>
                    <td>{r.status !== 'valide' && canWrite && <RpcButton action={fxRateValidateAction} fields={{ id: r.id }} variant="secondary">Signer</RpcButton>}</td>
                  </tr>))}</tbody>
              </table>
            </div>
            {canWrite && (
              <TaxForm action={fxRateSetAction} submit="Ajouter une version" fields={[
                { name: 'rate_date', label: 'Date', type: 'date', required: true }, { name: 'currency', label: 'Devise (ISO)', required: true, placeholder: 'USD' },
                { name: 'rate', label: 'Taux (1 unité = … devise de base)', type: 'number', required: true }]} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Politique de réévaluation</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p>{pol ? `Méthode : ${pol.reval_method} · arrondi : ${pol.rounding} · ${pol.status === 'valide' ? 'signée' : 'à signer'}` : 'Aucune politique : saisir et faire signer avant toute réévaluation.'}</p>
            {canWrite && pol?.status !== 'valide' && (<>
              <TaxForm action={fxPolicySetAction} submit="Enregistrer la politique" fields={[{ name: 'method', label: 'Méthode (reversal_next_period | no_reversal)', required: true }]} />
              {pol && <RpcButton action={fxPolicyValidateAction} fields={{}} variant="secondary">Signer la politique</RpcButton>}
            </>)}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Réévaluations des postes ouverts</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] text-sm">
                <thead className="text-left text-xs text-ink-soft"><tr><th className="py-2 font-medium">Date</th><th className="font-medium">Gain</th><th className="font-medium">Perte</th><th className="font-medium">Net</th><th className="font-medium">Méthode</th><th className="font-medium">Reprise</th></tr></thead>
                <tbody>{runRows.map((r) => (
                  <tr key={r.id} className="border-t border-line align-top">
                    <td className="py-2">{r.as_of}</td><td>{money(r.gain_total)}</td><td>{money(r.loss_total)}</td><td>{money(r.net_total)}</td><td>{r.reval_method}</td>
                    <td className="space-y-2 py-2">
                      {r.reversed_at ? 'Reprise faite' : canWrite && r.reval_method === 'reversal_next_period' && (
                        <TaxForm action={fxRevaluationReverseAction} hidden={{ id: r.id }} submit="Reprendre" fields={[{ name: 'reversal_date', label: 'Date de reprise', type: 'date', required: true }]} />)}
                    </td>
                  </tr>))}</tbody>
              </table>
            </div>
            {canWrite && (
              <TaxForm action={fxRevaluationRunAction} submit="Réévaluer à cette date" fields={[{ name: 'as_of', label: 'Date de réévaluation', type: 'date', required: true }]} />
            )}
            <p className="text-xs text-ink-soft">Une réévaluation doit être reprise avant la suivante. Les taux du jour doivent être signés.</p>
          </CardContent>
        </Card>
      </div>
    </>
  )
}
