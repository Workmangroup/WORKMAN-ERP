'use client'

import { ArrowLeft, ArrowRight, CheckCircle2, Pause, Play, XCircle } from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { FormField } from '@/components/auth/form-field'
import { GATES, STAGES, nextStage, stageIndex, stageInfo } from '@/lib/development/options'
import { advanceProjectAction, setProjectStatusAction } from '../actions'
import { ActionDialog } from '@/components/common/action-dialog'

/** Avancer / reculer d'étape et changer le statut du projet (pause, reprise, annulation, clôture). La base impose les portes de contrôle. */
export function ProjectControls({ id, stage, status, canWrite }: { id: string; stage: string; status: string; canWrite: boolean }) {
  if (!canWrite) return null
  const next = nextStage(stage)
  const idx = stageIndex(stage)
  const previous = STAGES.slice(0, idx)
  const closed = status === 'cancelled' || status === 'completed'
  if (closed) return null
  return (
    <>
      {status === 'active' && next && (
        <ActionDialog trigger={<>Passer à « {stageInfo(next).label} » <ArrowRight className="h-4 w-4" /></>} triggerVariant="primary" title={`Passer à l’étape « ${stageInfo(next).label} »`} action={advanceProjectAction} hidden={{ id, to: next }} submit="Confirmer le passage">
          {() => <Alert tone="info">Pour quitter « {stageInfo(stage).label} » : {GATES[stage]}</Alert>}
        </ActionDialog>
      )}
      {status === 'active' && previous.length > 0 && (
        <ActionDialog trigger={<><ArrowLeft className="h-4 w-4" /> Revenir en arrière</>} triggerVariant="command" title="Revenir à une étape précédente" action={advanceProjectAction} hidden={{ id }} submit="Revenir" submitVariant="danger">
          {(st) => (
            <div className="space-y-3">
              <FormField id="back-to" label="Étape *"><Select id="back-to" name="to" defaultValue={st?.values?.to ?? previous[previous.length - 1].id}>{previous.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</Select></FormField>
              <FormField id="back-reason" label="Motif * (tracé dans l’historique)"><Textarea id="back-reason" name="reason" rows={3} maxLength={300} defaultValue={st?.values?.reason} placeholder="Le client demande une nouvelle version du prototype…" /></FormField>
            </div>
          )}
        </ActionDialog>
      )}
      {status === 'active' && <ActionDialog trigger={<><Pause className="h-4 w-4" /> Mettre en pause</>} triggerVariant="command" title="Mettre le projet en pause" action={setProjectStatusAction} hidden={{ id, status: 'on_hold' }} submit="Mettre en pause">
        {(st) => <FormField id="hold-reason" label="Motif (facultatif)"><Textarea id="hold-reason" name="reason" rows={2} maxLength={300} defaultValue={st?.values?.reason} /></FormField>}</ActionDialog>}
      {status === 'on_hold' && <ActionDialog trigger={<><Play className="h-4 w-4" /> Reprendre</>} triggerVariant="primary" title="Reprendre le projet" action={setProjectStatusAction} hidden={{ id, status: 'active' }} submit="Reprendre">{() => <p className="text-sm text-ink-soft">Le projet redevient actif à l’étape « {stageInfo(stage).label} ».</p>}</ActionDialog>}
      {stage === 'production' && status === 'active' && <ActionDialog trigger={<><CheckCircle2 className="h-4 w-4" /> Terminer le projet</>} triggerVariant="command" title="Terminer le projet" action={setProjectStatusAction} hidden={{ id, status: 'completed' }} submit="Terminer">{() => <Alert tone="info">Le projet est clos : il n’est plus modifiable (les échanges et pièces jointes restent possibles).</Alert>}</ActionDialog>}
      <ActionDialog trigger={<><XCircle className="h-4 w-4" /> Annuler le projet</>} triggerVariant="command" triggerClassName="text-danger-text" title="Annuler le projet" action={setProjectStatusAction} hidden={{ id, status: 'cancelled' }} submit="Annuler le projet" submitVariant="danger">
        {(st) => (<div className="space-y-3"><Alert tone="warning">L’annulation est définitive : le projet devient non modifiable et sort des indicateurs.</Alert>
          <FormField id="cancel-reason" label="Motif *"><Textarea id="cancel-reason" name="reason" rows={3} maxLength={300} defaultValue={st?.values?.reason} /></FormField></div>)}
      </ActionDialog>
    </>
  )
}
