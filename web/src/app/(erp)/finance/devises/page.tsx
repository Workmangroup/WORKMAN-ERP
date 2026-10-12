import type { Metadata } from 'next'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { FxRateDialog } from '@/features/finance/components/fx-rate-dialog'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'
import { cn } from '@/lib/utils'

export const metadata: Metadata = { title: 'Devises et fiscalité' }

type Row = Record<string, string | number | boolean | string[] | null>

const iso = (d: Date) => d.toISOString().slice(0, 10)
const money = (v: unknown, cur: string) => (v === null || v === undefined ? '—' : new Intl.NumberFormat('fr-FR', { style: 'currency', currency: cur }).format(Number(v)))
const signed = (v: unknown, cur: string) => (v === null || v === undefined ? '—' : `${Number(v) > 0 ? '+' : ''}${money(v, cur)}`)
const PERIOD = /^\d{4}-\d{2}-\d{2}$/

/** Devises, taux, TVA, fiscalité export, écarts de change et reporting multi-devise. Lecture : finance.read. */
export default async function CurrencyTaxPage({ searchParams }: { searchParams: Promise<{ du?: string; au?: string }> }) {
  const ctx = await requirePermission(P.FINANCE_READ)
  const canWrite = ctx.permissions.includes(P.FINANCE_WRITE)
  const sp = await searchParams
  const today = new Date()
  const from = PERIOD.test(sp.du ?? '') ? (sp.du as string) : iso(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)))
  const to = PERIOD.test(sp.au ?? '') ? (sp.au as string) : iso(today)
  const asOf = iso(today)
  const supabase = await createClient()

  const [settings, currencies, rates, positions, realized, vat, exportRows, report] = await Promise.all([
    supabase.from('finance_settings').select('base_currency').maybeSingle(),
    supabase.from('currencies').select('code,name,minor_units').order('code'),
    supabase.from('exchange_rates').select('currency,rate_date,rate').order('rate_date', { ascending: false }).limit(300),
    supabase.rpc('fx_open_positions', { p_as_of: asOf }),
    supabase.rpc('fx_realized_gains', { p_from: from, p_to: to }),
    supabase.rpc('vat_summary', { p_from: from, p_to: to }),
    supabase.rpc('export_controls', { p_from: from, p_to: to }),
    supabase.rpc('multicurrency_report', { p_from: from, p_to: to, p_as_of: asOf }),
  ])
  const base = (settings.data?.base_currency as string | undefined) ?? 'EUR'
  const errors = [positions, realized, vat, exportRows, report].filter((r) => r.error).map((r) => r.error?.message)
  const cur = (currencies.data ?? []) as { code: string; name: string; minor_units: number }[]
  const foreign = cur.filter((c) => c.code !== base)
  const latest = new Map<string, { date: string; rate: number }>()
  for (const r of (rates.data ?? []) as { currency: string; rate_date: string; rate: number }[]) {
    if (!latest.has(r.currency)) latest.set(r.currency, { date: r.rate_date, rate: Number(r.rate) })
  }
  const pos = (positions.data ?? []) as Row[]
  const rea = (realized.data ?? []) as Row[]
  const vatRows = (vat.data ?? []) as Row[]
  const exp = (exportRows.data ?? []) as Row[]
  const rep = (report.data ?? []) as Row[]
  const realizedTotal = rea.reduce((s, r) => s + Number(r.realized ?? 0), 0)
  const unrealizedTotal = pos.reduce((s, r) => s + Number(r.unrealized ?? 0), 0)

  return (
    <>
      <PageHeader title="Devises et fiscalité" description="Devise de base, taux de change, TVA par taux, contrôles de l’export, écarts de change et reporting multi-devise."
        actions={canWrite && <FxRateDialog currencies={foreign} base={base} />} />
      <div className="space-y-4 p-4 sm:p-6">
        {errors.length > 0 && <p className="rounded-md border border-warn-bg bg-warn-bg px-3 py-2 text-sm text-warn-text">Certaines données sont indisponibles : {errors.join(' ; ')}</p>}

        <form method="get" className="flex flex-wrap items-end gap-3 text-sm" aria-label="Période">
          <label className="flex flex-col gap-1">Du<input type="date" name="du" defaultValue={from} className="h-9 rounded-md border border-line-strong bg-surface px-2" /></label>
          <label className="flex flex-col gap-1">Au<input type="date" name="au" defaultValue={to} className="h-9 rounded-md border border-line-strong bg-surface px-2" /></label>
          <button className="h-9 rounded-md border border-line-strong px-3 font-medium hover:border-brand-500">Afficher</button>
          <p className="text-ink-soft">Positions latentes au {asOf}. Devise de base : <span className="font-semibold text-ink">{base}</span>.</p>
        </form>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader><CardTitle>Devises et derniers taux</CardTitle></CardHeader>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-medium">Devise</th><th className="font-medium">1 unité =</th><th className="font-medium">Taux du</th></tr></thead>
                <tbody>
                  {cur.map((c) => {
                    const l = latest.get(c.code)
                    return (
                      <tr key={c.code} className="border-t border-line">
                        <td className="px-4 py-2"><span className="font-mono font-semibold">{c.code}</span> <span className="text-ink-soft">{c.name}</span>{c.code === base && <span className="ml-2 rounded-full bg-brand-50 px-2 py-0.5 text-xs text-brand-700">base</span>}</td>
                        <td>{c.code === base ? `1 ${base}` : l ? `${l.rate.toFixed(c.minor_units + 1)} ${base}` : <span className="text-danger-text">taux manquant</span>}</td>
                        <td className="text-ink-soft">{c.code === base ? '—' : l?.date ?? '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Écarts de change</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-ink-soft">Réalisés sur la période</span><span className={cn('tabular-nums font-semibold', realizedTotal < 0 && 'text-danger-text')}>{signed(realizedTotal, base)}</span></div>
              <div className="flex justify-between"><span className="text-ink-soft">Latents au {asOf}</span><span className={cn('tabular-nums font-semibold', unrealizedTotal < 0 && 'text-danger-text')}>{signed(unrealizedTotal, base)}</span></div>
              <p className="pt-2 text-xs text-ink-faint">Réalisé : écart entre le taux figé sur la facture et le taux du jour du règlement. Latent : solde ouvert réévalué au taux du jour. Un montant négatif est une perte.</p>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader><CardTitle>Reporting multi-devise (du {from} au {to})</CardTitle></CardHeader>
          <CardContent className="overflow-x-auto p-0">
            {rep.length === 0 ? <p className="p-6 text-sm text-ink-soft">Aucune opération en devise sur la période.</p> : (
              <table className="w-full min-w-[52rem] text-sm">
                <thead className="text-left text-xs text-ink-soft"><tr>
                  <th className="px-4 py-2 font-medium">Devise</th><th className="font-medium">CA facturé (devise)</th><th className="font-medium">CA facturé ({base})</th>
                  <th className="font-medium">Créances ouvertes ({base})</th><th className="font-medium">Dettes ouvertes ({base})</th>
                  <th className="font-medium">Écart réalisé</th><th className="font-medium">Écart latent</th>
                </tr></thead>
                <tbody>
                  {rep.map((r) => {
                    const c = String(r.currency)
                    return (
                      <tr key={c} className="border-t border-line">
                        <td className="px-4 py-2 font-mono font-semibold">{c}</td>
                        <td>{money(r.invoiced_foreign, c)}</td>
                        <td>{money(r.invoiced_base, base)}</td>
                        <td>{money(r.receivable_open_base, base)}</td>
                        <td>{money(r.payable_open_base, base)}</td>
                        <td className={cn(Number(r.realized_gain) < 0 && 'text-danger-text')}>{signed(r.realized_gain, base)}</td>
                        <td className={cn(Number(r.unrealized_gain) < 0 && 'text-danger-text')}>{signed(r.unrealized_gain, base)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Positions latentes en devise</CardTitle></CardHeader>
          <CardContent className="overflow-x-auto p-0">
            {pos.length === 0 ? <p className="p-6 text-sm text-ink-soft">Aucun solde ouvert en devise étrangère.</p> : (
              <table className="w-full min-w-[46rem] text-sm">
                <thead className="text-left text-xs text-ink-soft"><tr>
                  <th className="px-4 py-2 font-medium">Type</th><th className="font-medium">Document</th><th className="font-medium">Tiers</th><th className="font-medium">Solde ouvert</th>
                  <th className="font-medium">Taux figé</th><th className="font-medium">Taux du jour</th><th className="font-medium">Latent ({base})</th>
                </tr></thead>
                <tbody>
                  {pos.map((r) => (
                    <tr key={`${r.kind}-${r.document_id}`} className="border-t border-line">
                      <td className="px-4 py-2">{r.kind === 'receivable' ? 'Créance client' : 'Dette fournisseur'}</td>
                      <td className="font-mono text-xs">{String(r.number)}</td>
                      <td>{String(r.counterparty)}</td>
                      <td>{money(r.open_amount, String(r.currency))}</td>
                      <td>{Number(r.rate_booked).toFixed(4)}</td>
                      <td>{Number(r.rate_today).toFixed(4)}</td>
                      <td className={cn(Number(r.unrealized) < 0 && 'text-danger-text')}>{signed(r.unrealized, base)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader><CardTitle>TVA collectée par taux ({base})</CardTitle></CardHeader>
            <CardContent className="overflow-x-auto p-0">
              {vatRows.length === 0 ? <p className="p-6 text-sm text-ink-soft">Aucune facture émise sur la période.</p> : (
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-medium">Taux</th><th className="font-medium">Libellé</th><th className="font-medium">Factures</th><th className="font-medium">Base HT</th><th className="font-medium">TVA</th><th className="font-medium">TTC</th></tr></thead>
                  <tbody>
                    {vatRows.map((v) => (
                      <tr key={String(v.tax_rate)} className="border-t border-line">
                        <td className="px-4 py-2">{Number(v.tax_rate)} %</td>
                        <td className="text-ink-soft">{String(v.label ?? '—')}</td>
                        <td>{String(v.invoices_count)}</td>
                        <td>{money(v.base_ht, base)}</td>
                        <td>{money(v.base_tva, base)}</td>
                        <td>{money(v.base_ttc, base)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="px-4 py-3 text-xs text-ink-faint">Les avoirs ne sont pas encore déduits : à rapprocher avant toute déclaration. Les taux doivent être validés par votre expert-comptable.</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Contrôles fiscalité export</CardTitle></CardHeader>
            <CardContent className="space-y-2 p-4 text-sm">
              {exp.length === 0 ? <p className="text-ink-soft">Aucune facture d’export sur la période.</p> : exp.map((r) => {
                const issues = (r.issues as string[] | null) ?? []
                return (
                  <div key={String(r.invoice_id)} className={cn('rounded-md border px-3 py-2', issues.length ? 'border-danger-text/40 bg-danger-bg' : 'border-line bg-canvas')}>
                    <p className="font-medium">{String(r.code)} · {String(r.client_name)} <span className="text-ink-soft">({String(r.country)})</span></p>
                    {issues.length === 0 ? <p className="text-xs text-success-text">Conforme : export sans TVA, preuve d’expédition présente.</p> : issues.map((i) => <p key={i} className="text-xs text-danger-text">{i}</p>)}
                  </div>
                )
              })}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  )
}
