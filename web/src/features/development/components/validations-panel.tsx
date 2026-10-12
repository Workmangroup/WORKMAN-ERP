'use client'

import { Bell, Send } from 'lucide-react'
import { useActionState } from 'react'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { FormField } from '@/components/auth/form-field'
import { VALIDATION_KIND, VALIDATION_STATUS, daysUntil } from '@/lib/development/options'
import { fmtDay } from '@/features/orders/status'
import { decideValidationAction, remindValidationAction, submitValidationAction } from '../actions'
import type { Sample, Validation } from '../types'
import { ActionDialog } from '@/components/common/action-dialog'

/** Bouton de relance (utilisé aussi dans la liste des alertes). */
export function RemindButton({ id, projectId }: { id: string; projectId: string }) {
  const [state, action] = useActionState(remindValidationAction, null)
  return (
    <form action={action} className="inline-flex items-center gap-2">
      <input type="hidden" name="id" value={id} /><input type="hidden" name="project_id" value={projectId} />
      <Button type="submit" variant="secondary" size="sm"><Bell className="h-3.5 w-3.5" /> Relancer</Button>
      {state && !state.ok && <span role="alert" className="text-xs text-danger-text">{state.message}</span>}
    </form>
  )
}

export function DueBadge({ due }: { due: string | null }) {
  const d = daysUntil(due)
  if (d === null) return null
  return d < 0 ? <Badge tone="danger">En retard de {-d} j</Badge> : d <= 3 ? <Badge tone="warning">{d === 0 ? 'Échéance aujourd’hui' : `Échéance dans ${d} j`}</Badge> : <Badge tone="neutral">Échéance {fmtDay(due)}</Badge>
}

/** Validations du client (échantillons et BAT) : soumission, relance, enregistrement de la décision. */
export function ValidationsPanel({ projectId, stage, validations, samples, canWrite }: { projectId: string; stage: string; validations: Validation[]; samples: Sample[]; canWrite: boolean }) {
  const sampleLabel = (id: string | null) => { const s = samples.find((x) => x.id === id); return s ? `Échantillon v${s.version_no}` : 'Échantillon' }
  const submittable = samples.filter((s) => s.status === 'in_progress' || s.status === 'sent')
  const canBat = stage === 'bat' || stage === 'validation'
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-soft">Un échantillon se soumet dès qu’il est en fabrication ; le BAT à l’étape « BAT » ou « Validation client ». Une réponse du client est attendue par élément.</p>
        {canWrite && (
          <ActionDialog trigger={<><Send className="h-4 w-4" /> Soumettre au client</>} triggerVariant="primary" title="Soumettre à la validation du client" action={submitValidationAction} hidden={{ project_id: projectId }} submit="Soumettre">
            {(st) => (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="sm:col-span-2"><FormField id="sv-kind" label="Élément à valider *" errors={st?.fieldErrors?.kind}>
                  <Select id="sv-kind" name="kind" defaultValue={st?.values?.kind ?? (canBat ? 'bat' : 'sample')}><option value="bat" disabled={!canBat}>BAT{canBat ? '' : ' (étape BAT requise)'}</option><option value="sample">Échantillon</option></Select></FormField></div>
                <div className="sm:col-span-2"><FormField id="sv-sample" label="Échantillon (si type « Échantillon »)" errors={st?.fieldErrors?.sample_id}>
                  <Select id="sv-sample" name="sample_id" defaultValue={st?.values?.sample_id ?? ''}><option value="">—</option>{submittable.map((s) => <option key={s.id} value={s.id}>v{s.version_no} — {s.qty} pièce(s){s.size_label ? ` · ${s.size_label}` : ''}{s.color ? ` · ${s.color}` : ''}</option>)}</Select></FormField></div>
                <FormField id="sv-due" label="Réponse attendue avant" errors={st?.fieldErrors?.due_date}><Input id="sv-due" name="due_date" type="date" defaultValue={st?.values?.due_date} /></FormField>
                <div className="sm:col-span-2"><FormField id="sv-comment" label="Message au client (facultatif)" errors={st?.fieldErrors?.comment}><Textarea id="sv-comment" name="comment" rows={2} maxLength={1000} defaultValue={st?.values?.comment} /></FormField></div>
              </div>
            )}
          </ActionDialog>
        )}
      </div>
      {validations.length === 0 ? <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">Aucune validation demandée au client.</p> : (
        <ul className="space-y-3">
          {validations.map((v) => (
            <li key={v.id} className="rounded-md border border-line bg-white p-4 shadow-card">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 font-semibold">
                    {v.kind === 'bat' ? `BAT v${v.version_no}` : `${sampleLabel(v.sample_id)} — validation ${v.version_no}`}<Badge tone={VALIDATION_STATUS[v.status].tone}>{VALIDATION_STATUS[v.status].label}</Badge>
                    {v.status === 'pending' && <DueBadge due={v.due_date} />}{v.status === 'pending' && !v.due_date && (daysUntil(v.submitted_on) ?? 0) <= -7 && <Badge tone="warning">Sans réponse depuis {-(daysUntil(v.submitted_on) ?? 0)} j</Badge>}
                  </p>
                  <p className="mt-0.5 text-xs text-ink-soft">{VALIDATION_KIND[v.kind]} · soumis le {fmtDay(v.submitted_on)}{v.due_date ? ` · réponse attendue avant le ${fmtDay(v.due_date)}` : ''}{v.reminder_count > 0 ? ` · ${v.reminder_count} relance(s), dernière le ${fmtDay(v.last_reminder_on)}` : ''}</p>
                  {v.status !== 'pending' && <p className="mt-1 text-sm">Décision le {fmtDay(v.decided_on)}{v.decided_by_name ? ` par ${v.decided_by_name}` : ''}{v.comment ? ` — « ${v.comment} »` : ''}</p>}
                  {v.status === 'pending' && v.comment && <p className="mt-1 text-sm text-ink-soft">Message : {v.comment}</p>}
                </div>
                {canWrite && v.status === 'pending' && (
                  <div className="flex flex-wrap items-center gap-2">
                    <RemindButton id={v.id} projectId={projectId} />
                    <ActionDialog trigger="Enregistrer la réponse" triggerVariant="primary" title={`Réponse du client — ${v.kind === 'bat' ? `BAT v${v.version_no}` : sampleLabel(v.sample_id)}`} action={decideValidationAction} hidden={{ id: v.id, project_id: projectId }} submit="Enregistrer">
                      {(st) => (
                        <div className="space-y-3">
                          <FormField id={`dc-${v.id}`} label="Décision du client *">
                            <Select id={`dc-${v.id}`} name="decision" defaultValue={st?.values?.decision ?? 'approved'}><option value="approved">Approuvé</option><option value="changes_requested">Modifications demandées</option><option value="rejected">Refusé</option></Select>
                          </FormField>
                          <FormField id={`dn-${v.id}`} label="Contact du client (facultatif)"><Input id={`dn-${v.id}`} name="contact" maxLength={120} defaultValue={st?.values?.contact} placeholder="Mme Martin" /></FormField>
                          <FormField id={`dm-${v.id}`} label="Commentaire (obligatoire si refus ou modifications)"><Textarea id={`dm-${v.id}`} name="comment" rows={3} maxLength={1000} defaultValue={st?.values?.comment} /></FormField>
                          {v.kind === 'sample' && <Alert tone="info">L’échantillon passe à « approuvé », « refusé » ou « à reprendre » selon la décision.</Alert>}
                        </div>
                      )}
                    </ActionDialog>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
