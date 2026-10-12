import type { Metadata } from 'next'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { ForecastsManager } from '@/features/mrp/components/inputs-managers'
import { articleOptions, listForecasts } from '@/features/mrp/services/mrp.service'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Prévisions MRP' }

export default async function ForecastsPage() {
  const ctx = await requirePermission(P.MRP_READ)
  const canWrite = ctx.permissions.includes(P.MRP_WRITE)
  const [forecasts, articles] = await Promise.all([listForecasts(), canWrite ? articleOptions() : Promise.resolve([])])
  return (
    <>
      <PageHeader title="Prévisions" description="Demande attendue mais pas encore commandée, par article et date de livraison. Elle s’ajoute aux commandes confirmées dans les simulations." />
      <div className="p-4 sm:p-6"><ForecastsManager forecasts={forecasts} articles={articles} canWrite={canWrite} /></div>
    </>
  )
}
