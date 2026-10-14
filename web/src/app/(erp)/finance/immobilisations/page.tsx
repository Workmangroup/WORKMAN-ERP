import type { Metadata } from 'next'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { RpcButton } from '@/features/stock/components/rpc-button'
import { TaxForm } from '@/features/finance/components/tax-form'
import {
  assetRuleCreateAction, assetRuleValidateAction, assetCategoryCreateAction, assetCategoryValidateAction, assetAcquireAction,
  assetDocumentAddAction, assetCommissionAction, assetDepreciationPostAction, assetDisposeAction,
} from '@/features/finance/asset-actions'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Immobilisations et amortissements' }

type Rule = { id: string; kind: string; code: string; useful_life_months: number; effective_from: string; status: string }
type Cat = { id: string; code: string; label: string; status: string }
type Asset = { id: string; code: string; label: string; acquisition_date: string; acquisition_cost: number; residual_value: number; status: string; in_service_date: string | null }
type Rec = { account: string; kind: string; register: number; ledger: number; difference: number }

const money = (v: unknown) => new Intl.NumberFormat('fr-FR', { style: 'decimal', minimumFractionDigits: 2 }).format(Number(v ?? 0))
const STATUS: Record<string, string> = { draft: 'Brouillon (acquise)', in_service: 'En service', disposed: 'Cédée' }

