import type { Metadata } from 'next'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/layout/page-header'
import { requireAnyPermission } from '@/features/auth/guards'
import { saveSupplierEvaluationAction } from '@/features/purchases/actions'
import { supplierOptions, supplierEvaluationPreview } from '@/features/purchases/services/purchases.service'
import { RpcButton } from '@/features/stock/components/rpc-button'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Évaluation fournisseur' }

const FLAG_LABEL: Record<string, string> = {
  AUCUNE_RECEPTION_PERIODE: 'Aucune réception sur la période : données insuffisantes.',
  ECHANTILLON_FAIBLE: 'Échantillon faible : peu de réceptions, les scores sont provisoires.',
  POLITIQUE_NON_PARAMETREE: 'Politique d’évaluation non paramétrée : pas de score composite.',
  PRIX_CATALOGUE_MANQUANT: 'Prix catalogue manquant pour certaines lignes : écart prix partiel.',
  DEFAUT_CRITIQUE: 'Défaut critique constaté à la réception.',
  ECART_PRIX_AU_DELA_SEUIL: 'Écart de prix au-delà du seuil d’alerte.',
  PREVISION_RETARD: 'Prévision de retard : commande dépassée sans réception (non confirmé).',
}
const pct = (v: number | null | undefined) => (v == null ? '—' : `${Number(v).toFixed(2)} %`)
const IND_LABEL: Record<string, string> = { ponctualite: 'Ponctualité', defauts: 'Défauts', ecart_prix: 'Écart prix', reactivite: 'Réactivité', documents: 'Documents' }

export default async function SupplierEvaluationPage({ searchParams }: { searchParams: Promise<{ supplier?: string; from?: string; to?: string }> }) {
  const ctx = await requireAnyPermission(P.PURCHASES_READ)
  const sp = await searchParams
  const today = new Date()
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  const from = sp.from && /^\d{4}-\d{2}-\d{2}$/.test(sp.from) ? sp.from : iso(new Date(today.getTime() - 90 * 864e5))
  const to = sp.to && /^\d{4}-\d{2}-\d{2}$/.test(sp.to) ? sp.to : iso(today)
  const suppliers = await supplierOptions()
  const sup = suppliers.find((s) => s.id === sp.supplier)
  const res = sup ? await supplierEvaluationPreview(sup.id, from, to) : null
  const canWrite = ctx.permissions.includes(P.PURCHASES_WRITE)
  return (
    <>
      <PageHeader title="Évaluation fournisseur et délais" description="Indicateurs explicables par période. Une évaluation enregistrée reste dans l’historique. Aucune commande n’est passée automatiquement." />
      <div className="space-y-4 p-4 sm:p-6">
        <form method="get" className="grid gap-3 rounded-md border border-line bg-white p-4 shadow-card md:grid-cols-[minmax(0,2fr)_10rem_10rem_auto] md:items-end">
          <label className="text-sm">Fournisseur<select name="supplier" defaultValue={sup?.id ?? ''} className="mt-1 block w-full rounded-md border border-line px-2 py-2"><option value="">— Choisir —</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          <label className="text-sm">Du<input type="date" name="from" defaultValue={from} className="mt-1 block w-full rounded-md border border-line px-2 py-2" /></label>
          <label className="text-sm">Au<input type="date" name="to" defaultValue={to} className="mt-1 block w-full rounded-md border border-line px-2 py-2" /></label>
          <button type="submit" className="rounded-md border border-line bg-white px-4 py-2 text-sm font-semibold hover:bg-canvas">Calculer</button>
        </form>

        {!sup && <p className="text-sm text-ink-soft">Choisissez un fournisseur et une période.</p>}
        {res?.error && <Alert tone="error">{res.error.message?.includes('RBAC') ? 'Droit insuffisant.' : 'Calcul impossible pour cette saisie.'}</Alert>}
        {res?.data && (() => {
          const d = res.data
          return (
            <>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-semibold">{sup?.name}</span>
                <span className="text-ink-soft">· du {from} au {to} · {d.data_points.receipts} réception(s)</span>
              </div>
              {d.flags.length > 0 && (
                <div className="space-y-2">
                  {d.flags.map((f) => <Alert key={f} tone={f === 'DEFAUT_CRITIQUE' || f === 'ECART_PRIX_AU_DELA_SEUIL' ? 'error' : 'info'}>{FLAG_LABEL[f] ?? f}</Alert>)}
                </div>
              )}
              <section className="rounded-md border border-line bg-white p-4 shadow-card">
                <h2 className="text-sm font-semibold">Score composite</h2>
                {d.composite ? (
                  <p className="mt-1 text-2xl font-semibold tabular-nums">{d.composite.score.toFixed(2)} <span className="text-sm font-normal text-ink-soft">/ 100 · {d.composite.formula}</span></p>
                ) : (
                  <p className="mt-1 text-sm text-ink-soft">Non calculé : {(d.composite_missing ?? []).join(' ; ')}.</p>
                )}
              </section>
              <section className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
                <table className="w-full min-w-[40rem] text-sm">
                  <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Indicateur</th><th className="px-2 py-2 text-right font-semibold">Valeur</th><th className="px-2 py-2 font-semibold">Calcul</th></tr></thead>
                  <tbody className="divide-y divide-line">
                    {Object.entries(d.indicators).map(([k, v]) => (
                      <tr key={k} className="align-top">
                        <td className="px-4 py-2 font-medium">{IND_LABEL[k] ?? k}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{pct(v.value)}</td>
                        <td className="px-2 py-2 text-xs text-ink-soft">{v.numerator != null && v.denominator != null ? `${v.numerator} / ${v.denominator} — ` : ''}{v.formula}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
              <section className="grid gap-3 md:grid-cols-2">
                <div className="rounded-md border border-line bg-white p-4 shadow-card">
                  <h3 className="text-sm font-semibold">Retard confirmé</h3>
                  <p className="text-sm">{d.confirmed_late.receipts_after_due_date} réception(s) après la date prévue.</p>
                  <p className="text-xs text-ink-soft">{d.confirmed_late.formula}</p>
                </div>
                <div className="rounded-md border border-line bg-white p-4 shadow-card">
                  <h3 className="text-sm font-semibold">Prévision (non confirmée)</h3>
                  <p className="text-sm">{d.forecast_late.open_orders_past_due} commande(s) ouverte(s) dépassée(s), {d.forecast_late.open_qty} unité(s) non reçues.</p>
                  <p className="text-xs text-ink-soft">{d.forecast_late.formula}</p>
                </div>
              </section>
              {canWrite && sup && (
                <div className="flex justify-end">
                  <RpcButton action={saveSupplierEvaluationAction} fields={{ supplier_id: sup.id, from, to }} variant="command" size="sm" confirm="Enregistrer cette évaluation dans l’historique ?">Enregistrer l’évaluation</RpcButton>
                </div>
              )}
            </>
          )
        })()}
      </div>
    </>
  )
}
