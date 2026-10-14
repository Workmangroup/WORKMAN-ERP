import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/layout/page-header'
import { requireAuth } from '@/features/auth/guards'
import { DelegationForm, DerogationRequestForm, DecisionForm, MarkCriticalForm, PaymentOrderForm, RevokeForm } from '@/features/governance/components/governance-forms'
import { paymentOrderExecuteAction } from '@/features/governance/actions'
import { getGovernanceData, getOpenInspections, hasGovernanceAccess, type DelegationRow, type DerogationRow, type PaymentOrderRow } from '@/features/governance/services/governance.service'
import { RpcButton } from '@/features/stock/components/rpc-button'
import { P } from '@/lib/rbac/permissions'
import { formatDateTime } from '@/lib/utils'

export const metadata: Metadata = { title: 'Délégations et contrôles' }

const PERM_LABEL: Record<string, string> = {
  'payments.approve': 'Approuver un paiement',
  'derogations.approve': 'Approuver une dérogation',
  'derogations.control': 'Contrôler une dérogation',
  'quality.approve': 'Libérer un lot qualité',
}
const PAYMENT_TONE = { prepared: 'warning', approved: 'brand', rejected: 'danger', executed: 'success' } as const
const PAYMENT_LABEL = { prepared: 'Préparé', approved: 'Approuvé (à régler)', rejected: 'Refusé', executed: 'Réglé' } as const
const DERO_TONE = { requested: 'warning', approved: 'brand', controlled: 'success', rejected: 'danger' } as const
const DERO_LABEL = { requested: 'Demandée', approved: 'Approuvée (attente contrôle)', controlled: 'Contrôlée (effective)', rejected: 'Refusée' } as const

/** État d'une délégation à l'instant présent (la base reste l'autorité : cette étiquette ne sert qu'à l'affichage). */
function delegationState(d: DelegationRow, now: number): { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' } {
  if (d.revoked_at) return { label: 'Révoquée', tone: 'danger' }
  if (now < Date.parse(d.starts_at)) return { label: 'Pas encore active', tone: 'warning' }
  if (now > Date.parse(d.ends_at)) return { label: 'Expirée', tone: 'neutral' }
  return { label: 'Active', tone: 'success' }
}

function Section({ title, children, note }: { title: string; children: React.ReactNode; note?: string }) {
  return (
    <section className="space-y-3 rounded-md border border-line bg-white p-4 shadow-card">
      <div>
        <h2 className="text-base font-semibold text-ink">{title}</h2>
        {note && <p className="text-sm text-ink-soft">{note}</p>}
      </div>
      {children}
    </section>
  )
}

