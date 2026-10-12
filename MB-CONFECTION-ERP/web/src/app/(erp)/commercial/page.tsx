import type { Metadata } from 'next'
import Link from 'next/link'
import { PageHeader } from '@/components/layout/page-header'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { requireAnyPermission } from '@/features/auth/guards'
import { getDashboard } from '@/features/commercial/services/commercial.service'
import { STAGE_INFO, money } from '@/features/commercial/status'
import { P } from '@/lib/rbac/permissions'
import { cn } from '@/lib/utils'

export const metadata: Metadata = { title: 'Commercial' }

const Kpi = ({ label, value, hint, tone, href }: { label: string; value: string; hint?: string; tone?: 'warning' | 'danger' | 'success'; href?: string }) => {
  const body = (
    <div className={cn('h-full rounded-md border p-3 shadow-card', tone === 'danger' ? 'border-danger/40 bg-danger-bg' : tone === 'warning' ? 'border-warn/40 bg-warn-bg' : tone === 'success' ? 'border-success/30 bg-success-bg' : 'border-line bg-white', href && 'transition-colors hover:border-brand-400')}>
      <p className="text-xs text-ink-soft">{label}</p><p className="text-xl font-semibold tabular-nums">{value}</p>{hint && <p className="text-[11px] text-ink-faint">{hint}</p>}
    </div>
  )
  return href ? <Link href={href} className="block">{body}</Link> : body
}

