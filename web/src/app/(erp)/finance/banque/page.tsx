import type { Metadata } from 'next'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { RpcButton } from '@/features/stock/components/rpc-button'
import { TaxForm } from '@/features/finance/components/tax-form'
import {
  bankAccountCreateAction, bankStatementImportAction, bankMatchConfirmAction, bankExceptionRaiseAction, bankExceptionCloseAction,
  supplierBankDetailSetAction, supplierBankDetailValidateAction, paymentTransmissionCreateAction, paymentTransmissionAcknowledgeAction,
} from '@/features/finance/bank-actions'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Banques et rapprochements' }

type Account = { id: string; name: string; bank_label: string; currency: string; account_last4: string }
type Line = { id: string; value_date: string; amount: number; label: string; status: string }
type Suggestion = { line_id: string; value_date: string; amount: number; label: string; target_kind: string; target_id: string; target_ref: string; score: string }
type Detail = { id: string; supplier_id: string; bank_label: string; iban_last4: string; status: string }
type Trans = { id: string; number: string; status: string; line_count: number; total_amount: number }

const money = (v: unknown) => new Intl.NumberFormat('fr-FR', { style: 'decimal', minimumFractionDigits: 2 }).format(Number(v ?? 0))

/** Comptes, relevés (import unique), rapprochements proposés, exceptions, coordonnées fournisseur et lots de transmission à double contrôle. */
export default async function BankPage({ searchParams }: { searchParams: Promise<{ account?: string }> }) {
  const ctx = await requirePermission(P.FINANCE_READ)
  const has = (code: string) => ctx.permissions.includes(code)
  const sp = await searchParams
  const accountId = /^[0-9a-f-]{36}$/i.test(sp.account ?? '') ? (sp.account as string) : null
  const supabase = await createClient()

  const [accounts, suppliers, details, trans, exceptions] = await Promise.all([
    supabase.from('bank_accounts').select('id,name,bank_label,currency,account_last4').order('name'),
    supabase.from('suppliers').select('id,code,name').order('name').limit(200),
    supabase.from('supplier_bank_details').select('id,supplier_id,bank_label,iban_last4,status').order('created_at', { ascending: false }).limit(50),
    supabase.from('payment_transmissions').select('id,number,status,line_count,total_amount').order('created_at', { ascending: false }).limit(20),
    supabase.from('bank_exceptions').select('id,bank_line_id,reason_code,note').is('resolved_at', null).limit(100),
  ])
  const accs = (accounts.data ?? []) as Account[]
  const detRows = (details.data ?? []) as Detail[]
  const transRows = (trans.data ?? []) as Trans[]
  const transStates = await Promise.all(transRows.map(async (t) => [t.id, (await supabase.rpc('payment_transmission_status', { p_transmission: t.id })).data] as const))
  const stateOf = new Map(transStates)

  let lines: Line[] = []
  let suggestions: Suggestion[] = []
  if (accountId) {
    const [l, s] = await Promise.all([
      supabase.from('bank_lines').select('id,value_date,amount,label,status').eq('bank_account_id', accountId).order('value_date').limit(200),
      supabase.rpc('bank_match_suggest', { p_account: accountId }),
    ])
    lines = (l.data ?? []) as Line[]
    suggestions = (s.data ?? []) as Suggestion[]
  }
  const exRows = (exceptions.data ?? []) as { id: string; bank_line_id: string; reason_code: string; note: string }[]
  const supplierName = new Map((suppliers.data ?? []).map((x) => [x.id, x.name]))

  return (
    <>
      <PageHeader title="Banques et rapprochements" description="Relevés importés une seule fois, rapprochements proposés puis confirmés, exceptions, coordonnées fournisseur validées par une autre personne et lots de transmission. Aucun paiement n'est envoyé à la banque par l'ERP : les lots restent des traces internes." />
      <div className="space-y-4 p-4 sm:p-6">
        <Card>
          <CardHeader><CardTitle>Comptes bancaires</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <ul className="space-y-1 text-sm">{accs.map((a) => (
              <li key={a.id}><a className="hover:underline" href={`/finance/banque?account=${a.id}`}>{a.name}</a> <span className="text-ink-soft">{a.bank_label} · {a.currency} · …{a.account_last4}</span></li>))}</ul>
            {has(P.BANK_MANAGE) && (
              <TaxForm action={bankAccountCreateAction} submit="Créer le compte" fields={[
                { name: 'name', label: 'Nom', required: true }, { name: 'bank_label', label: 'Banque', required: true },
                { name: 'currency', label: 'Devise (ISO)', required: true, placeholder: 'EUR' }, { name: 'last4', label: '4 derniers caractères', required: true }]} />
            )}
          </CardContent>
        </Card>

        {accountId && has(P.BANK_MANAGE) && (
          <Card>
            <CardHeader><CardTitle>Importer un relevé (une seule fois)</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              <TaxForm action={bankStatementImportAction} submit="Importer" fields={[
                { name: 'account', label: 'Compte (identifiant)', required: true }, { name: 'statement_ref', label: 'Référence du relevé', required: true },
                { name: 'period_from', label: 'Du', type: 'date', required: true }, { name: 'period_to', label: 'Au', type: 'date', required: true },
                { name: 'opening', label: 'Solde d’ouverture', type: 'number', required: true }, { name: 'closing', label: 'Solde de clôture', type: 'number', required: true },
                { name: 'lines', label: 'Lignes (JSON : value_date, amount, label, bank_ref)', required: true, multiline: true }]} hidden={{ account: accountId }} />
              <p className="text-xs text-ink-soft">Format canonique interne : le format des relevés bancaires n&apos;est pas encore confirmé.</p>
            </CardContent>
          </Card>
        )}

        {accountId && (
          <Card>
            <CardHeader><CardTitle>Lignes du relevé ({lines.length})</CardTitle></CardHeader>
            <CardContent className="overflow-x-auto p-0">
              {lines.length === 0 ? <p className="p-6 text-sm text-ink-soft">Aucune ligne.</p> : (
                <table className="w-full min-w-[40rem] text-sm">
                  <thead className="text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-medium">Date</th><th className="font-medium">Montant</th><th className="font-medium">Libellé</th><th className="font-medium">Statut</th><th className="font-medium">Exception</th></tr></thead>
                  <tbody>{lines.map((l) => (
                    <tr key={l.id} className="border-t border-line align-top">
                      <td className="px-4 py-2">{l.value_date}</td><td>{money(l.amount)}</td><td>{l.label}</td><td>{l.status}</td>
                      <td className="py-2">{l.status === 'open' && has(P.BANK_RECONCILE) && (
                        <TaxForm action={bankExceptionRaiseAction} hidden={{ line: l.id }} submit="Ouvrir une exception" fields={[
                          { name: 'reason_code', label: 'Code (no_match, amount_mismatch, duplicate_candidate, unknown_counterparty, other)', required: true },
                          { name: 'note', label: 'Note (5 caractères min.)', required: true }]} />)}</td>
                    </tr>))}</tbody>
                </table>
              )}
            </CardContent>
          </Card>
        )}

        {accountId && suggestions.length > 0 && (
          <Card>
            <CardHeader><CardTitle>Propositions de rapprochement</CardTitle></CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <table className="w-full min-w-[40rem] text-sm">
                <thead className="text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-medium">Ligne</th><th className="font-medium">Montant</th><th className="font-medium">Règlement</th><th className="font-medium">Critère</th><th className="font-medium">Action</th></tr></thead>
                <tbody>{suggestions.map((s) => (
                  <tr key={`${s.line_id}-${s.target_id}`} className="border-t border-line align-top">
                    <td className="px-4 py-2">{s.value_date} {s.label}</td><td>{money(s.amount)}</td>
                    <td>{s.target_kind === 'client_payment' ? `Encaissement ${s.target_ref}` : `Règlement fournisseur ${s.target_ref}`}</td><td>{s.score}</td>
                    <td className="py-2">{has(P.BANK_RECONCILE) && (
                      <RpcButton action={bankMatchConfirmAction} fields={{ line: s.line_id, kind: s.target_kind, target: s.target_id }} variant="secondary">Confirmer</RpcButton>)}</td>
                  </tr>))}</tbody>
              </table>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader><CardTitle>Exceptions ouvertes</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {exRows.length === 0 ? <p className="text-ink-soft">Aucune exception ouverte.</p> : exRows.map((e) => (
              <div key={e.id} className="flex flex-wrap items-end gap-2 border-t border-line pt-2">
                <span>{e.reason_code} — {e.note}</span>
                {has(P.BANK_RECONCILE) && <TaxForm action={bankExceptionCloseAction} hidden={{ id: e.id }} submit="Clôturer" fields={[{ name: 'resolution', label: 'Décision', required: true }]} />}
              </div>))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Coordonnées bancaires fournisseur</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <ul className="space-y-2">{detRows.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-2 border-t border-line pt-2">
                <span>{supplierName.get(d.supplier_id) ?? d.supplier_id} — {d.bank_label} …{d.iban_last4} ({d.status})</span>
                {d.status === 'a_valider' && has(P.BANK_DETAILS_VALIDATE) && (<>
                  <RpcButton action={supplierBankDetailValidateAction} fields={{ id: d.id, validate: 'true' }} variant="secondary">Valider</RpcButton>
                  <RpcButton action={supplierBankDetailValidateAction} fields={{ id: d.id, validate: 'false' }} variant="secondary">Rejeter</RpcButton></>)}
              </li>))}</ul>
            {has(P.BANK_DETAILS) && (
              <TaxForm action={supplierBankDetailSetAction} submit="Enregistrer (à valider)" fields={[
                { name: 'supplier', label: 'Fournisseur (identifiant)', required: true }, { name: 'bank_label', label: 'Banque', required: true },
                { name: 'iban', label: 'IBAN', required: true }]} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Lots de transmission</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <ul className="space-y-2">{transRows.map((t) => {
              const st = stateOf.get(t.id) as { executed: number; pending: number } | undefined
              return (
                <li key={t.id} className="flex flex-wrap items-center gap-2 border-t border-line pt-2">
                  <span>{t.number} — {t.status === 'accepted' ? 'accepté' : 'transmis'} — {t.line_count} ordre(s), {money(t.total_amount)} — exécutés {st?.executed ?? 0}, en attente {st?.pending ?? t.line_count}</span>
                  {t.status === 'transmitted' && has(P.BANK_ACKNOWLEDGE) && (
                    <TaxForm action={paymentTransmissionAcknowledgeAction} hidden={{ id: t.id }} submit="Accusé bancaire" fields={[{ name: 'bank_ref', label: 'Référence d’accusé', required: true }]} />)}
                </li>)})}</ul>
            {has(P.BANK_TRANSMIT) && (
              <TaxForm action={paymentTransmissionCreateAction} submit="Constituer le lot" fields={[
                { name: 'orders', label: 'Ordres approuvés (identifiants, séparés par des virgules)', required: true }]} />
            )}
          </CardContent>
        </Card>
      </div>
    </>
  )
}
