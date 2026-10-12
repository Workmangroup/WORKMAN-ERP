import type { Metadata } from 'next'
import { PageHeader } from '@/components/layout/page-header'
import { Card } from '@/components/ui/card'
import { requirePermission } from '@/features/auth/guards'
import { getAuthContext } from '@/features/auth/services/access.service'
import { ApprovalActions } from '@/features/approvals/components/approval-actions'
import { decisionsOf, listApprovalRequests } from '@/features/approvals/services/approvals.service'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Approbations' }

const STATE: Record<string, string> = {
  pending_l1: 'En attente (1er niveau)',
  pending_l2: 'En attente (2nd niveau)',
  approved: 'Approuvée',
  refused: 'Refusée',
  cancelled: 'Annulée',
  invalidated: 'Invalidée (contenu modifié)',
}
const OPEN = new Set(['pending_l1', 'pending_l2'])

export default async function ApprovalsPage() {
  await requirePermission(P.APPROVALS_READ)
  const perms = (await getAuthContext())?.permissions ?? []
  const canDecide = perms.includes(P.APPROVALS_DECIDE) || perms.includes(P.APPROVALS_DECIDE_HIGH)
  const canEscalate = perms.includes(P.APPROVALS_ESCALATE)

  const requests = await listApprovalRequests()
  const journal = await decisionsOf(requests.map((r) => r.id))
  const now = Date.now()

  return (
    <>
      <PageHeader
        title="Approbations"
        description="Demandes, décisions et refus motivés. Un accord ne vaut que pour le contenu approuvé : une modification l’invalide."
      />
      <Card className="mb-6 overflow-x-auto">
        {requests.length === 0 ? (
          <p className="p-4 text-sm text-ink-soft">Aucune demande d’approbation.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="text-ink-soft">
              <tr>
                <th className="p-3">Demandée le</th><th className="p-3">Type</th><th className="p-3">Version</th><th className="p-3">Montant</th>
                <th className="p-3">État</th><th className="p-3">Échéance</th><th className="p-3">Historique</th><th className="p-3">Action</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => {
                const open = OPEN.has(r.state)
                const overdue = open && new Date(r.deadline_at).getTime() < now
                const events = journal.get(r.id) ?? []
                return (
                  <tr key={r.id} className="border-t border-line align-top">
                    <td className="p-3">{new Date(r.requested_at).toLocaleString('fr-FR')}</td>
                    <td className="p-3">{r.object_type}</td>
                    <td className="p-3">v{r.object_version}<div className="font-mono text-xs text-ink-faint">{r.object_hash.slice(0, 12)}…</div></td>
                    <td className="p-3">{r.amount ?? '—'}</td>
                    <td className="p-3">{STATE[r.state] ?? r.state}{r.refusal_reason && <div className="text-xs">Motif : {r.refusal_reason}</div>}</td>
                    <td className="p-3">{new Date(r.deadline_at).toLocaleString('fr-FR')}{overdue && <div className="text-xs text-danger">Échue</div>}</td>
                    <td className="p-3">
                      <ul className="space-y-1 text-xs">
                        {events.map((e) => (
                          <li key={e.id}>{new Date(e.created_at).toLocaleString('fr-FR')} · {e.action}{e.level ? ` (niveau ${e.level})` : ''}{e.to_state ? ` → ${e.to_state}` : ''}{e.reason ? ` · ${e.reason}` : ''}</li>
                        ))}
                      </ul>
                    </td>
                    <td className="p-3 min-w-56">
                      {open && (canDecide || canEscalate) ? (
                        <ApprovalActions id={r.id} canDecide={canDecide} canEscalate={canEscalate} overdue={overdue} />
                      ) : (
                        <span className="text-ink-faint">—</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Card>
    </>
  )
}