export default async function CommercialDashboard() {
  const ctx = await requireAnyPermission(P.PROSPECTS_READ, P.QUOTES_READ, P.INVOICES_READ, P.ORDERS_READ)
  const d = await getDashboard()
  const perms = ctx.permissions
  const max = Math.max(1, ...(d?.invoices?.by_month ?? []).map((m) => Number(m.amount)))
  return (
    <>
      <PageHeader title="Tableau de bord commercial" description="Prospects → devis → commandes → factures : pipeline, chiffre d’affaires et encaissements."
        actions={<>
          {perms.includes(P.PROSPECTS_WRITE) && <Link href="/commercial/prospects/new" className={buttonVariants({ variant: 'command', size: 'sm' })}>Nouveau prospect</Link>}
          {perms.includes(P.QUOTES_WRITE) && <Link href="/commercial/quotes/new" className={buttonVariants({ variant: 'command', size: 'sm' })}>Nouveau devis</Link>}
        </>} />
      <div className="space-y-6 p-4 sm:p-6">
        {!d ? <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">Tableau de bord indisponible.</p> : (
          <>
            {d.invoices && (
              <section className="space-y-3">
                <h2 className="text-base font-semibold">Chiffre d’affaires et encaissements</h2>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
                  <Kpi label="CA du mois (HT)" value={money(d.invoices.invoiced_month)} hint="factures − avoirs" />
                  <Kpi label="CA de l’année (HT)" value={money(d.invoices.invoiced_year)} hint={`avoirs : ${money(d.invoices.credit_notes_year)} TTC`} />
                  <Kpi label="Encaissé ce mois" value={money(d.invoices.collected_month)} tone="success" />
                  <Kpi label="À encaisser" value={money(d.invoices.outstanding)} hint="factures ouvertes (TTC)" href="/commercial/invoices?status=issued" />
                  <Kpi label="Impayés en retard" value={money(d.invoices.overdue_amount)} hint={`${d.invoices.overdue_count} facture(s)`} tone={d.invoices.overdue_count > 0 ? 'danger' : undefined} href="/commercial/invoices?overdue=1" />
                  <Kpi label="Factures brouillon" value={String(d.invoices.drafts)} href="/commercial/invoices?status=draft" />
                </div>
                <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                  <div className="rounded-md border border-line bg-white p-4 shadow-card">
                    <p className="mb-2 text-sm font-semibold">Facturation HT par mois</p>
                    <ul className="flex h-36 items-end gap-1.5" aria-label="Facturation par mois">
                      {d.invoices.by_month.map((m) => (
                        <li key={m.month} className="flex h-full flex-1 flex-col items-center justify-end gap-1" title={`${m.month} : ${money(Number(m.amount))}`}>
                          <span className="w-full rounded-t-sm bg-brand-500" style={{ height: `${(Number(m.amount) / max) * 100}%`, minHeight: Number(m.amount) > 0 ? 3 : 0 }} />
                          <span className="text-[10px] text-ink-faint">{m.month.slice(5)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="rounded-md border border-line bg-white p-4 shadow-card">
                    <p className="mb-2 text-sm font-semibold">Meilleurs clients (année)</p>
                    {d.invoices.top_clients.length === 0 ? <p className="text-sm text-ink-soft">Aucune facture émise.</p> : (
                      <ol className="space-y-1.5 text-sm">{d.invoices.top_clients.map((c, i) => <li key={c.client_id} className="flex justify-between gap-2"><Link href={`/clients/${c.client_id}`} className="truncate text-brand-700 hover:underline">{i + 1}. {c.name}</Link><span className="tabular-nums">{money(Number(c.amount))}</span></li>)}</ol>
                    )}
                  </div>
                </div>
              </section>
            )}

            {d.prospects && (
              <section className="space-y-3">
                <h2 className="text-base font-semibold">Pipeline</h2>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <Kpi label="Opportunités ouvertes" value={String(d.prospects.open_count)} hint={money(d.prospects.open_value)} href="/commercial/pipeline" />
                  <Kpi label="Prévision pondérée" value={money(d.prospects.weighted_value)} hint="valeur × probabilité d’étape" />
                  <Kpi label="Relances en retard" value={String(d.prospects.overdue_actions)} tone={d.prospects.overdue_actions > 0 ? 'warning' : undefined} href="/commercial/prospects" />
                  <Kpi label="Gagnés / perdus (90 j)" value={`${d.prospects.won_90d} / ${d.prospects.lost_90d}`} />
                </div>
                <ul className="grid gap-2 sm:grid-cols-5">
                  {d.prospects.by_stage.map((s) => (
                    <li key={s.stage} className="rounded-md border border-line bg-white p-3 shadow-card">
                      <Badge tone={STAGE_INFO[s.stage].tone}>{STAGE_INFO[s.stage].label}</Badge>
                      <p className="mt-1 text-lg font-semibold tabular-nums">{s.count}</p><p className="text-xs text-ink-soft">{money(Number(s.value))}</p>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <div className="grid gap-6 lg:grid-cols-2">
              {d.quotes && (
                <section className="space-y-3">
                  <h2 className="text-base font-semibold">Devis</h2>
                  <div className="grid grid-cols-2 gap-3">
                    <Kpi label="En attente de réponse" value={String(d.quotes.sent_count)} hint={money(d.quotes.sent_value)} href="/commercial/quotes?status=sent" />
                    <Kpi label="Brouillons" value={String(d.quotes.draft_count)} href="/commercial/quotes?status=draft" />
                    <Kpi label="Expirent sous 7 jours" value={String(d.quotes.expiring_7d)} tone={d.quotes.expiring_7d > 0 ? 'warning' : undefined} />
                    <Kpi label="Expirés non traités" value={String(d.quotes.expired)} tone={d.quotes.expired > 0 ? 'danger' : undefined} />
                    <Kpi label="Taux de transformation" value={d.quotes.conversion_rate === null ? '—' : `${String(d.quotes.conversion_rate).replace('.', ',')} %`} hint="sur 90 jours" />
                    <Kpi label="Devis gagnés (90 j)" value={money(d.quotes.won_90d_value)} tone="success" />
                  </div>
                </section>
              )}
              {d.orders && (
                <section className="space-y-3">
                  <h2 className="text-base font-semibold">Commandes</h2>
                  <div className="grid grid-cols-2 gap-3">
                    <Kpi label="À confirmer" value={String(d.orders.to_confirm)} tone={d.orders.to_confirm > 0 ? 'warning' : undefined} href="/orders?status=draft" />
                    <Kpi label="Confirmées en cours" value={String(d.orders.open_count)} href="/orders?status=confirmed" />
                    <Kpi label="À facturer" value={String(d.orders.to_invoice_count)} hint="commandes confirmées non soldées" href="/orders?status=confirmed" />
                    <Kpi label="Reste à facturer (HT)" value={money(d.orders.to_invoice_value)} />
                  </div>
                </section>
              )}
            </div>
          </>
        )}
      </div>
    </>
  )
}
