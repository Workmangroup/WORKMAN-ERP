import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { z } from 'zod'
import { buttonVariants } from '@/components/ui/button'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { ClientForm } from '@/features/clients/components/client-form'
import { directoryByIds, getClient, listPaymentTerms, listSalesReps } from '@/features/clients/services/clients.service'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Modifier le client' }

export default async function EditClientPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission(P.CLIENTS_WRITE)
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const client = await getClient(id)
  if (!client) notFound()
  if (client.archived_at) redirect(`/clients/${id}`)

  const [terms, reps] = await Promise.all([listPaymentTerms(), listSalesReps()])
  // Le commercial actuel reste sélectionnable même s'il n'a plus clients.write
  const known = new Set(reps.map((r) => r.id))
  if (client.sales_rep_id && !known.has(client.sales_rep_id)) {
    const current = (await directoryByIds([client.sales_rep_id])).get(client.sales_rep_id)
    if (current) reps.push(current)
  }

  return (
    <>
      <PageHeader
        title={`Modifier ${client.name}`}
        description={`Code ${client.code}`}
        actions={<Link href={`/clients/${id}`} className={buttonVariants({ variant: 'command', size: 'sm' })}><ArrowLeft className="h-4 w-4" /> Fiche client</Link>}
      />
      <div className="mx-auto max-w-4xl p-4 sm:p-6">
        <ClientForm client={client} terms={terms} reps={reps} />
      </div>
    </>
  )
}
