import type { Metadata } from 'next'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { ExecutiveLive } from '@/features/executive/components/executive-live'
import type { ExecutiveSnapshot } from '@/features/executive/types'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Tableau de bord DG' }

const INITIAL_MONTHS = 12

export default async function ExecutiveDashboardPage() {
  await requirePermission(P.DASHBOARD_EXECUTIVE)
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('executive_dashboard', { p_months: INITIAL_MONTHS })
  if (error || !data) {
    return (
      <>
        <PageHeader title="Tableau de bord DG" description="Vue exécutive multi-modules." />
        <p role="alert" className="m-6 rounded-md border border-danger/30 bg-danger-bg px-3 py-2 text-sm text-danger-text">Impossible de charger les indicateurs. Actualisez la page dans un instant.</p>
      </>
    )
  }
  return (
    <>
      <PageHeader title="Tableau de bord DG" description="Chiffre d’affaires, marge, stocks, production, achats, MRP, finance, qualité et expéditions. Alertes stratégiques en tête." />
      <div className="p-4 sm:p-6">
        <ExecutiveLive initial={data as ExecutiveSnapshot} initialMonths={INITIAL_MONTHS} />
      </div>
    </>
  )
}
