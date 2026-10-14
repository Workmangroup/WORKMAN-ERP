import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, Lock } from 'lucide-react'
import { z } from 'zod'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { PageHeader } from '@/components/layout/page-header'
import { requireAnyPermission } from '@/features/auth/guards'
import { ApprovalDecideDialog } from '@/features/purchases/components/request-forms'
import { purchaseErrorMessage } from '@/features/purchases/errors'
import { supplierOptions } from '@/features/purchases/services/purchases.service'
import { closeSourcingAction } from '@/features/sourcing/actions'
import { AwardForm, OfferForm, OpenSourcingForm } from '@/features/sourcing/components/sourcing-forms'
import { compareSourcing, getSourcing, type SourcingStatus } from '@/features/sourcing/services/sourcing.service'
import { RpcButton } from '@/features/stock/components/rpc-button'
import { unitLabel } from '@/lib/bom/options'
import { P } from '@/lib/rbac/permissions'
import { formatDateTime } from '@/lib/utils'

export const metadata: Metadata = { title: 'Consultation fournisseurs' }

const STATUS: Record<SourcingStatus, { label: string; tone: 'neutral' | 'brand' | 'success' | 'warning' }> = {
  draft: { label: 'Brouillon', tone: 'neutral' },
  open: { label: 'Ouverte', tone: 'brand' },
  closed: { label: 'Clôturée', tone: 'warning' },
  awarded: { label: 'Attribuée', tone: 'success' },
}
const fmt = (n: number) => n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default async function SourcingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAnyPermission(P.PURCHASES_READ)
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const data = await getSourcing(id)
  if (!data) notFound()
  const { event: e, lines, offers, approval } = data
  const canWrite = ctx.permissions.includes(P.PURCHASES_WRITE)
  const canApprove = ctx.permissions.includes(P.PURCHASES_APPROVE)
  const pending = approval && ['pending_l1', 'pending_l2'].includes(approval.state) ? approval : null
  const sups = canWrite && e.status === 'open' ? await supplierOptions() : []
  const showCompare = e.status === 'closed' || e.status === 'awarded'
  const cmp = showCompare ? await compareSourcing(id) : null
  const awarded = e.status === 'awarded' ? offers.find((o) => o.version_id === e.awarded_version_id) : undefined

  return (
    <>
      <PageHeader title={`${e.code} — ${e.title}`}
        description={`${lines.length} ligne(s) comparée(s) sur une base identique${e.needed_date ? ` · besoin le ${e.needed_date}` : ''}`}
        actions={<>
          <Link href="/purchases/sourcing" className={buttonVariants({ variant: 'command', size: 'sm' })}><ArrowLeft className="h-4 w-4" /> Consultations</Link>
          {e.status === 'open' && canWrite && offers.length > 0 && <RpcButton action={closeSourcingAction} fields={{ event_id: e.id }} variant="command" size="sm" confirm="Clôturer la consultation ? Plus aucune offre ne pourra être saisie.">
            <Lock className="h-4 w-4" /> Clôturer</RpcButton>}
          {pending && canApprove && <ApprovalDecideDialog approvalId={pending.id} code={e.code} label={pending.state === 'pending_l2' ? 'Décider (niveau 2)' : 'Décider l’attribution'} />}
        </>} />
      <div className="space-y-4 p-4 sm:p-6">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <Badge tone={STATUS[e.status].tone}>{STATUS[e.status].label}</Badge>
          {e.weights && <span className="text-ink-soft">Pondérations : prix {e.weights.price} · délai {e.weights.lead} · qualité {e.weights.quality}</span>}
        </div>
        {e.status === 'awarded' && awarded && (
          <Alert tone="success">Attribuée à {awarded.supplier_name}, version {awarded.version}{e.awarded_at ? ` le ${formatDateTime(e.awarded_at)}` : ''}. Motif : « {e.award_rationale} »</Alert>
        )}
        {pending && <Alert tone="info">Demande d’attribution en attente de décision (approbateur distinct du demandeur){approval?.rationale ? ` · motif : « ${approval.rationale} »` : ''}. Rien n’est attribué avant la décision.</Alert>}
        {approval?.state === 'refused' && <Alert tone="error">Demande d’attribution refusée : « {approval.refusal_reason} ». Une nouvelle demande est possible.</Alert>}
        {e.status === 'open' && <Alert tone="info">Consultation ouverte : chaque offre doit chiffrer toutes les lignes. Clôturez-la pour établir le comparatif.</Alert>}

        <section className="rounded-md border border-line bg-white shadow-card">
          <div className="border-b border-line px-4 py-2 text-sm font-semibold">Lignes comparées (même base)</div>
          <table className="w-full text-sm">
            <tbody className="divide-y divide-line">
              {lines.map((l) => <tr key={l.id}><td className="px-4 py-2">{l.material_name} <span className="font-mono text-xs text-ink-faint">{l.material_code}</span></td><td className="px-4 py-2 text-right tabular-nums">{l.qty} {unitLabel(l.unit)}</td></tr>)}
            </tbody>
          </table>
        </section>

        <section className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
          <div className="border-b border-line px-4 py-2 text-sm font-semibold">Offres reçues (version courante ; l’historique reste en base)</div>
          <table className="w-full min-w-[60rem] text-sm">
            <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft">
              <tr><th className="px-4 py-2 font-semibold">Fournisseur</th><th className="px-2 py-2 font-semibold">Version</th><th className="px-2 py-2 font-semibold">Devise</th><th className="px-2 py-2 font-semibold">Incoterm</th><th className="px-2 py-2 text-right font-semibold">Délai (j)</th><th className="px-2 py-2 text-right font-semibold">Transport</th><th className="px-2 py-2 text-right font-semibold">Droits</th><th className="px-2 py-2 font-semibold">Source (référence · empreinte)</th><th className="px-2 py-2 font-semibold">Notation</th></tr>
            </thead>
            <tbody className="divide-y divide-line">
              {offers.length === 0 && <tr><td colSpan={9} className="p-6 text-center text-ink-soft">Aucune offre saisie.</td></tr>}
              {offers.map((o) => (
                <tr key={o.offer_id}>
                  <td className="px-4 py-2 font-medium">{o.supplier_name}</td>
                  <td className="px-2 py-2">v{o.version}</td>
                  <td className="px-2 py-2 font-mono">{o.currency}</td>
                  <td className="px-2 py-2">{o.incoterm ?? '—'}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{o.lead_time_days}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{fmt(o.transport_amount)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{fmt(o.duties_amount)}</td>
                  <td className="px-2 py-2 text-xs">{o.source_reference}{o.source_sha256 ? <span className="block font-mono text-ink-faint">{o.source_sha256.slice(0, 16)}…</span> : null}</td>
                  <td className="px-2 py-2">{o.rating ?? <span className="text-warn-text">Non notée</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {e.status === 'draft' && canWrite && <section className="rounded-md border border-line bg-white p-4 shadow-card"><h2 className="mb-3 text-sm font-semibold">Ouvrir la consultation</h2><OpenSourcingForm eventId={e.id} /></section>}
        {e.status === 'open' && canWrite && <section className="rounded-md border border-line bg-white p-4 shadow-card"><h2 className="mb-3 text-sm font-semibold">Saisir une offre</h2><OfferForm eventId={e.id} suppliers={sups} lines={lines} /></section>}

        {showCompare && (
          <section className="space-y-3">
            <h2 className="text-base font-semibold">Comparatif</h2>
            {cmp?.error && <Alert tone="error">{purchaseErrorMessage(cmp.error)}</Alert>}
            {cmp?.data && <>
              <p className="text-xs text-ink-soft">Base : {cmp.data.base_currency} · taux du {cmp.data.rate_date} (taux de change figés) · formule total : {cmp.data.formula.total}</p>
              <div className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
                <table className="w-full min-w-[64rem] text-sm">
                  <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft">
                    <tr><th className="px-4 py-2 font-semibold">Rang</th><th className="px-2 py-2 font-semibold">Fournisseur</th><th className="px-2 py-2 text-right font-semibold">Coût rendu ({cmp.data.base_currency})</th><th className="px-2 py-2 text-right font-semibold">Score prix</th><th className="px-2 py-2 text-right font-semibold">Délai (j)</th><th className="px-2 py-2 text-right font-semibold">Score délai</th><th className="px-2 py-2 text-right font-semibold">Score qualité</th><th className="px-2 py-2 text-right font-semibold">Total</th></tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {cmp.data.offers.map((o) => (
                      <tr key={o.version_id}>
                        <td className="px-4 py-2 font-semibold">{o.rank}</td>
                        <td className="px-2 py-2">{o.supplier_name} <span className="text-xs text-ink-faint">v{o.version} · {o.currency}</span></td>
                        <td className="px-2 py-2 text-right tabular-nums">{fmt(o.landed_base)}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{o.price_score.toFixed(2)}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{o.lead_time_days}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{o.lead_score.toFixed(2)}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{o.quality_score.toFixed(2)} <span className="text-xs text-ink-faint">(notation {o.quality_rating})</span></td>
                        <td className="px-2 py-2 text-right font-semibold tabular-nums">{o.total_score.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-ink-soft">Coût rendu = prix × quantités + transport + droits, converti en {cmp.data.base_currency} au taux du {cmp.data.rate_date}. Un classement n’attribue rien : la décision est humaine.</p>
            </>}
            {e.status === 'closed' && canWrite && !pending && cmp?.data && (
              <section className="rounded-md border border-line bg-white p-4 shadow-card">
                <h3 className="mb-3 text-sm font-semibold">Demander l’attribution</h3>
                <AwardForm eventId={e.id} offers={cmp.data.offers.map((o) => ({ version_id: o.version_id, supplier_name: o.supplier_name, version: o.version }))} />
              </section>
            )}
          </section>
        )}
      </div>
    </>
  )
}
