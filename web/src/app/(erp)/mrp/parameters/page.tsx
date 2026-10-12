import type { Metadata } from 'next'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { ParamsTable, ReceiptsManager } from '@/features/mrp/components/inputs-managers'
import { listParams, listReceipts } from '@/features/mrp/services/mrp.service'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Paramètres MRP' }

export default async function ParametersPage() {
  const ctx = await requirePermission(P.MRP_READ)
  const canWrite = ctx.permissions.includes(P.MRP_WRITE)
  const [params, receipts] = await Promise.all([listParams(), listReceipts()])
  return (
    <>
      <PageHeader title="Paramètres d’approvisionnement et réceptions" description="Délais, quantités minimales et multiples de commande par composant ; commandes d’achat déjà passées (réceptions planifiées)." />
      <div className="space-y-6 p-4 sm:p-6">
        <section className="space-y-2"><h2 className="text-base font-semibold">Réceptions planifiées</h2><ReceiptsManager receipts={receipts} materials={params} canWrite={canWrite} /></section>
        <section className="space-y-2"><h2 className="text-base font-semibold">Paramètres par composant</h2><ParamsTable rows={params} canWrite={canWrite} /></section>
      </div>
    </>
  )
}
