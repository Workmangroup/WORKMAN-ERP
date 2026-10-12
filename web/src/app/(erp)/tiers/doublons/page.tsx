import type { Metadata } from 'next'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/layout/page-header'
import { requireAnyPermission } from '@/features/auth/guards'
import { DecideMergeForm, ProposeMergeForm } from '@/features/parties/components/party-forms'
import { getTiersData } from '@/features/parties/services/parties.service'
import { P } from '@/lib/rbac/permissions'
import { formatDateTime } from '@/lib/utils'

export const metadata: Metadata = { title: 'Doublons de tiers' }

const STATUS = { pending: { label: 'En attente', tone: 'warning' }, applied: { label: 'Fusionnée', tone: 'success' }, rejected: { label: 'Refusée', tone: 'danger' } } as const

/** Tiers commun : doublons détectés, propositions de fusion et décision du steward. Chaque fusion est tracée. */
export default async function TiersDoublonsPage() {
  const ctx = await requireAnyPermission(P.CLIENTS_READ, P.SUPPLIERS_READ)
  const me = ctx.user.id
  const steward = ctx.permissions.includes(P.TIERS_STEWARD)
  const data = await getTiersData()
  const name = (id: string) => data.parties.get(id)?.legal_name ?? 'Tiers non visible'
  return (
    <>
      <PageHeader title="Doublons de tiers" description="Tiers qui semblent identiques. Une fusion n’est jamais automatique : elle est proposée, puis décidée par un steward distinct." />
      <div className="space-y-6 p-4 sm:p-6">
        <section className="space-y-3">
          <h2 className="text-base font-semibold text-ink">Doublons détectés</h2>
          {data.candidates.length === 0 ? (
            <p className="text-sm text-ink-soft">Aucun doublon détecté.</p>
          ) : (
            <ul className="divide-y divide-line rounded-md border border-line bg-white shadow-card">
              {data.candidates.map((c) => (
                <li key={`${c.party_a}-${c.party_b}`} className="space-y-2 p-3">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium">{c.legal_name_a}</span>
                    <span className="text-ink-soft">et</span>
                    <span className="font-medium">{c.legal_name_b}</span>
                    <Badge tone={c.match_kind === 'strong' ? 'danger' : 'warning'}>{c.match_kind === 'strong' ? 'Même identifiant fiscal' : 'Même nom, à vérifier'}</Badge>
                    <span className="text-xs text-ink-soft">{c.country}</span>
                  </div>
                  <ProposeMergeForm source={c.party_b} target={c.party_a} />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-semibold text-ink">Propositions de fusion</h2>
          {data.proposals.length === 0 ? (
            <p className="text-sm text-ink-soft">Aucune proposition.</p>
          ) : (
            <ul className="divide-y divide-line rounded-md border border-line bg-white shadow-card">
              {data.proposals.map((p) => (
                <li key={p.id} className="space-y-2 p-3">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span>Fusion de <span className="font-medium">{name(p.source_party)}</span> dans <span className="font-medium">{name(p.target_party)}</span></span>
                    <Badge tone={STATUS[p.status as keyof typeof STATUS]?.tone ?? 'neutral'}>{STATUS[p.status as keyof typeof STATUS]?.label ?? p.status}</Badge>
                    <span className="text-xs text-ink-soft">proposée le {formatDateTime(p.proposed_at)} · {p.reason}</span>
                  </div>
                  {p.decision_comment && <p className="text-xs text-ink-soft">Décision : {p.decision_comment}</p>}
                  {p.status === 'pending' && p.proposed_by !== me && steward && <DecideMergeForm id={p.id} />}
                  {p.status === 'pending' && p.proposed_by === me && <Alert tone="info">Votre proposition attend la décision d’un autre steward.</Alert>}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  )
}
