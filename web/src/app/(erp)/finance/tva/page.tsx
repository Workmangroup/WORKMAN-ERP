import type { Metadata } from 'next'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { RpcButton } from '@/features/stock/components/rpc-button'
import { TaxForm } from '@/features/finance/components/tax-form'
import { vatPrepareAction, vatValidateAction, vatExportAction, vatFileAction, vatCancelAction } from '@/features/finance/tax-actions'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Déclarations TVA' }

type Row = { id: string; year: number; month: number; status: string; collected_tax: number; deductible_tax: number; vat_due: number;
  withholding_total: number; receipt_ref: string | null; receipt_date: string | null }

const money = (v: unknown) => new Intl.NumberFormat('fr-FR', { style: 'decimal', minimumFractionDigits: 2 }).format(Number(v ?? 0))
const STATUS: Record<string, string> = { brouillon: 'Brouillon', validee: 'Validée (figée)', exportee: 'Exportée', deposee: 'Déposée', annulee: 'Annulée' }

/** Déclarations de TVA par mois : calcul, validation par une autre personne, export interne, dépôt avec accusé réel. Aucune transmission à l’administration. */
export default async function VatDeclarationsPage() {
  const ctx = await requirePermission(P.FINANCE_READ)
  const canWrite = ctx.permissions.includes(P.FINANCE_WRITE)
  const canValidate = ctx.permissions.includes(P.TAX_VALIDATE)
  const canFile = ctx.permissions.includes(P.TAX_FILE)
  const supabase = await createClient()
  const { data, error } = await supabase.from('vat_declarations')
    .select('id,year,month,status,collected_tax,deductible_tax,vat_due,withholding_total,receipt_ref,receipt_date')
    .order('year', { ascending: false }).order('month', { ascending: false }).limit(24)
  const rows = (data ?? []) as Row[]
  const sealed = rows.filter((r) => r.status === 'validee' || r.status === 'exportee' || r.status === 'deposee')
  const drift = new Map(await Promise.all(sealed.map(async (r) => [r.id, (await supabase.rpc('vat_declaration_drift', { p_id: r.id })).data] as const)))

  return (
    <>
      <PageHeader title="Déclarations TVA" description="Calcul par mois à partir des factures et avoirs émis, de la TVA déductible saisie et des retenues. Les taux doivent être validés par l’expert-comptable. Aucun dépôt n’est transmis par l’ERP : le dépôt se justifie par une référence d’accusé réelle." />
      <div className="space-y-4 p-4 sm:p-6">
        {error && <p className="rounded-md border border-warn-bg bg-warn-bg px-3 py-2 text-sm text-warn-text">Liste indisponible : {error.message}</p>}
        {canWrite && (
          <Card>
            <CardHeader><CardTitle>Calculer une déclaration (brouillon)</CardTitle></CardHeader>
            <CardContent>
              <TaxForm action={vatPrepareAction} submit="Calculer" fields={[
                { name: 'year', label: 'Année', type: 'number', required: true, placeholder: 'AAAA' },
                { name: 'month', label: 'Mois', type: 'number', required: true, placeholder: '1 à 12' }]} />
              <p className="mt-2 text-xs text-ink-soft">Recalculer un brouillon le remplace ; une déclaration validée ne peut plus être recalculée.</p>
            </CardContent>
          </Card>
        )}
        <Card>
          <CardHeader><CardTitle>Déclarations</CardTitle></CardHeader>
          <CardContent className="overflow-x-auto p-0">
            {rows.length === 0 ? <p className="p-6 text-sm text-ink-soft">Aucune déclaration calculée.</p> : (
              <table className="w-full min-w-[60rem] text-sm">
                <thead className="text-left text-xs text-ink-soft"><tr>
                  <th className="px-4 py-2 font-medium">Période</th><th className="font-medium">Statut</th><th className="font-medium">Collectée</th>
                  <th className="font-medium">Déductible</th><th className="font-medium">TVA due</th><th className="font-medium">Retenues</th>
                  <th className="font-medium">Accusé</th><th className="font-medium">Cohérence</th><th className="font-medium">Actions</th></tr></thead>
                <tbody>
                  {rows.map((r) => {
                    const d = drift.get(r.id) as { consistent: boolean; differences: number } | undefined
                    return (
                      <tr key={r.id} className="border-t border-line align-top">
                        <td className="px-4 py-2 font-medium">{String(r.month).padStart(2, '0')}/{r.year}</td>
                        <td>{STATUS[r.status] ?? r.status}</td>
                        <td>{money(r.collected_tax)}</td><td>{money(r.deductible_tax)}</td><td>{money(r.vat_due)}</td><td>{money(r.withholding_total)}</td>
                        <td>{r.receipt_ref ? `${r.receipt_ref} (${r.receipt_date})` : '—'}</td>
                        <td>{d === undefined ? '—' : d.consistent ? 'Conforme' : `Écart : ${d.differences} ligne(s)`}</td>
                        <td className="space-y-2 py-2">
                          {r.status === 'brouillon' && canValidate && <RpcButton action={vatValidateAction} fields={{ id: r.id }} variant="secondary">Valider</RpcButton>}
                          {r.status === 'validee' && canWrite && <RpcButton action={vatExportAction} fields={{ id: r.id }} variant="secondary">Exporter (interne)</RpcButton>}
                          {r.status === 'exportee' && canFile && (
                            <TaxForm action={vatFileAction} hidden={{ id: r.id }} submit="Enregistrer le dépôt" fields={[
                              { name: 'receipt_ref', label: 'Référence d’accusé', required: true },
                              { name: 'receipt_date', label: 'Date d’accusé', type: 'date', required: true }]} />
                          )}
                          {(r.status === 'brouillon' || r.status === 'validee' || r.status === 'exportee') && canValidate && (
                            <TaxForm action={vatCancelAction} hidden={{ id: r.id }} submit="Annuler" fields={[{ name: 'reason', label: 'Motif (5 caractères min.)', required: true }]} />
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  )
}
