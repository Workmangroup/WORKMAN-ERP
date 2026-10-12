import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { z } from 'zod'
import { requirePermission } from '@/features/auth/guards'
import { PickPanel } from '@/features/field/components/panels'
import { pickLines } from '@/features/field/services'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Prélèvement' }

export default async function FieldPick({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission(P.SHIPMENTS_READ)
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const data = await pickLines(id)
  if (!data) notFound()
  return (
    <div className="space-y-4">
      <h1 className="font-mono text-3xl font-bold tracking-tight">{data.number}</h1>
      {data.lines.length === 0 ? <p className="text-lg text-ink-soft">Aucune ligne dans cette expédition.</p> : <PickPanel lines={data.lines} />}
    </div>
  )
}
