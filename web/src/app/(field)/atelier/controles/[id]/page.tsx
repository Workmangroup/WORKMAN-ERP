import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { z } from 'zod'
import { requirePermission } from '@/features/auth/guards'
import { ControlPanel } from '@/features/field/components/panels'
import { inspectionDetail } from '@/features/field/services'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Contrôle' }

export default async function FieldControl({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission(P.QUALITY_READ)
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const insp = await inspectionDetail(id)
  if (!insp) notFound()
  return <ControlPanel inspection={insp} />
}
