import type { Metadata } from 'next'
import { PageHeader } from '@/components/layout/page-header'
import { requireAnyPermission } from '@/features/auth/guards'
import { BudgetForm } from '@/features/purchases/components/budget-forms'
import { budgetRows, budgetState, costCenterOptions } from '@/features/purchases/services/purchases.service'
import { fmtDay } from '@/features/purchases/status'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Budgets d’achat' }

const money = (n: number) => n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default async function BudgetsPage() {
  const ctx = await requireAnyPermission(P.PURCHASES_READ)
  const canManage = ctx.permissions.includes(P.FINANCE_WRITE)
  const [rows, ccs] = await Promise.all([budgetRows(), costCenterOptions()])
  const states = await Promise.all(rows.map((b) => budgetState(b.cost_center_id, b.period_start)))
  return (
    <>
      <PageHeader title="Budgets d’achat"
        description="Engagé : demandes soumises ou approuvées, et reste à recevoir des commandes ouvertes. Réalisé : quantités reçues au prix de commande, nettes des retours." />
      <div className="space-y-6 p-4 sm:p-6">
        <section className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
          <table className="w-full min-w-[52rem] text-sm">
            <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft">
              <tr><th className="px-4 py-2 font-semibold">Centre de coût</th><th className="px-2 py-2 font-semibold">Période</th><th className="px-2 py-2 text-right font-semibold">Montant</th><th className="px-2 py-2 text-right font-semibold">Engagé</th><th className="px-2 py-2 text-right font-semibold">Réalisé</th><th className="px-2 py-2 text-right font-semibold">Disponible</th>{canManage && <th className="px-4 py-2 font-semibold">Révision</th>}</tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.length === 0 && <tr><td colSpan={canManage ? 7 : 6} className="p-6 text-center text-ink-soft">Aucun budget défini. Une demande sur un centre sans budget ne peut pas être soumise.</td></tr>}
              {rows.map((b, i) => {
                const s = states[i]
                return (
                  <tr key={b.id} className="align-top">
                    <td className="px-4 py-2"><span className="font-medium">{b.label}</span><span className="ml-2 font-mono text-xs text-ink-faint">{b.code}</span></td>
                    <td className="whitespace-nowrap px-2 py-2">{fmtDay(b.period_start)} → {fmtDay(b.period_end)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{money(b.amount)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{s ? money(s.engaged) : '—'}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{s ? money(s.realised) : '—'}</td>
                    <td className={`px-2 py-2 text-right font-semibold tabular-nums ${s && s.available < 0 ? 'text-danger-text' : ''}`}>{s ? money(s.available) : '—'}</td>
                    {canManage && <td className="px-4 py-2"><details><summary className="cursor-pointer text-brand-700 hover:underline">Réviser le montant</summary><div className="mt-2 w-80"><BudgetForm costCenters={ccs} budget={b} /></div></details></td>}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </section>
        {canManage && (
          <section className="rounded-md border border-line bg-white p-5 shadow-card">
            <h2 className="mb-3 text-base font-semibold">Nouveau budget</h2>
            <BudgetForm costCenters={ccs} />
          </section>
        )}
      </div>
    </>
  )
}
