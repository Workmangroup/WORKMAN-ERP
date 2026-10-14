import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, ArrowRightCircle, Send, XCircle } from 'lucide-react'
import { z } from 'zod'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { PageHeader } from '@/components/layout/page-header'
import { requireAnyPermission } from '@/features/auth/guards'
import { cancelRequestAction, convertRequestAction, deleteRequestLineAction, submitRequestAction } from '@/features/purchases/actions'
import { AddRequestLine, ApprovalDecideDialog, DecideDialog } from '@/features/purchases/components/request-forms'
import { budgetState, costCenterOptions, getRequest, materialOptions, requestApproval, supplierOptions } from '@/features/purchases/services/purchases.service'
import { PO_STATUS, REQUEST_STATUS, fmtDay } from '@/features/purchases/status'
import { RpcButton } from '@/features/stock/components/rpc-button'
import { formatQty, unitLabel } from '@/lib/bom/options'
import { P } from '@/lib/rbac/permissions'
import { formatDateTime } from '@/lib/utils'

export const metadata: Metadata = { title: 'Demande d’achat' }

export default async function RequestPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAnyPermission(P.PURCHASES_READ, P.PURCHASES_REQUEST)
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const data = await getRequest(id)
  if (!data) notFound()
  const { request: r, lines, orders } = data
  const perms = ctx.permissions
  const canWrite = perms.includes(P.PURCHASES_WRITE)
  const mine = r.requested_by === ctx.user.id
  const canEdit = canWrite || (perms.includes(P.PURCHASES_REQUEST) && mine)
  const draft = r.status === 'draft'
  const [mats, sups] = draft && canEdit ? await Promise.all([materialOptions(), supplierOptions()]) : [[], []]
  const missing = lines.filter((l) => !l.ordered && !l.supplier_id && !l.has_default_supplier)
  const [approval, budget, ccs] = await Promise.all([
    requestApproval(r.id),
    r.cost_center_id ? budgetState(r.cost_center_id, r.needed_date) : Promise.resolve(null),
    r.cost_center_id ? costCenterOptions() : Promise.resolve([]),
  ])
  const cc = ccs.find((c) => c.id === r.cost_center_id)
  const openApproval = approval && ['pending_l1', 'pending_l2'].includes(approval.state) ? approval : null
  return (
    <>
      <PageHeader title={r.code} description={`${r.reason ?? 'Demande d’achat'}${r.requester ? ` · demandée par ${r.requester}` : ''}`}
        actions={<>
          <Link href="/purchases/requests" className={buttonVariants({ variant: 'command', size: 'sm' })}><ArrowLeft className="h-4 w-4" /> Demandes</Link>
          {draft && canEdit && <RpcButton action={submitRequestAction} fields={{ id: r.id }} variant="command" size="sm" confirm="Soumettre la demande à validation ? Elle ne sera plus modifiable."><Send className="h-4 w-4" /> Soumettre</RpcButton>}
          {openApproval && perms.includes(P.PURCHASES_APPROVE) && <ApprovalDecideDialog approvalId={openApproval.id} code={r.code} label={openApproval.state === 'pending_l2' ? 'Décider (niveau 2)' : 'Décider (niveau 1)'} />}
          {r.status === 'submitted' && !approval && perms.includes(P.PURCHASES_APPROVE) && <DecideDialog id={r.id} code={r.code} />}
          {r.status === 'approved' && canWrite && <RpcButton action={convertRequestAction} fields={{ id: r.id }} variant="command" size="sm" confirm="Générer les commandes fournisseur (une par fournisseur) ?"><ArrowRightCircle className="h-4 w-4" /> Générer les commandes</RpcButton>}
          {['draft', 'submitted', 'approved'].includes(r.status) && canEdit && <RpcButton action={cancelRequestAction} fields={{ id: r.id }} variant="command" size="sm" className="text-danger-text" confirm="Annuler cette demande ?"><XCircle className="h-4 w-4" /> Annuler</RpcButton>}
        </>} />
      <div className="space-y-4 p-4 sm:p-6">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <Badge tone={REQUEST_STATUS[r.status].tone}>{REQUEST_STATUS[r.status].label}</Badge>
          {r.source === 'mrp' && <Badge tone="brand">Issue du MRP</Badge>}
          <span className="text-ink-soft">Créée le {formatDateTime(r.created_at)}{r.needed_date ? ` · besoin le ${fmtDay(r.needed_date)}` : ''}{r.submitted_at ? ` · soumise le ${formatDateTime(r.submitted_at)}` : ''}</span>
        </div>
        {r.decided_at && <Alert tone={r.status === 'rejected' ? 'error' : 'success'}>{r.status === 'rejected' ? 'Rejetée' : 'Validée'} par {r.decider ?? '—'} le {formatDateTime(r.decided_at)}{r.decision_comment ? ` — « ${r.decision_comment} »` : ''}</Alert>}
        {r.status === 'submitted' && !perms.includes(P.PURCHASES_APPROVE) && <Alert tone="info">En attente de validation par un approbateur (droit « Approuver les achats »).</Alert>}
        {approval?.state === 'pending_l1' && <Alert tone="info">En attente de décision (niveau 1), échéance {formatDateTime(approval.deadline_at)}. Le demandeur ne peut pas la valider : la séparation des tâches est appliquée par la base.</Alert>}
        {approval?.state === 'pending_l2' && <Alert tone="info">Premier niveau validé : en attente du second niveau, qui doit être un autre approbateur que le premier.</Alert>}
        {approval?.state === 'refused' && <Alert tone="error">Refusée dans le workflow d’approbation : « {approval.refusal_reason} »</Alert>}
        {r.cost_center_id ? (
          <section className="rounded-md border border-line bg-white p-4 shadow-card">
            <h2 className="text-sm font-semibold">Budget du centre {cc ? `${cc.code} — ${cc.label}` : ''}</h2>
            {budget ? (
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
                <dt className="text-ink-soft">Budget</dt><dd className="text-right tabular-nums sm:col-start-auto">{budget.amount.toLocaleString('fr-FR', { minimumFractionDigits: 2 })}</dd>
                <dt className="text-ink-soft">Engagé</dt><dd className="text-right tabular-nums">{budget.engaged.toLocaleString('fr-FR', { minimumFractionDigits: 2 })}</dd>
                <dt className="text-ink-soft">Réalisé</dt><dd className="text-right tabular-nums">{budget.realised.toLocaleString('fr-FR', { minimumFractionDigits: 2 })}</dd>
                <dt className="font-semibold">Disponible</dt><dd className="text-right font-semibold tabular-nums">{budget.available.toLocaleString('fr-FR', { minimumFractionDigits: 2 })}</dd>
              </dl>
            ) : (
              <p className="mt-1 text-sm text-ink-soft">Budget indisponible pour la date du besoin : aucun budget défini, ou droit « Voir les achats » absent.</p>
            )}
          </section>
        ) : <Alert tone="info">Demande non budgétée : aucun centre de coût renseigné.</Alert>}
        {r.status === 'approved' && missing.length > 0 && canWrite && <Alert tone="warning">Sans fournisseur : {missing.map((l) => l.material_code).join(', ')}. Renseignez le fournisseur habituel du composant (menu Composants) avant de générer les commandes.</Alert>}
        {orders.length > 0 && <Alert tone="info">Commandes liées : {orders.map((o, i) => <span key={o.id}>{i > 0 && ', '}<Link href={`/purchases/orders/${o.id}`} className="font-mono font-semibold underline">{o.po_no}</Link> ({o.supplier} · {PO_STATUS[o.status as keyof typeof PO_STATUS]?.label ?? o.status})</span>)}</Alert>}

        <section className="rounded-md border border-line bg-white shadow-card">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[46rem] text-sm">
              <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Composant</th><th className="px-2 py-2 text-right font-semibold">Quantité</th><th className="px-2 py-2 font-semibold">Fournisseur</th><th className="px-2 py-2 font-semibold">Besoin le</th><th className="px-2 py-2 font-semibold">Suivi</th>{draft && canEdit && <th className="w-16 px-4 py-2" />}</tr></thead>
              <tbody className="divide-y divide-line">
                {lines.length === 0 && <tr><td colSpan={6} className="p-6 text-center text-ink-soft">Aucune ligne : ajoutez les composants à acheter.</td></tr>}
                {lines.map((l) => (
                  <tr key={l.id}>
                    <td className="px-4 py-2"><span className="font-medium">{l.material_name}</span><span className="ml-2 font-mono text-xs text-ink-faint">{l.material_code}</span>{l.note && <span className="block text-xs text-ink-soft">{l.note}</span>}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{formatQty(l.qty)} {unitLabel(l.unit)}</td>
                    <td className="px-2 py-2">{l.supplier_name ?? (l.has_default_supplier ? <span className="text-ink-soft">{l.default_supplier ? `${l.default_supplier} (habituel)` : 'Fournisseur habituel'}</span> : <span className="text-warn-text">Non défini</span>)}</td>
                    <td className="whitespace-nowrap px-2 py-2">{fmtDay(l.needed_date)}</td>
                    <td className="px-2 py-2">{l.ordered ? <Badge tone="brand">Commandée</Badge> : <span className="text-ink-faint">—</span>}</td>
                    {draft && canEdit && <td className="px-4 py-2 text-right"><RpcButton action={deleteRequestLineAction} fields={{ id: l.id }} variant="ghost" size="sm" aria-label="Supprimer la ligne" confirm="Supprimer cette ligne ?">×</RpcButton></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {draft && canEdit && <AddRequestLine requestId={r.id} materials={mats} suppliers={sups} />}
        </section>
      </div>
    </>
  )
}
