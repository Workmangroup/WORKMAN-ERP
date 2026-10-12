import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { z } from 'zod'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { AddDefectDialog, DecisionButtons } from '@/features/quality/components/quality-forms'
import { getInspection, listDefectCodes, listDefects } from '@/features/quality/services/quality.service'
import { P } from '@/lib/rbac/permissions'
import { formatDateTime } from '@/lib/utils'

export const metadata: Metadata = { title: 'Contrôle qualité' }

const SEV: Record<string, { label: string; tone: 'neutral' | 'warning' | 'danger' }> = {
  minor: { label: 'Mineure', tone: 'neutral' }, major: { label: 'Majeure', tone: 'warning' }, critical: { label: 'Critique', tone: 'danger' },
}
const KIND: Record<string, string> = { reception: 'Contrôle réception', production: 'Contrôle production', final: 'Contrôle final' }

export default async function InspectionPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePermission(P.QUALITY_READ)
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const i = await getInspection(id)
  if (!i) notFound()
  const canWrite = ctx.permissions.includes(P.QUALITY_WRITE)
  const canApprove = ctx.permissions.includes(P.QUALITY_APPROVE)
  const [defects, codes] = await Promise.all([listDefects(id), canWrite && i.status === 'open' ? listDefectCodes() : Promise.resolve([])])
  const hasCritical = defects.some((d) => d.severity === 'critical')
  const hasMajor = defects.some((d) => d.severity === 'major')
  const total = defects.reduce((s, d) => s + Number(d.qty), 0)
  const open = i.status === 'open'
  return (
    <>
      <PageHeader title={`${i.number} — ${KIND[i.kind] ?? i.kind}`}
        description={`Échantillon : ${Number(i.sample_size)} · ${i.receipt_ref ? `BL ${i.receipt_ref}` : 'sans bon de livraison'}`}
        actions={<Link href="/quality/controles" className={buttonVariants({ variant: 'command', size: 'sm' })}><ArrowLeft className="h-4 w-4" /> Contrôles</Link>} />
      <div className="space-y-4 p-4 sm:p-6">
        <div className="flex flex-wrap items-center gap-3">
          {open ? <Badge tone="brand">En cours</Badge> : <Badge tone={i.decision === 'rejected' ? 'danger' : i.decision === 'conditional' ? 'warning' : 'success'}>{i.decision === 'accepted' ? 'Accepté' : i.decision === 'conditional' ? 'Accepté sous réserve' : 'Rejeté'}</Badge>}
          <span className="text-sm text-ink-soft">{total} défaut(s) constaté(s)</span>
          {!open && <span className="text-sm text-ink-soft">Accepté {Number(i.qty_accepted)} · rebuté {Number(i.qty_rejected)} · décidé le {i.closed_at ? formatDateTime(i.closed_at) : '—'}</span>}
        </div>

        {open && canWrite && codes.length > 0 && <AddDefectDialog inspectionId={id} codes={codes} />}
        {open && canWrite && codes.length === 0 && <p className="text-sm text-ink-soft">Le référentiel des défauts est vide : créez les défauts dans « Historique des défauts ».</p>}

        {open && canApprove && (
          <Card>
            <CardHeader><CardTitle>Décision</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              <DecisionButtons inspectionId={id} hasCritical={hasCritical} hasMajor={hasMajor} />
              <p className="text-xs text-ink-soft">Un défaut critique impose le rejet ; un défaut majeur interdit l’acceptation pleine. Un rejet ouvre une non-conformité automatiquement.</p>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader><CardTitle>Défauts constatés</CardTitle></CardHeader>
          <CardContent className="p-0">
            {defects.length === 0 ? <p className="p-6 text-sm text-ink-soft">Aucun défaut constaté.</p> : (
              <div className="overflow-x-auto"><table className="w-full min-w-[32rem] text-sm">
                <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Défaut</th><th className="px-2 py-2 font-semibold">Famille</th><th className="px-2 py-2 font-semibold">Gravité</th><th className="px-2 py-2 text-right font-semibold">Nombre</th><th className="px-2 py-2 font-semibold">Note</th></tr></thead>
                <tbody className="divide-y divide-line">{defects.map((d) => (
                  <tr key={d.id}><td className="px-4 py-2 font-mono text-xs">{d.defect_code}</td><td className="px-2 py-2">{d.category}</td><td className="px-2 py-2"><Badge tone={SEV[d.severity]?.tone ?? 'neutral'}>{SEV[d.severity]?.label ?? d.severity}</Badge></td><td className="px-2 py-2 text-right tabular-nums">{Number(d.qty)}</td><td className="px-2 py-2 text-ink-soft">{d.note ?? '—'}</td></tr>
                ))}</tbody>
              </table></div>
            )}
          </CardContent>
        </Card>
        {i.note && <p className="text-sm text-ink-soft">Note : {i.note}</p>}
      </div>
    </>
  )
}
