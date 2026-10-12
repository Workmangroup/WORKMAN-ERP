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
import { ActionButtons, AddActionDialog, CloseNcDialog, ContainNcDialog } from '@/features/quality/components/quality-forms'
import { getNc, listActions, listPlans, ncHistory } from '@/features/quality/services/quality.service'
import { WarehouseTimeline } from '@/features/warehouses/components/timeline'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Non-conformité' }

const SEV: Record<string, string> = { minor: 'Mineure', major: 'Majeure', critical: 'Critique' }
const ACTION_STATUS: Record<string, { label: string; tone: 'neutral' | 'brand' | 'warning' | 'success' | 'danger' }> = {
  todo: { label: 'À faire', tone: 'neutral' }, in_progress: { label: 'En cours', tone: 'brand' }, done: { label: 'Faite', tone: 'warning' },
  verified: { label: 'Vérifiée', tone: 'success' }, cancelled: { label: 'Annulée', tone: 'neutral' },
}

export default async function NcPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePermission(P.QUALITY_READ)
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const n = await getNc(id)
  if (!n) notFound()
  const canWrite = ctx.permissions.includes(P.QUALITY_WRITE)
  const canApprove = ctx.permissions.includes(P.QUALITY_APPROVE)
  const open = n.status !== 'closed'
  const [actions, plans, history] = await Promise.all([listActions({ ncId: id }), canWrite && open ? listPlans() : Promise.resolve([]), ncHistory(id)])
  const activePlans = plans.filter((p) => p.status === 'active')
  return (
    <>
      <PageHeader title={`${n.number} — ${n.title}`} description={`Gravité : ${SEV[n.severity] ?? n.severity}${n.due_date ? ` · échéance ${n.due_date}` : ''}`}
        actions={<Link href="/quality/non-conformites" className={buttonVariants({ variant: 'command', size: 'sm' })}><ArrowLeft className="h-4 w-4" /> Non-conformités</Link>} />
      <div className="space-y-4 p-4 sm:p-6">
        <div className="flex flex-wrap items-center gap-3">
          <Badge tone={n.status === 'closed' ? 'success' : n.status === 'contained' ? 'warning' : 'danger'}>{n.status === 'open' ? 'Ouverte' : n.status === 'contained' ? 'Confinée' : 'Close'}</Badge>
          {n.inspection_id && <Link href={`/quality/controles/${n.inspection_id}`} className="text-sm text-brand-700 hover:underline">Voir le contrôle d’origine</Link>}
        </div>
        {n.description && <p className="text-sm text-ink-soft">{n.description}</p>}

        <Card>
          <CardHeader><CardTitle>Confinement et cause</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p><span className="text-ink-soft">Confinement :</span> {n.containment ?? 'non renseigné'}</p>
            <p><span className="text-ink-soft">Cause probable :</span> {n.root_cause ?? 'non renseignée'}</p>
            {open && canWrite && <ContainNcDialog ncId={id} />}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="flex items-center justify-between gap-3"><span>Actions correctives et préventives</span>{open && canWrite && <AddActionDialog ncId={id} plans={activePlans} />}</CardTitle></CardHeader>
          <CardContent className="p-0">
            {actions.length === 0 ? <p className="p-6 text-sm text-ink-soft">Aucune action. Une non-conformité ne se clôt qu’avec une action vérifiée, ou une justification écrite.</p> : (
              <div className="overflow-x-auto"><table className="w-full min-w-[40rem] text-sm">
                <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Action</th><th className="px-2 py-2 font-semibold">Type</th><th className="px-2 py-2 font-semibold">Échéance</th><th className="px-2 py-2 font-semibold">État</th><th className="px-2 py-2 font-semibold">Efficacité</th>{canWrite && <th className="px-2 py-2" />}</tr></thead>
                <tbody className="divide-y divide-line">{actions.map((a) => (
                  <tr key={a.id} className="align-top">
                    <td className="px-4 py-2"><span className="font-mono text-xs">{a.number}</span> {a.action}{a.cancel_reason && <span className="block text-xs text-ink-soft">Annulée : {a.cancel_reason}</span>}</td>
                    <td className="px-2 py-2">{a.kind === 'corrective' ? 'Corrective' : 'Préventive'}</td>
                    <td className="px-2 py-2 text-xs">{a.due_date}</td>
                    <td className="px-2 py-2"><Badge tone={ACTION_STATUS[a.status]?.tone ?? 'neutral'}>{ACTION_STATUS[a.status]?.label ?? a.status}</Badge></td>
                    <td className="px-2 py-2 text-xs">{a.effective === null ? '—' : a.effective ? 'Efficace' : 'Inefficace'}</td>
                    {canWrite && <td className="px-2 py-2 text-right">{open && <ActionButtons id={a.id} status={a.status} />}</td>}
                  </tr>
                ))}</tbody>
              </table></div>
            )}
            {!canApprove && actions.some((a) => a.status === 'done') && <p className="px-4 py-2 text-xs text-ink-soft">La vérification d’efficacité est réservée à la qualité (approbation).</p>}
          </CardContent>
        </Card>

        {open && canApprove && n.status === 'contained' && (
          <Card>
            <CardHeader><CardTitle>Clôture</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              <CloseNcDialog ncId={id} />
              <p className="text-xs text-ink-soft">La clôture exige que toutes les actions soient vérifiées efficaces ou annulées.</p>
            </CardContent>
          </Card>
        )}
        {n.status === 'closed' && <p className="text-sm text-ink-soft">Clôturée le {n.closed_at ? new Date(n.closed_at).toLocaleDateString('fr-FR') : '—'}{n.close_note ? ` · ${n.close_note}` : ''}</p>}

        <Card>
          <CardHeader><CardTitle>Traçabilité</CardTitle></CardHeader>
          <CardContent><WarehouseTimeline rows={history} /></CardContent>
        </Card>
      </div>
    </>
  )
}
