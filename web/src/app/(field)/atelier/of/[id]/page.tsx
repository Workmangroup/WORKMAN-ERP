import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { z } from 'zod'
import { requirePermission } from '@/features/auth/guards'
import { OfPanel } from '@/features/field/components/panels'
import { orderDetail } from '@/features/field/services'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Ordre' }

export default async function FieldOrder({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission(P.PRODUCTION_READ)
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const order = await orderDetail(id)
  if (!order) notFound()
  return <OfPanel order={order} />
}
