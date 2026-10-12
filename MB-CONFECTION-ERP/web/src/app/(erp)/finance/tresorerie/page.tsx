import type { Metadata } from 'next'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { CashAccountDialog, CashMovementDialog } from '@/features/finance/components/finance-forms'
import { listCashAccounts, listCashMovements, treasuryPosition } from '@/features/finance/services/finance.service'
import { formatMoney } from '@/lib/bom/options'
import { P } from '@/lib/rbac/permissions'
import { formatDateTime } from '@/lib/utils'

export const metadata: Metadata = { title: 'Trésorerie' }

export default async function TreasuryPage() {
  const ctx = await requirePermission(P.FINANCE_READ)
  const canWrite = ctx.permissions.includes(P.FINANCE_WRITE)
  const today = new Date().toISOString().slice(0, 10)
  const [pos, accounts, movements] = await Promise.all([treasuryPosition(today), listCashAccounts(), listCashMovements()])
  const lines = [
    { l: 'Soldes d’ouverture', v: pos.opening }, { l: 'Encaissements clients', v: pos.receipts }, { l: 'Règlements fournisseurs', v: -pos.payments },
    { l: 'Autres entrées', v: pos.manual_in }, { l: 'Autres sorties', v: -pos.manual_out },
  ]
  return (
    <>
      <PageHeader title="Trésorerie" description="Position consolidée : soldes d’ouverture, encaissements, règlements et mouvements manuels. Les encaissements ne sont pas rattachés à un compte bancaire."
        actions={canWrite && <div className="flex flex-wrap gap-2"><CashAccountDialog />{accounts.length > 0 && <CashMovementDialog accounts={accounts} />}</div>} />
      <div className="space-y-4 p-4 sm:p-6">
        <Card>
          <CardHeader><CardTitle>Position au {today}</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {lines.map((x) => (
              <div key={x.l} className="flex justify-between"><span className="text-ink-soft">{x.l}</span><span className="tabular-nums">{formatMoney(x.v)}</span></div>
            ))}
            <div className="flex justify-between border-t border-line pt-2 text-base font-semibold"><span>Trésorerie</span><span className="tabular-nums">{formatMoney(pos.balance)}</span></div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Comptes</CardTitle></CardHeader>
          <CardContent className="p-0">
            {accounts.length === 0 ? <p className="p-6 text-sm text-ink-soft">Aucun compte. Créez un compte pour démarrer la trésorerie.</p> : (
              <ul className="divide-y divide-line">{accounts.map((a) => (
                <li key={a.id} className="flex items-center justify-between px-4 py-2 text-sm"><span>{a.name} <span className="text-xs text-ink-soft">depuis le {formatDateTime(a.opening_date)}</span></span><span className="flex items-center gap-2 tabular-nums">{formatMoney(a.opening_balance)} {!a.active && <Badge tone="neutral">Inactif</Badge>}</span></li>
              ))}</ul>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Mouvements manuels</CardTitle></CardHeader>
          <CardContent className="p-0">
            {movements.length === 0 ? <p className="p-6 text-sm text-ink-soft">Aucun mouvement manuel.</p> : (
              <div className="overflow-x-auto"><table className="w-full min-w-[36rem] text-sm">
                <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Date</th><th className="px-2 py-2 font-semibold">Compte</th><th className="px-2 py-2 font-semibold">Libellé</th><th className="px-2 py-2 text-right font-semibold">Montant</th></tr></thead>
                <tbody className="divide-y divide-line">{movements.map((m) => (
                  <tr key={m.id}><td className="px-4 py-2 text-xs">{formatDateTime(m.moved_on)}</td><td className="px-2 py-2">{m.account_name}</td><td className="px-2 py-2">{m.label}</td><td className={`px-2 py-2 text-right tabular-nums ${m.direction === 'in' ? 'text-success-text' : 'text-danger-text'}`}>{m.direction === 'in' ? '+' : '−'} {formatMoney(m.amount)}</td></tr>
                ))}</tbody>
              </table></div>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  )
}
