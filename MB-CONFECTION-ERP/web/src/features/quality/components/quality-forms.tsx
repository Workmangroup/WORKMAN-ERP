'use client'

import { CheckCircle2, Plus, ShieldCheck, XCircle } from 'lucide-react'
import { ActionDialog } from '@/components/common/action-dialog'
import { FormField } from '@/components/auth/form-field'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { RpcButton } from '@/features/stock/components/rpc-button'
import {
  addActionAction, addDefectAction, cancelActionAction, containNcAction, createPlanAction, decideInspectionAction, openInspectionAction,
  openNcAction, planStepAction, progressActionAction, saveDefectCodeAction, verifyActionAction, closeNcAction,
} from '../actions'

const CATEGORIES = [['matiere', 'Matière'], ['coupe', 'Coupe'], ['couture', 'Couture'], ['finition', 'Finition'], ['dimension', 'Dimension'], ['etiquetage', 'Étiquetage'], ['autre', 'Autre']]
const SEVERITIES = [['minor', 'Mineure'], ['major', 'Majeure'], ['critical', 'Critique']]

export function NewDefectCodeDialog() {
  return (
    <ActionDialog trigger={<><Plus className="h-4 w-4" /> Nouveau défaut</>} triggerVariant="primary" title="Nouveau défaut du référentiel" action={saveDefectCodeAction} submit="Enregistrer"
      description="Un code existant est mis à jour. La gravité par défaut s’applique quand le contrôle n’en précise pas.">
      {(st) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField id="dc-code" label="Code *" errors={st?.fieldErrors?.code}><Input id="dc-code" name="code" maxLength={20} /></FormField>
          <FormField id="dc-cat" label="Famille *" errors={st?.fieldErrors?.category}><Select id="dc-cat" name="category" defaultValue="couture">{CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></FormField>
          <div className="sm:col-span-2"><FormField id="dc-label" label="Libellé *" errors={st?.fieldErrors?.label}><Input id="dc-label" name="label" maxLength={120} /></FormField></div>
          <FormField id="dc-sev" label="Gravité par défaut *" errors={st?.fieldErrors?.severity}><Select id="dc-sev" name="severity" defaultValue="minor">{SEVERITIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></FormField>
        </div>
      )}
    </ActionDialog>
  )
}

type Src = { materials: { id: string; code: string; name: string }[]; articles: { id: string; internal_ref: string; name: string }[]; orders: { id: string; number: string; article_name: string }[] }

export function OpenInspectionDialog({ src }: { src: Src }) {
  return (
    <ActionDialog trigger={<><Plus className="h-4 w-4" /> Nouveau contrôle</>} triggerVariant="primary" title="Ouvrir un contrôle" action={openInspectionAction} submit="Ouvrir le contrôle" wide
      description="Réception : une matière et le numéro de bon de livraison. Production : un ordre de fabrication. Final : un article ou un ordre.">
      {(st) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField id="oi-kind" label="Type *" errors={st?.fieldErrors?.kind}>
            <Select id="oi-kind" name="kind" defaultValue="reception"><option value="reception">Contrôle réception</option><option value="production">Contrôle production</option><option value="final">Contrôle final</option></Select>
          </FormField>
          <FormField id="oi-sample" label="Taille de l’échantillon *" errors={st?.fieldErrors?.sample}><Input id="oi-sample" name="sample" inputMode="decimal" /></FormField>
          <FormField id="oi-mat" label="Matière (réception)" errors={st?.fieldErrors?.material_id}>
            <Select id="oi-mat" name="material_id" defaultValue=""><option value="">— Aucune —</option>{src.materials.map((m) => <option key={m.id} value={m.id}>{m.code} — {m.name}</option>)}</Select>
          </FormField>
          <FormField id="oi-ref" label="N° bon de livraison" errors={st?.fieldErrors?.receipt_ref}><Input id="oi-ref" name="receipt_ref" maxLength={60} /></FormField>
          <FormField id="oi-ord" label="Ordre de fabrication (production)" errors={st?.fieldErrors?.production_order_id}>
            <Select id="oi-ord" name="production_order_id" defaultValue=""><option value="">— Aucun —</option>{src.orders.map((o) => <option key={o.id} value={o.id}>{o.number} — {o.article_name}</option>)}</Select>
          </FormField>
          <FormField id="oi-art" label="Article (contrôle final)" errors={st?.fieldErrors?.article_id}>
            <Select id="oi-art" name="article_id" defaultValue=""><option value="">— Aucun —</option>{src.articles.map((a) => <option key={a.id} value={a.id}>{a.internal_ref} — {a.name}</option>)}</Select>
          </FormField>
          <div className="sm:col-span-2"><FormField id="oi-note" label="Note" errors={st?.fieldErrors?.note}><Input id="oi-note" name="note" maxLength={500} /></FormField></div>
        </div>
      )}
    </ActionDialog>
  )
}