/** Règles comptables et fiscales (signées), catégories, immobilisations, dotations mensuelles et inventaire. Écritures par le service comptable. */
export default async function AssetsPage({ searchParams }: { searchParams: Promise<{ as_of?: string }> }) {
  const ctx = await requirePermission(P.FINANCE_READ)
  const canWrite = ctx.permissions.includes(P.ASSETS_WRITE)
  const canValidate = ctx.permissions.includes(P.ASSETS_VALIDATE)
  const sp = await searchParams
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(sp.as_of ?? '') ? (sp.as_of as string) : new Date().toISOString().slice(0, 10)
  const supabase = await createClient()
  const [rules, cats, assets, rec] = await Promise.all([
    supabase.from('asset_rule_sets').select('id,kind,code,useful_life_months,effective_from,status').order('code').limit(100),
    supabase.from('fixed_asset_categories').select('id,code,label,status').order('code').limit(100),
    supabase.from('fixed_assets').select('id,code,label,acquisition_date,acquisition_cost,residual_value,status,in_service_date').order('code').limit(200),
    supabase.rpc('fixed_asset_reconcile', { p_as_of: asOf }),
  ])
  const ruleRows = (rules.data ?? []) as Rule[]
  const catRows = (cats.data ?? []) as Cat[]
  const assetRows = (assets.data ?? []) as Asset[]
  const recRows = (rec.data ?? []) as Rec[]

  return (
    <>
      <PageHeader title="Immobilisations et amortissements" description="Règles comptables et fiscales distinctes, signées par une autre personne ; catégories à comptes contrôlés ; dotations linéaires reproductibles, comptabilisées par mois ; cessions rapprochées ; inventaire contre le grand livre. Aucune règle ni compte n'est supposé : ils sont saisis et validés par l'expert." />
      <div className="space-y-4 p-4 sm:p-6">
        <Card>
          <CardHeader><CardTitle>Règles d’amortissement</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <ul className="space-y-1">{ruleRows.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2">
                <span>{r.kind === 'accounting' ? 'Comptable' : 'Fiscale'} · {r.code} · {r.useful_life_months} mois · effet {r.effective_from} · {r.status === 'valide' ? 'signée' : 'à signer'}</span>
                {r.status !== 'valide' && canValidate && <RpcButton action={assetRuleValidateAction} fields={{ id: r.id }} variant="secondary">Signer</RpcButton>}
              </li>))}</ul>
            {canWrite && <TaxForm action={assetRuleCreateAction} submit="Saisir la règle" fields={[
              { name: 'kind', label: 'Nature (accounting ou tax)', required: true }, { name: 'code', label: 'Code', required: true },
              { name: 'life_months', label: 'Durée (mois)', type: 'number', required: true }, { name: 'effective_from', label: 'Date d’effet', type: 'date', required: true }]} />}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Catégories et comptes</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <ul className="space-y-1">{catRows.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2">
                <span>{c.code} — {c.label} · {c.status === 'valide' ? 'signée' : 'à signer'}</span>
                {c.status !== 'valide' && canValidate && <RpcButton action={assetCategoryValidateAction} fields={{ id: c.id }} variant="secondary">Signer</RpcButton>}
              </li>))}</ul>
            {canWrite && <TaxForm action={assetCategoryCreateAction} submit="Saisir la catégorie" fields={[
              { name: 'code', label: 'Code', required: true }, { name: 'label', label: 'Libellé', required: true },
              { name: 'asset_account', label: 'Compte d’immobilisation', required: true }, { name: 'depreciation_account', label: 'Compte d’amortissement cumulé', required: true },
              { name: 'expense_account', label: 'Compte de dotation', required: true }, { name: 'gain_account', label: 'Compte de plus-value', required: true },
              { name: 'loss_account', label: 'Compte de moins-value', required: true }]} />}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Immobilisations ({assetRows.length})</CardTitle></CardHeader>
          <CardContent className="space-y-4 overflow-x-auto p-0">
            <table className="w-full min-w-[48rem] text-sm">
              <thead className="text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-medium">Code</th><th className="font-medium">Libellé</th><th className="font-medium">Acquise</th><th className="font-medium">Coût</th><th className="font-medium">Résiduel</th><th className="font-medium">Statut</th><th className="font-medium">Actions</th></tr></thead>
              <tbody>{assetRows.map((a) => (
                <tr key={a.id} className="border-t border-line align-top">
                  <td className="px-4 py-2 font-medium">{a.code}</td><td>{a.label}</td><td>{a.acquisition_date}</td><td>{money(a.acquisition_cost)}</td><td>{money(a.residual_value)}</td>
                  <td>{STATUS[a.status] ?? a.status}{a.in_service_date ? ` (mise en service ${a.in_service_date})` : ''}</td>
                  <td className="space-y-2 py-2">
                    {canWrite && a.status === 'draft' && (<>
                      <TaxForm action={assetDocumentAddAction} hidden={{ id: a.id }} submit="Ajouter un justificatif" fields={[
                        { name: 'kind', label: 'Nature (supplier_invoice, delivery_note, commissioning_report, disposal_proof)', required: true },
                        { name: 'reference', label: 'Référence', required: true }, { name: 'document_date', label: 'Date', type: 'date', required: true }]} />
                      <TaxForm action={assetCommissionAction} hidden={{ id: a.id }} submit="Mettre en service" fields={[
                        { name: 'in_service_date', label: 'Date de mise en service', type: 'date', required: true },
                        { name: 'acc_rule', label: 'Règle comptable', required: true }, { name: 'tax_rule', label: 'Règle fiscale', required: true }]} />
                    </>)}
                    {canWrite && a.status === 'in_service' && (
                      <TaxForm action={assetDisposeAction} hidden={{ id: a.id }} submit="Céder" fields={[
                        { name: 'disposal_date', label: 'Date de cession', type: 'date', required: true }, { name: 'proceeds', label: 'Produit', type: 'number', required: true },
                        { name: 'proceeds_account', label: 'Compte du produit' }, { name: 'reason', label: 'Motif', required: true }]} />)}
                  </td>
                </tr>))}</tbody>
            </table>
            {canWrite && (
              <div className="px-4 pb-4">
                <TaxForm action={assetDepreciationPostAction} submit="Comptabiliser les dotations du mois" fields={[
                  { name: 'year', label: 'Année', type: 'number', required: true }, { name: 'month', label: 'Mois', type: 'number', required: true }]} />
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Inventaire au {asOf}</CardTitle></CardHeader>
          <CardContent className="space-y-2 overflow-x-auto p-0">
            {rec.error ? <p className="p-6 text-sm text-warn-text">{rec.error.message}</p> : (
              <table className="w-full min-w-[40rem] text-sm">
                <thead className="text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-medium">Compte</th><th className="font-medium">Nature</th><th className="font-medium">Registre</th><th className="font-medium">Grand livre</th><th className="font-medium">Écart</th></tr></thead>
                <tbody>{recRows.map((r) => (
                  <tr key={`${r.kind}-${r.account}`} className="border-t border-line"><td className="px-4 py-2">{r.account}</td><td>{r.kind === 'cost' ? 'Coût' : 'Amortissement cumulé'}</td>
                    <td>{money(r.register)}</td><td>{money(r.ledger)}</td><td className={Number(r.difference) === 0 ? '' : 'font-medium text-warn-text'}>{money(r.difference)}</td></tr>))}</tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  )
}