export default async function GovernancePage() {
  const ctx = await requireAuth()
  const me = ctx.user.id
  const perms = ctx.permissions
  const can = (p: string) => perms.includes(p)
  // Refus par défaut : droit de gouvernance ou délégation active, vérifié en base
  if (!(await hasGovernanceAccess())) notFound()
  const data = await getGovernanceData()
  const openInspections = can(P.QUALITY_APPROVE) ? await getOpenInspections() : []
  const name = new Map(data.people.map((p) => [p.id, p.full_name]))
  const who = (id: string | null) => (id ? (id === me ? 'vous' : name.get(id) ?? 'utilisateur') : '—')
  const now = Date.now()

  return (
    <>
      <PageHeader title="Délégations et contrôles" description="Délégations datées et bornées, séparation des tâches, dérogations à double contrôle." />
      <div className="space-y-4 p-4 sm:p-6">
        <Alert tone="info">
          Une personne ne peut pas approuver ce qu’elle a préparé ou demandé. Une délégation expire, se borne à un objet ou à un montant, et ne donne jamais accès à la paie, aux marges ou aux prix. Les refus sont imposés par la base.
        </Alert>

        <Section title="Délégations" note="Pouvoirs d’approbation confiés à une autre personne pour une durée limitée (90 jours au plus).">
          {data.delegations.length === 0 ? (
            <p className="text-sm text-ink-soft">Aucune délégation.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[52rem] text-sm">
                <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft">
                  <tr><th className="px-3 py-2">Délégant</th><th className="px-3 py-2">Délégué</th><th className="px-3 py-2">Pouvoir</th><th className="px-3 py-2">Limites</th><th className="px-3 py-2">Période</th><th className="px-3 py-2">État</th><th className="px-3 py-2">Motif</th><th className="px-3 py-2" /></tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {data.delegations.map((d) => {
                    const st = delegationState(d, now)
                    const canRevoke = !d.revoked_at && (d.delegator_id === me || can(P.DELEGATIONS_MANAGE))
                    return (
                      <tr key={d.id} className="align-top">
                        <td className="px-3 py-2">{who(d.delegator_id)}</td>
                        <td className="px-3 py-2">{who(d.delegate_id)}</td>
                        <td className="px-3 py-2">{PERM_LABEL[d.permission] ?? d.permission}</td>
                        <td className="px-3 py-2">{d.object_id ? `objet ${d.object_id.slice(0, 8)}…` : `tous (${d.object_type})`}{d.amount_limit != null ? ` · ≤ ${d.amount_limit}` : ''}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{formatDateTime(d.starts_at)} → {formatDateTime(d.ends_at)}</td>
                        <td className="px-3 py-2"><Badge tone={st.tone}>{st.label}</Badge></td>
                        <td className="px-3 py-2">{d.reason}</td>
                        <td className="px-3 py-2">{canRevoke && <RevokeForm id={d.id} />}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          {can(P.DELEGATIONS_GRANT) && (
            <div className="border-t border-line pt-4">
              <h3 className="mb-2 text-sm font-semibold text-ink">Accorder une délégation</h3>
              <DelegationForm people={data.people.filter((p) => p.id !== me)} />
            </div>
          )}
        </Section>

        <Section title="Ordres de paiement fournisseur" note="Le préparateur ne peut pas approuver son propre ordre. L’approbation exige le droit « Approuver un paiement » ou une délégation valide.">
          {data.payments.length === 0 ? (
            <p className="text-sm text-ink-soft">Aucun ordre de paiement.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[48rem] text-sm">
                <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft">
                  <tr><th className="px-3 py-2">Numéro</th><th className="px-3 py-2">Fournisseur</th><th className="px-3 py-2 text-right">Montant</th><th className="px-3 py-2">Préparé par</th><th className="px-3 py-2">Décision</th><th className="px-3 py-2">État</th><th className="px-3 py-2" /></tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {data.payments.map((o: PaymentOrderRow) => (
                    <tr key={o.id} className="align-top">
                      <td className="px-3 py-2 font-mono">{o.number}</td>
                      <td className="px-3 py-2">{o.suppliers?.name ?? '—'}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{Number(o.amount).toFixed(2)}</td>
                      <td className="px-3 py-2">{who(o.prepared_by)}</td>
                      <td className="px-3 py-2">{o.decided_by ? `${who(o.decided_by)} · ${formatDateTime(o.decided_at ?? '')}` : '—'}{o.decision_comment ? ` — ${o.decision_comment}` : ''}</td>
                      <td className="px-3 py-2"><Badge tone={PAYMENT_TONE[o.status]}>{PAYMENT_LABEL[o.status]}</Badge></td>
                      <td className="px-3 py-2">
                        {o.status === 'prepared' && o.prepared_by !== me && <DecisionForm id={o.id} action="payment" approveLabel="Approuver" />}
                        {o.status === 'approved' && o.prepared_by !== me && can(P.PAYMENTS_EXECUTE) && <RpcButton action={paymentOrderExecuteAction} fields={{ id: o.id }} variant="command" size="sm" confirm="Enregistrer le règlement de cet ordre approuvé ?">Exécuter le règlement</RpcButton>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {can(P.PAYMENTS_PREPARE) && (
            <div className="border-t border-line pt-4">
              <h3 className="mb-2 text-sm font-semibold text-ink">Préparer un ordre de paiement</h3>
              <PaymentOrderForm suppliers={data.suppliers} />
            </div>
          )}
        </Section>

        {can(P.QUALITY_APPROVE) && (
          <Section title="Lots critiques" note="Marquer un contrôle ouvert comme critique : son contrôleur ne pourra plus le libérer seul.">
            {openInspections.length === 0 ? (
              <p className="text-sm text-ink-soft">Aucun contrôle ouvert non critique.</p>
            ) : (
              <ul className="divide-y divide-line">
                {openInspections.map((i) => (
                  <li key={i.id} className="py-3">
                    <div className="mb-2 text-sm"><span className="font-mono">{i.number}</span> · {i.kind}</div>
                    <MarkCriticalForm id={i.id} />
                  </li>
                ))}
              </ul>
            )}
          </Section>
        )}

        <Section title="Dérogations" note="Demande, approbation de premier niveau, puis second contrôle indépendant : le demandeur et l’approbateur ne contrôlent pas.">
          {data.derogations.length === 0 ? (
            <p className="text-sm text-ink-soft">Aucune dérogation.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[52rem] text-sm">
                <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft">
                  <tr><th className="px-3 py-2">Numéro</th><th className="px-3 py-2">Nature</th><th className="px-3 py-2">Objet</th><th className="px-3 py-2">Motif</th><th className="px-3 py-2">Valable jusqu’au</th><th className="px-3 py-2">Suivi</th><th className="px-3 py-2">État</th><th className="px-3 py-2" /></tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {data.derogations.map((d: DerogationRow) => {
                    const notRequester = d.requested_by !== me
                    const canApprove = d.status === 'requested' && notRequester && can(P.DEROGATIONS_APPROVE)
                    const canControl = d.status === 'approved' && notRequester && d.approved_by !== me && can(P.DEROGATIONS_CONTROL)
                    return (
                      <tr key={d.id} className="align-top">
                        <td className="px-3 py-2 font-mono">{d.number}</td>
                        <td className="px-3 py-2">{d.kind}</td>
                        <td className="px-3 py-2">{d.object_type}{d.object_id ? ` · ${d.object_id.slice(0, 8)}…` : ''}</td>
                        <td className="px-3 py-2">{d.motive}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{d.valid_until}</td>
                        <td className="px-3 py-2 text-xs text-ink-soft">demandée par {who(d.requested_by)}{d.approved_by ? ` · approuvée par ${who(d.approved_by)}` : ''}{d.control_by ? ` · contrôlée par ${who(d.control_by)}` : ''}{d.decision_comment ? ` — ${d.decision_comment}` : ''}</td>
                        <td className="px-3 py-2"><Badge tone={DERO_TONE[d.status]}>{DERO_LABEL[d.status]}</Badge></td>
                        <td className="px-3 py-2">
                          {canApprove && <DecisionForm id={d.id} action="derogation_approve" approveLabel="Approuver" />}
                          {canControl && <DecisionForm id={d.id} action="derogation_control" approveLabel="Contrôler" />}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          {can(P.DEROGATIONS_REQUEST) && (
            <div className="border-t border-line pt-4">
              <h3 className="mb-2 text-sm font-semibold text-ink">Demander une dérogation</h3>
              <DerogationRequestForm />
            </div>
          )}
        </Section>
      </div>
    </>
  )
}
