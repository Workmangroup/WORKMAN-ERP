import type { Metadata } from 'next'
import Link from 'next/link'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { RpcButton } from '@/features/stock/components/rpc-button'
import { closeGlPeriodAction } from '@/features/finance/gl-actions'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'
import { cn } from '@/lib/utils'

export const metadata: Metadata = { title: 'Comptabilité générale' }

const PERIOD = /^\d{4}-\d{2}-\d{2}$/
const iso = (d: Date) => d.toISOString().slice(0, 10)
const money = (v: unknown) => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(Number(v ?? 0))

/** Balance, grand livre par compte et clôture des périodes. Lecture : finance.read ; clôture : finance.write. */
export default async function GeneralLedgerPage({ searchParams }: { searchParams: Promise<{ du?: string; au?: string; compte?: string }> }) {
  const ctx = await requirePermission(P.FINANCE_READ)
  const canWrite = ctx.permissions.includes(P.FINANCE_WRITE)
  const sp = await searchParams
  const today = new Date()
  const from = PERIOD.test(sp.du ?? '') ? (sp.du as string) : iso(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)))
  const to = PERIOD.test(sp.au ?? '') ? (sp.au as string) : iso(today)
  const account = /^[0-9]{3,8}$/.test(sp.compte ?? '') ? (sp.compte as string) : null
  const supabase = await createClient()

  const [balance, periods, ledger] = await Promise.all([
    supabase.rpc('gl_trial_balance', { p_from: from, p_to: to }),
    supabase.from('gl_periods').select('year,month,status').order('year', { ascending: false }).order('month', { ascending: false }).limit(12),
    account ? supabase.rpc('gl_ledger', { p_account: account, p_from: from, p_to: to }) : Promise.resolve({ data: null, error: null }),
  ])
  const rows = (balance.data ?? []) as { account_code: string; account_label: string; total_debit: number; total_credit: number; balance: number }[]
  const totalD = rows.reduce((s, r) => s + Number(r.total_debit), 0)
  const totalC = rows.reduce((s, r) => s + Number(r.total_credit), 0)
  const lines = (ledger.data ?? []) as { entry_date: string; number: string; label: string; debit: number; credit: number; running_balance: number }[]
  const pers = (periods.data ?? []) as { year: number; month: number; status: string }[]
  const current = { year: today.getUTCFullYear(), month: today.getUTCMonth() + 1 }

  return (
    <>
      <PageHeader title="Comptabilité générale" description="Écritures générées automatiquement (ventes, achats, encaissements, règlements, avoirs). Plan comptable provisoire : à valider par l’expert-comptable." />
      <div className="space-y-4 p-4 sm:p-6">
        {balance.error && <p className="rounded-md border border-warn-bg bg-warn-bg px-3 py-2 text-sm text-warn-text">Balance indisponible : {balance.error.message}</p>}

        <form method="get" className="flex flex-wrap items-end gap-3 text-sm" aria-label="Période">
          <label className="flex flex-col gap-1">Du<input type="date" name="du" defaultValue={from} className="h-9 rounded-md border border-line-strong bg-surface px-2" /></label>
          <label className="flex flex-col gap-1">Au<input type="date" name="au" defaultValue={to} className="h-9 rounded-md border border-line-strong bg-surface px-2" /></label>
          <button className="h-9 rounded-md border border-line-strong px-3 font-medium hover:border-brand-500">Afficher</button>
        </form>

        <Card>
          <CardHeader><CardTitle>Balance des comptes</CardTitle></CardHeader>
          <CardContent className="overflow-x-auto p-0">
            {rows.length === 0 ? <p className="p-6 text-sm text-ink-soft">Aucune écriture validée sur la période.</p> : (
              <table className="w-full min-w-[40rem] text-sm">
                <thead className="text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-medium">Compte</th><th className="font-medium">Libellé</th><th className="font-medium">Débit</th><th className="font-medium">Crédit</th><th className="font-medium">Solde</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.account_code} className="border-t border-line">
                      <td className="px-4 py-2 font-mono"><Link href={`/finance/comptabilite?du=${from}&au=${to}&compte=${r.account_code}`} className="text-brand-700 hover:underline">{r.account_code}</Link></td>
                      <td>{r.account_label}</td>
                      <td>{money(r.total_debit)}</td>
                      <td>{money(r.total_credit)}</td>
                      <td className={cn(Number(r.balance) < 0 && 'text-danger-text')}>{money(r.balance)}</td>
                    </tr>
                  ))}
                  <tr className="border-t-2 border-line font-semibold"><td className="px-4 py-2" colSpan={2}>Total</td><td>{money(totalD)}</td><td>{money(totalC)}</td><td>{Math.abs(totalD - totalC) < 0.005 ? 'Équilibré' : 'Déséquilibré'}</td></tr>
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>

        {account && (
          <Card>
            <CardHeader><CardTitle>Grand livre du compte {account}</CardTitle></CardHeader>
            <CardContent className="overflow-x-auto p-0">
              {ledger.error ? <p className="p-6 text-sm text-danger-text">{ledger.error.message}</p> : lines.length === 0 ? <p className="p-6 text-sm text-ink-soft">Aucun mouvement sur ce compte.</p> : (
                <table className="w-full min-w-[40rem] text-sm">
                  <thead className="text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-medium">Date</th><th className="font-medium">Écriture</th><th className="font-medium">Libellé</th><th className="font-medium">Débit</th><th className="font-medium">Crédit</th><th className="font-medium">Solde progressif</th></tr></thead>
                  <tbody>
                    {lines.map((l) => (
                      <tr key={`${l.number}-${l.label}-${l.running_balance}`} className="border-t border-line">
                        <td className="px-4 py-2">{l.entry_date}</td>
                        <td className="font-mono text-xs">{l.number}</td>
                        <td>{l.label}</td>
                        <td>{money(l.debit)}</td>
                        <td>{money(l.credit)}</td>
                        <td>{money(l.running_balance)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader><CardTitle>Périodes</CardTitle></CardHeader>
          <CardContent className="space-y-3 p-4 text-sm">
            {pers.length === 0 ? <p className="text-ink-soft">Aucune période encore ouverte.</p> : (
              <ul className="divide-y divide-line">
                {pers.map((p) => (
                  <li key={`${p.year}-${p.month}`} className="flex items-center justify-between py-2">
                    <span>{String(p.month).padStart(2, '0')}/{p.year}</span>
                    <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', p.status === 'closed' ? 'bg-canvas text-ink-soft' : 'bg-success-bg text-success-text')}>{p.status === 'closed' ? 'Clôturée' : 'Ouverte'}</span>
                  </li>
                ))}
              </ul>
            )}
            {canWrite && (
              <div className="flex flex-wrap items-center gap-3 pt-2">
                <RpcButton action={closeGlPeriodAction} fields={{ year: String(current.year), month: String(current.month) }}
                  confirm={`Clôturer ${String(current.month).padStart(2, '0')}/${current.year} ? Aucune écriture ne pourra plus être ajoutée à cette période.`}
                  pendingText="Clôture…">
                  Clôturer le mois en cours
                </RpcButton>
                <span className="text-xs text-ink-faint">Refusé tant qu’une écriture est en brouillon.</span>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  )
}
