import type { Metadata } from 'next'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { GenerateRemindersButton, MarkSentButton } from '@/features/finance/components/finance-forms'
import { listReminders } from '@/features/finance/services/finance.service'
import { formatMoney } from '@/lib/bom/options'
import { P } from '@/lib/rbac/permissions'
import { formatDateTime } from '@/lib/utils'

export const metadata: Metadata = { title: 'Relances clients' }

const LEVEL: Record<number, { label: string; tone: 'neutral' | 'warning' | 'danger' }> = {
  1: { label: 'Niveau 1 — rappel (1-30 j)', tone: 'neutral' },
  2: { label: 'Niveau 2 — mise en demeure (31-60 j)', tone: 'warning' },
  3: { label: 'Niveau 3 — dernier avis (> 60 j)', tone: 'danger' },
}

export default async function RemindersPage() {
  const ctx = await requirePermission(P.FINANCE_READ)
  const canWrite = ctx.permissions.includes(P.FINANCE_WRITE)
  const rows = await listReminders()
  const pending = rows.filter((r) => r.status === 'pending')
  return (
    <>
      <PageHeader title="Relances clients" description="Une relance par niveau et par facture échue. Le module crée les relances ; l’envoi reste manuel et se confirme ensuite."
        actions={canWrite && <GenerateRemindersButton />} />
      <div className="space-y-4 p-4 sm:p-6">
        <p className="text-sm text-ink-soft">{pending.length} relance(s) à envoyer.</p>
        {rows.length === 0 ? (
          <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">Aucune relance. Générez les relances pour les factures échues.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
            <table className="w-full min-w-[46rem] text-sm">
              <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Client</th><th className="px-2 py-2 font-semibold">Facture</th><th className="px-2 py-2 font-semibold">Niveau</th><th className="px-2 py-2 text-right font-semibold">Retard</th><th className="px-2 py-2 text-right font-semibold">Reste dû</th><th className="px-2 py-2 font-semibold">Statut</th><th className="px-2 py-2" /></tr></thead>
              <tbody className="divide-y divide-line">{rows.map((r) => (
                <tr key={r.id}>
                  <td className="px-4 py-2">{r.client_name}</td>
                  <td className="px-2 py-2 font-mono text-xs">{r.invoice_code ?? '—'}</td>
                  <td className="px-2 py-2"><Badge tone={LEVEL[r.level]?.tone ?? 'neutral'}>{LEVEL[r.level]?.label ?? `Niveau ${r.level}`}</Badge></td>
                  <td className="px-2 py-2 text-right tabular-nums">{r.days_late} j</td>
                  <td className="px-2 py-2 text-right font-semibold tabular-nums">{formatMoney(r.balance)}</td>
                  <td className="px-2 py-2">{r.status === 'sent' ? <Badge tone="success">Envoyée {r.sent_at ? formatDateTime(r.sent_at) : ''}</Badge> : <Badge tone="warning">À envoyer</Badge>}</td>
                  <td className="px-2 py-2 text-right">{canWrite && r.status === 'pending' && <MarkSentButton reminderId={r.id} />}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}
