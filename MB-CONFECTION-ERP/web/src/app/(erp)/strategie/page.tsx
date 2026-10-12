import type { Metadata } from 'next'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { StrategyBoard } from '@/features/strategy/components/strategy-board'
import { buildStrategyFacts } from '@/features/strategy/services/strategy.service'
import { createClient } from '@/lib/supabase/server'
import { DOMAIN_LABEL, buildRecommendations, summarize, type Domain } from '@/lib/strategy/engine'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Recommandations stratégiques' }

const DOMAINS = Object.keys(DOMAIN_LABEL) as Domain[]

/** Analyse les données de la société et propose des actions priorisées. Réservé à la direction. */
export default async function StrategyPage({ searchParams }: { searchParams: Promise<{ domaine?: string }> }) {
  const ctx = await requirePermission(P.DASHBOARD_EXECUTIVE)
  const sp = await searchParams
  const domain = DOMAINS.find((d) => d === sp.domaine) ?? null
  const supabase = await createClient()
  const { facts, missing } = await buildStrategyFacts(supabase, ctx.permissions)
  const recs = buildRecommendations(facts)
  const summary = summarize(recs)
  return (
    <>
      <PageHeader
        title="Recommandations stratégiques"
        description="Le système analyse les données de la société, signale les anomalies et propose des actions avec responsable, échéance et indicateur de suivi."
      />
      <div className="p-4 sm:p-6">
        <StrategyBoard recs={recs} summary={summary} missing={missing} domain={domain} />
      </div>
    </>
  )
}