export function AddDefectDialog({ inspectionId, codes }: { inspectionId: string; codes: { code: string; label: string }[] }) {
  return (
    <ActionDialog trigger={<><Plus className="h-4 w-4" /> Constater un défaut</>} triggerVariant="primary" title="Constater un défaut" action={addDefectAction} hidden={{ inspection_id: inspectionId }} submit="Enregistrer le défaut"
      description="Une fois le contrôle décidé, les défauts ne peuvent plus être ajoutés : l’historique est immuable.">
      {(st) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField id={`ad-code-${inspectionId}`} label="Défaut *" errors={st?.fieldErrors?.code}>
            <Select id={`ad-code-${inspectionId}`} name="code" defaultValue=""><option value="">— Choisir —</option>{codes.map((c) => <option key={c.code} value={c.code}>{c.code} — {c.label}</option>)}</Select>
          </FormField>
          <FormField id={`ad-qty-${inspectionId}`} label="Nombre de défauts *" errors={st?.fieldErrors?.qty}><Input id={`ad-qty-${inspectionId}`} name="qty" defaultValue="1" inputMode="decimal" /></FormField>
          <FormField id={`ad-sev-${inspectionId}`} label="Gravité (facultatif)" hint="Par défaut : celle du référentiel" errors={st?.fieldErrors?.severity}>
            <Select id={`ad-sev-${inspectionId}`} name="severity" defaultValue=""><option value="">Référentiel</option>{SEVERITIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
          </FormField>
          <FormField id={`ad-note-${inspectionId}`} label="Note" errors={st?.fieldErrors?.note}><Input id={`ad-note-${inspectionId}`} name="note" maxLength={300} /></FormField>
        </div>
      )}
    </ActionDialog>
  )
}

/** Décision : acceptation, acceptation conditionnelle ou rejet (rejet = non-conformité automatique). */
export function DecisionButtons({ inspectionId, hasCritical, hasMajor }: { inspectionId: string; hasCritical: boolean; hasMajor: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <RpcButton action={decideInspectionAction} fields={{ inspection_id: inspectionId, decision: 'accepted' }} variant="primary" size="sm" disabled={hasCritical || hasMajor}
        confirm="Accepter ce contrôle ?"><CheckCircle2 className="h-4 w-4" /> Accepter</RpcButton>
      <RpcButton action={decideInspectionAction} fields={{ inspection_id: inspectionId, decision: 'conditional' }} variant="secondary" size="sm" disabled={hasCritical}
        confirm="Accepter sous réserve ? Les défauts sont comptés comme rebut."><ShieldCheck className="h-4 w-4" /> Accepter sous réserve</RpcButton>
      <RpcButton action={decideInspectionAction} fields={{ inspection_id: inspectionId, decision: 'rejected' }} variant="secondary" size="sm"
        confirm="Rejeter ce contrôle ? Une non-conformité sera ouverte automatiquement."><XCircle className="h-4 w-4" /> Rejeter</RpcButton>
    </div>
  )
}

export function OpenNcDialog() {
  return (
    <ActionDialog trigger={<><Plus className="h-4 w-4" /> Nouvelle non-conformité</>} triggerVariant="primary" title="Ouvrir une non-conformité" action={openNcAction} submit="Ouvrir">
      {(st) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2"><FormField id="nc-title" label="Titre *" errors={st?.fieldErrors?.title}><Input id="nc-title" name="title" maxLength={160} /></FormField></div>
          <div className="sm:col-span-2"><FormField id="nc-desc" label="Description" errors={st?.fieldErrors?.description}><Input id="nc-desc" name="description" maxLength={1000} /></FormField></div>
          <FormField id="nc-sev" label="Gravité *" errors={st?.fieldErrors?.severity}><Select id="nc-sev" name="severity" defaultValue="minor">{SEVERITIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></FormField>
          <FormField id="nc-due" label="Échéance" errors={st?.fieldErrors?.due}><Input id="nc-due" name="due" type="date" /></FormField>
        </div>
      )}
    </ActionDialog>
  )
}

export function ContainNcDialog({ ncId }: { ncId: string }) {
  return (
    <ActionDialog trigger="Confiner" triggerVariant="primary" triggerSize="sm" title="Confinement et cause probable" action={containNcAction} hidden={{ nc_id: ncId }} submit="Confiner">
      {(st) => (
        <div className="space-y-3">
          <FormField id={`cn-c-${ncId}`} label="Action immédiate (confinement) *" errors={st?.fieldErrors?.containment}><Input id={`cn-c-${ncId}`} name="containment" maxLength={500} /></FormField>
          <FormField id={`cn-r-${ncId}`} label="Cause probable" errors={st?.fieldErrors?.root_cause}><Input id={`cn-r-${ncId}`} name="root_cause" maxLength={500} /></FormField>
        </div>
      )}
    </ActionDialog>
  )
}

