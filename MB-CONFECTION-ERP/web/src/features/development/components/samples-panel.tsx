'use client'

import { Plus } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { FormField } from '@/components/auth/form-field'
import { SAMPLE_NEXT, SAMPLE_STATUS, daysUntil } from '@/lib/development/options'
import { fmtDay } from '@/features/orders/status'
import { addSampleAction, sampleStatusAction } from '../actions'
import type { Prototype, Sample } from '../types'
import { ActionDialog } from '@/components/common/action-dialog'

/** Échantillons numérotés (v1, v2…) : fabrication, envoi (n° de suivi), puis décision du client dans l'onglet Validations. */
export function SamplesPanel({ projectId, samples, prototypes, canWrite }: { projectId: string; samples: Sample[]; prototypes: Prototype[]; canWrite: boolean }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-soft">{samples.length} échantillon(s). L’approbation du client s’enregistre dans l’onglet « Validations client ».</p>
        {canWrite && (
          <ActionDialog trigger={<><Plus className="h-4 w-4" /> Nouvel échantillon</>} triggerVariant="primary" title="Nouvel échantillon" action={addSampleAction} hidden={{ project_id: projectId }} submit="Ajouter">
            {(st) => (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="sm:col-span-2"><FormField id="sm-proto" label="Issu du prototype" errors={st?.fieldErrors?.prototype_id}>
                  <Select id="sm-proto" name="prototype_id" defaultValue={st?.values?.prototype_id ?? ''}><option value="">— Aucun —</option>{prototypes.map((p) => <option key={p.id} value={p.id}>v{p.version_no}{p.name ? ` — ${p.name}` : ''}</option>)}</Select></FormField></div>
                <FormField id="sm-qty" label="Quantité *" errors={st?.fieldErrors?.qty}><Input id="sm-qty" name="qty" inputMode="numeric" defaultValue={st?.values?.qty ?? '1'} /></FormField>
                <FormField id="sm-due" label="Échéance" errors={st?.fieldErrors?.due_date}><Input id="sm-due" name="due_date" type="date" defaultValue={st?.values?.due_date} /></FormField>
                <FormField id="sm-size" label="Taille" errors={st?.fieldErrors?.size_label}><Input id="sm-size" name="size_label" maxLength={12} defaultValue={st?.values?.size_label} placeholder="L" /></FormField>
                <FormField id="sm-color" label="Coloris" errors={st?.fieldErrors?.color}><Input id="sm-color" name="color" maxLength={60} defaultValue={st?.values?.color} placeholder="Jaune HV" /></FormField>
                <div className="sm:col-span-2"><FormField id="sm-notes" label="Notes" errors={st?.fieldErrors?.notes}><Textarea id="sm-notes" name="notes" rows={2} maxLength={1000} defaultValue={st?.values?.notes} /></FormField></div>
              </div>
            )}
          </ActionDialog>
        )}
      </div>
      {samples.length === 0 ? <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">Aucun échantillon.</p> : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {samples.map((s) => {
            const proto = prototypes.find((p) => p.id === s.prototype_id)
            const late = (s.status === 'planned' || s.status === 'in_progress') && s.due_date && (daysUntil(s.due_date) ?? 0) < 0
            return (
              <li key={s.id} className="rounded-md border border-line bg-white p-4 shadow-card">
                <p className="flex flex-wrap items-center gap-2 font-semibold">Échantillon v{s.version_no}<Badge tone={SAMPLE_STATUS[s.status].tone}>{SAMPLE_STATUS[s.status].label}</Badge>{late && <Badge tone="danger">En retard</Badge>}</p>
                <dl className="mt-2 grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1 text-sm">
                  <dt className="text-ink-soft">Quantité</dt><dd>{s.qty}{s.size_label ? ` · taille ${s.size_label}` : ''}{s.color ? ` · ${s.color}` : ''}</dd>
                  {proto && <><dt className="text-ink-soft">Prototype</dt><dd>v{proto.version_no}{proto.name ? ` — ${proto.name}` : ''}</dd></>}
                  {s.due_date && <><dt className="text-ink-soft">Échéance</dt><dd>{fmtDay(s.due_date)}</dd></>}
                  {s.sent_on && <><dt className="text-ink-soft">Envoyé le</dt><dd>{fmtDay(s.sent_on)}{s.tracking ? ` · suivi ${s.tracking}` : ''}</dd></>}
                  {s.notes && <><dt className="text-ink-soft">Notes</dt><dd className="whitespace-pre-wrap">{s.notes}</dd></>}
                </dl>
                {canWrite && (SAMPLE_NEXT[s.status] ?? []).length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {SAMPLE_NEXT[s.status].map((n) => (
                      <ActionDialog key={n.to} trigger={n.label} title={`${n.label} — échantillon v${s.version_no}`} action={sampleStatusAction} hidden={{ id: s.id, project_id: projectId, status: n.to }} submit={n.label} submitVariant="primary">
                        {() => n.to === 'sent' ? <FormField id={`trk-${s.id}`} label="N° de suivi du transporteur (facultatif)"><Input id={`trk-${s.id}`} name="tracking" maxLength={80} placeholder="DHL 123456" /></FormField> : null}
                      </ActionDialog>
                    ))}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
