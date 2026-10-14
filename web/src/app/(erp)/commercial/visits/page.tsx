import type { Metadata } from 'next'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { ActionForm, VisitCheckinForm, VisitPlanForm, VisitReportForm } from '@/features/commercial/components/crm-forms'
import { visitCancelAction, visitCheckinAction, visitPhotoAction, visitPlanCreateAction, visitReportAction } from '@/features/commercial/crm-actions'
import { clientOptions } from '@/features/commercial/services/commercial.service'
import { listClientDocuments } from '@/features/commercial/services/contracts.service'
import { listVisits, type VisitRow } from '@/features/commercial/services/visits.service'
import { fmtDay } from '@/features/commercial/status'
import { formatDateTime } from '@/lib/utils'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Visites' }

const STATUS: Record<VisitRow['status'], { label: string; tone: 'neutral' | 'brand' | 'success' | 'danger' }> = {
  planned: { label: 'Planifiée', tone: 'brand' },
  done: { label: 'Réalisée', tone: 'success' },
  cancelled: { label: 'Annulée', tone: 'neutral' },
}
const inputCls = 'rounded-md border border-line bg-white px-3 py-2 text-sm'

function gpsLine(v: VisitRow): string {
  if (!v.checkin) return 'Pas de pointage'
  if (v.checkin.gps_status === 'captured') return `Position enregistrée (précision ${v.checkin.accuracy_m} m)`
  if (v.checkin.gps_status === 'denied') return `Position refusée : ${v.checkin.reason}`
  return `Position indisponible : ${v.checkin.reason}`
}

export default async function VisitsPage() {
  const ctx = await requirePermission(P.VISITS_READ)
  const canWrite = ctx.permissions.includes(P.VISITS_WRITE)
  const [rows, clients] = await Promise.all([listVisits(), canWrite ? clientOptions() : Promise.resolve([])])
  const mine = rows.filter((v) => v.owner_id === ctx.user.id && v.status === 'planned')
  const docs = canWrite ? await listClientDocuments(mine.map((v) => v.client_id)) : {}
  return (
    <>
      <PageHeader title="Visites" description="Agenda, pointage, compte rendu et photos. Seul le commercial responsable d’une visite la pointe et la rédige. La position GPS n’est demandée qu’au pointage, jamais en continu." />
      <div className="space-y-4 p-4 sm:p-6">
        {canWrite && (
          <section className="rounded-md border border-line bg-white p-4 shadow-card">
            <h2 className="text-sm font-semibold">Planifier une visite</h2>
            <div className="mt-3"><VisitPlanForm action={visitPlanCreateAction} clients={clients} /></div>
          </section>
        )}
        {rows.length === 0 ? (
          <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">Aucune visite planifiée.</p>
        ) : (
          <ul className="space-y-3">
            {rows.map((v) => {
              const owned = v.owner_id === ctx.user.id && v.status === 'planned'
              return (
                <li key={v.id} className="rounded-md border border-line bg-white p-4 shadow-card">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="font-semibold">{v.client}</span>
                    <Badge tone={STATUS[v.status].tone}>{STATUS[v.status].label}</Badge>
                    <span className="text-sm text-ink-soft">{formatDateTime(v.planned_at)} · {v.duration_min} min</span>
                  </div>
                  <p className="mt-1 text-sm">{v.purpose}</p>
                  <p className="mt-1 text-xs text-ink-soft">{gpsLine(v)}{v.photos > 0 && ` · ${v.photos} photo(s)`}{v.report && ` · compte rendu ${v.report.dictation_reviewed ? '(dictée relue)' : ''} du ${fmtDay(v.report.recorded_at)}`}</p>
                  {v.report && <p className="mt-2 whitespace-pre-line rounded-md bg-canvas p-3 text-sm">{v.report.report_text}</p>}
                  {owned && (
                    <div className="mt-4 grid gap-4 md:grid-cols-2">
                      {!v.checkin && <div><h3 className="mb-2 text-xs font-semibold text-ink-soft">Pointage</h3><VisitCheckinForm action={visitCheckinAction} planId={v.id} /></div>}
                      <div className="md:col-span-2"><h3 className="mb-2 text-xs font-semibold text-ink-soft">Compte rendu</h3><VisitReportForm action={visitReportAction} planId={v.id} /></div>
                      <div>
                        <h3 className="mb-2 text-xs font-semibold text-ink-soft">Photo (pièce GED du client)</h3>
                        <ActionForm action={visitPhotoAction} submit="Rattacher la photo">
                          <input type="hidden" name="plan_id" value={v.id} />
                          <label className="grid gap-1 text-xs md:col-span-2">Document<select name="document_id" required className={inputCls}><option value="">Choisir…</option>{(docs[v.client_id] ?? []).map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}</select></label>
                          <label className="grid gap-1 text-xs md:col-span-2">Légende<input name="caption" maxLength={200} className={inputCls} /></label>
                        </ActionForm>
                      </div>
                      <div>
                        <h3 className="mb-2 text-xs font-semibold text-ink-soft">Annuler la visite</h3>
                        <ActionForm action={visitCancelAction} submit="Annuler la visite">
                          <input type="hidden" name="plan_id" value={v.id} />
                          <label className="grid gap-1 text-xs md:col-span-2">Motif<input name="reason" required minLength={3} maxLength={200} className={inputCls} /></label>
                        </ActionForm>
                      </div>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </>
  )
}