export function CloseNcDialog({ ncId }: { ncId: string }) {
  return (
    <ActionDialog trigger="Clôturer" triggerVariant="primary" triggerSize="sm" title="Clôturer la non-conformité" action={closeNcAction} hidden={{ nc_id: ncId }} submit="Clôturer"
      description="Clôture possible si toutes les actions sont vérifiées efficaces ou annulées. Sans action vérifiée, une justification de 10 caractères minimum est exigée.">
      {(st) => <FormField id={`cl-${ncId}`} label="Justification" errors={st?.fieldErrors?.note}><Input id={`cl-${ncId}`} name="note" maxLength={500} /></FormField>}
    </ActionDialog>
  )
}

export function AddActionDialog({ ncId, plans }: { ncId: string; plans: { id: string; number: string; title: string }[] }) {
  return (
    <ActionDialog trigger={<><Plus className="h-4 w-4" /> Action</>} triggerVariant="secondary" triggerSize="sm" title="Ajouter une action" action={addActionAction} hidden={{ nc_id: ncId }} submit="Ajouter" wide>
      {(st) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField id={`aa-k-${ncId}`} label="Type *" errors={st?.fieldErrors?.kind}><Select id={`aa-k-${ncId}`} name="kind" defaultValue="corrective"><option value="corrective">Corrective</option><option value="preventive">Préventive</option></Select></FormField>
          <FormField id={`aa-d-${ncId}`} label="Échéance *" errors={st?.fieldErrors?.due}><Input id={`aa-d-${ncId}`} name="due" type="date" /></FormField>
          <div className="sm:col-span-2"><FormField id={`aa-a-${ncId}`} label="Action *" errors={st?.fieldErrors?.action}><Input id={`aa-a-${ncId}`} name="action" maxLength={500} /></FormField></div>
          <FormField id={`aa-p-${ncId}`} label="Plan d’actions (activé)" errors={st?.fieldErrors?.plan_id}>
            <Select id={`aa-p-${ncId}`} name="plan_id" defaultValue=""><option value="">— Aucun —</option>{plans.map((p) => <option key={p.id} value={p.id}>{p.number} — {p.title}</option>)}</Select>
          </FormField>
        </div>
      )}
    </ActionDialog>
  )
}

/** Transitions d'une action : avancement, vérification d'efficacité, annulation. */
export function ActionButtons({ id, status }: { id: string; status: string }) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {status === 'todo' && <RpcButton action={progressActionAction} fields={{ ca_id: id, status: 'in_progress' }} variant="secondary" size="sm">Démarrer</RpcButton>}
      {(status === 'todo' || status === 'in_progress') && <RpcButton action={progressActionAction} fields={{ ca_id: id, status: 'done' }} variant="secondary" size="sm">Marquer faite</RpcButton>}
      {status === 'done' && <RpcButton action={verifyActionAction} fields={{ ca_id: id, effective: 'true' }} variant="primary" size="sm">Vérifier : efficace</RpcButton>}
      {status === 'done' && <RpcButton action={verifyActionAction} fields={{ ca_id: id, effective: 'false' }} variant="secondary" size="sm">Vérifier : inefficace</RpcButton>}
      {(status === 'todo' || status === 'in_progress' || status === 'done') && (
        <ActionDialog trigger="Annuler" triggerVariant="ghost" triggerSize="sm" title="Annuler l’action" action={cancelActionAction} hidden={{ ca_id: id }} submit="Annuler l’action">
          {(st) => <FormField id={`ca-r-${id}`} label="Motif *" errors={st?.fieldErrors?.reason}><Input id={`ca-r-${id}`} name="reason" maxLength={300} /></FormField>}
        </ActionDialog>
      )}
    </div>
  )
}

export function NewPlanDialog() {
  return (
    <ActionDialog trigger={<><Plus className="h-4 w-4" /> Nouveau plan</>} triggerVariant="primary" title="Nouveau plan d’actions" action={createPlanAction} submit="Créer le plan" description="Le plan est en brouillon : il s’active avant de recevoir des actions.">
      {(st) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2"><FormField id="pl-t" label="Titre *" errors={st?.fieldErrors?.title}><Input id="pl-t" name="title" maxLength={160} /></FormField></div>
          <div className="sm:col-span-2"><FormField id="pl-o" label="Objectif" errors={st?.fieldErrors?.objective}><Input id="pl-o" name="objective" maxLength={500} /></FormField></div>
          <FormField id="pl-s" label="Début *" errors={st?.fieldErrors?.start}><Input id="pl-s" name="start" type="date" /></FormField>
          <FormField id="pl-e" label="Échéance *" errors={st?.fieldErrors?.target}><Input id="pl-e" name="target" type="date" /></FormField>
        </div>
      )}
    </ActionDialog>
  )
}

export function PlanButtons({ id, status }: { id: string; status: string }) {
  if (status === 'draft') return <RpcButton action={planStepAction} fields={{ plan_id: id, step: 'activate' }} variant="primary" size="sm">Activer</RpcButton>
  if (status === 'active') return <RpcButton action={planStepAction} fields={{ plan_id: id, step: 'close' }} variant="secondary" size="sm" confirm="Clôturer le plan ?">Clôturer</RpcButton>
  return null
}
