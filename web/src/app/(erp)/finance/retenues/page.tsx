import type { Metadata } from 'next'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { RpcButton } from '@/features/stock/components/rpc-button'
import { TaxForm } from '@/features/finance/components/tax-form'
import { withholdingRuleCreateAction, withholdingRuleValidateAction, withholdingRuleCloseAction, withholdingRecordAction, withholdingCancelAction } from '@/features/finance/tax-actions'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Retenues à la source' }

type Rule = { id: string; code: string; label: string; rate_pct: number; effective_from: string; effective_to: string | null; status: string }
type Rec = { id: string; rule_code: string; rate_pct: number; base_amount: number; amount: number; invoice_date: string; status: string }

/** Règles de retenue versionnées par date d’effet : aucun taux n’est fourni ni supposé. Une version est active seulement après validation par une autre personne. */
export default async function WithholdingPage() {
  const ctx = await requirePermission(P.FINANCE_READ)
  const canWrite = ctx.permissions.includes(P.FINANCE_WRITE)
  const canValidate = ctx.permissions.includes(P.TAX_VALIDATE)
  const supabase = await createClient()
  const [rules, recs] = await Promise.all([
    supabase.from('withholding_rules').select('id,code,label,rate_pct,effective_from,effective_to,status').order('code').order('effective_from', { ascending: false }).limit(100),
    supabase.from('supplier_invoice_withholdings').select('id,rule_code,rate_pct,base_amount,amount,invoice_date,status').order('invoice_date', { ascending: false }).limit(50),
  ])
  const ruleRows = (rules.data ?? []) as Rule[]
  const recRows = (recs.data ?? []) as Rec[]

  return (
    <>
      <PageHeader title="Retenues à la source" description="Règles versionnées par date d’effet. Une version doit être validée par une autre personne avant tout usage. Aucun taux par défaut : le taux et le champ d’application sont à fournir par l’expert-comptable." />
      <div className="space-y-4 p-4 sm:p-6">
        {canWrite && (
          <Card>
            <CardHeader><CardTitle>Nouvelle version de règle (à valider)</CardTitle></CardHeader>
            <CardContent>
              <TaxForm action={withholdingRuleCreateAction} submit="Créer la version" fields={[
                { name: 'code', label: 'Code (A–Z, 0–9, _)', required: true, pattern: '[A-Z0-9_]{3,40}' },
                { name: 'label', label: 'Libellé', required: true },
                { name: 'rate_pct', label: 'Taux (%)', type: 'number', required: true },
                { name: 'effective_from', label: 'Date d’effet', type: 'date', required: true },
                { name: 'effective_to', label: 'Date de fin (facultative)', type: 'date' }]} />
            </CardContent>
          </Card>
        )}
        <Card>
          <CardHeader><CardTitle>Règles et versions</CardTitle></CardHeader>
          <CardContent className="overflow-x-auto p-0">
            {ruleRows.length === 0 ? <p className="p-6 text-sm text-ink-soft">Aucune règle saisie : aucune retenue ne peut être enregistrée.</p> : (
              <table className="w-full min-w-[48rem] text-sm">
                <thead className="text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-medium">Code</th><th className="font-medium">Libellé</th><th className="font-medium">Taux</th><th className="font-medium">Effet</th><th className="font-medium">Fin</th><th className="font-medium">Statut</th><th className="font-medium">Actions</th></tr></thead>
                <tbody>
                  {ruleRows.map((r) => (
                    <tr key={r.id} className="border-t border-line align-top">
                      <td className="px-4 py-2 font-medium">{r.code}</td><td>{r.label}</td><td>{Number(r.rate_pct).toFixed(3)} %</td>
                      <td>{r.effective_from}</td><td>{r.effective_to ?? '—'}</td>
                      <td>{r.status === 'valide' ? 'Validée' : 'À valider'}</td>
                      <td className="space-y-2 py-2">
                        {r.status === 'a_valider' && canValidate && (
                          <div className="flex gap-2">
                            <RpcButton action={withholdingRuleValidateAction} fields={{ id: r.id, validate: 'true' }} variant="secondary">Valider</RpcButton>
                            <RpcButton action={withholdingRuleValidateAction} fields={{ id: r.id, validate: 'false' }} variant="secondary">Rejeter</RpcButton>
                          </div>
                        )}
                        {r.status === 'valide' && r.effective_to === null && canWrite && (
                          <TaxForm action={withholdingRuleCloseAction} hidden={{ id: r.id }} submit="Fermer la version" fields={[{ name: 'effective_to', label: 'Date de fin', type: 'date', required: true }]} />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
        {canWrite && (
          <Card>
            <CardHeader><CardTitle>Enregistrer une retenue sur une facture fournisseur</CardTitle></CardHeader>
            <CardContent>
              <TaxForm action={withholdingRecordAction} submit="Enregistrer" fields={[
                { name: 'supplier_invoice_id', label: 'Identifiant de la facture fournisseur', required: true },
                { name: 'rule_code', label: 'Code de règle', required: true },
                { name: 'base', label: 'Base de la retenue', type: 'number', required: true }]} />
            </CardContent>
          </Card>
        )}
        <Card>
          <CardHeader><CardTitle>Retenues enregistrées</CardTitle></CardHeader>
          <CardContent className="overflow-x-auto p-0">
            {recRows.length === 0 ? <p className="p-6 text-sm text-ink-soft">Aucune retenue enregistrée.</p> : (
              <table className="w-full min-w-[40rem] text-sm">
                <thead className="text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-medium">Date</th><th className="font-medium">Règle</th><th className="font-medium">Taux</th><th className="font-medium">Base</th><th className="font-medium">Montant</th><th className="font-medium">Statut</th><th className="font-medium">Annulation</th></tr></thead>
                <tbody>
                  {recRows.map((x) => (
                    <tr key={x.id} className="border-t border-line align-top">
                      <td className="px-4 py-2">{x.invoice_date}</td><td>{x.rule_code}</td><td>{Number(x.rate_pct).toFixed(3)} %</td>
                      <td>{Number(x.base_amount).toFixed(2)}</td><td>{Number(x.amount).toFixed(2)}</td>
                      <td>{x.status === 'active' ? 'Active' : 'Annulée'}</td>
                      <td className="py-2">
                        {x.status === 'active' && canWrite && <TaxForm action={withholdingCancelAction} hidden={{ id: x.id }} submit="Annuler" fields={[{ name: 'reason', label: 'Motif (5 caractères min.)', required: true }]} />}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  )
}
