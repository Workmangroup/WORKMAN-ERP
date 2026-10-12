'use client'

import { CheckCircle2, Flag, Lock, Pause, Play, PlusCircle, Send } from 'lucide-react'
import { ActionDialog } from '@/components/common/action-dialog'
import { FormField } from '@/components/auth/form-field'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { RpcButton } from '@/features/stock/components/rpc-button'
import { WORK_CENTER_KINDS } from '@/lib/production/options'
import {
  closeOrderAction, createOrderAction, finishOrderAction, launchOrderAction, logProductionAction, rescheduleOrderAction,
  resumeOrderAction, saveWorkCenterAction, suspendOrderAction,
} from '../actions'

type WC = { id: string; code: string; name: string }
type Art = { id: string; internal_ref: string; name: string }

const Field = ({ id, label, errors, hint, children }: { id: string; label: string; errors?: string[]; hint?: string; children: React.ReactNode }) => (
  <FormField id={id} label={label} errors={errors} hint={hint}>{children}</FormField>
)

/** Planification d'un ordre (Planifié). */
export function NewOrderDialog({ articles, workCenters }: { articles: Art[]; workCenters: WC[] }) {
  return (
    <ActionDialog trigger={<><PlusCircle className="h-4 w-4" /> Nouvel ordre</>} triggerVariant="primary" title="Nouvel ordre de fabrication" action={createOrderAction} submit="Planifier" wide
      description="Le temps standard (minutes par pièce) sert au calcul de la charge atelier.">
      {(st) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="op-art" label="Article *" errors={st?.fieldErrors?.article_id}>
            <Select id="op-art" name="article_id" defaultValue=""><option value="">— Choisir —</option>{articles.map((a) => <option key={a.id} value={a.id}>{a.internal_ref} — {a.name}</option>)}</Select>
          </Field>
          <Field id="op-wc" label="Poste de travail" hint="Requis avant le lancement" errors={st?.fieldErrors?.work_center_id}>
            <Select id="op-wc" name="work_center_id" defaultValue=""><option value="">— À affecter —</option>{workCenters.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}</Select>
          </Field>
          <Field id="op-qty" label="Quantité *" errors={st?.fieldErrors?.qty}><Input id="op-qty" name="qty" inputMode="decimal" /></Field>
          <Field id="op-std" label="Temps standard (min / pièce) *" errors={st?.fieldErrors?.std_minutes}><Input id="op-std" name="std_minutes" inputMode="decimal" /></Field>
          <Field id="op-start" label="Début *" errors={st?.fieldErrors?.start}><Input id="op-start" name="start" type="date" /></Field>
          <Field id="op-end" label="Fin *" errors={st?.fieldErrors?.end}><Input id="op-end" name="end" type="date" /></Field>
          <div className="sm:col-span-2"><Field id="op-notes" label="Notes" errors={st?.fieldErrors?.notes}><Input id="op-notes" name="notes" maxLength={1000} /></Field></div>
        </div>
      )}
    </ActionDialog>
  )
}

/** Replanification (avant lancement uniquement). */
export function RescheduleDialog({ orderId, qty, std, start, end, workCenterId, workCenters }: {
  orderId: string; qty: number; std: number; start: string; end: string; workCenterId: string | null; workCenters: WC[]
}) {
  return (
    <ActionDialog trigger="Replanifier" triggerVariant="secondary" title="Replanifier l’ordre" action={rescheduleOrderAction} hidden={{ order_id: orderId }} submit="Enregistrer">
      {(st) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id={`rs-wc-${orderId}`} label="Poste de travail" errors={st?.fieldErrors?.work_center_id}>
            <Select id={`rs-wc-${orderId}`} name="work_center_id" defaultValue={workCenterId ?? ''}><option value="">— Aucun —</option>{workCenters.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}</Select>
          </Field>
          <Field id={`rs-qty-${orderId}`} label="Quantité" errors={st?.fieldErrors?.qty}><Input id={`rs-qty-${orderId}`} name="qty" defaultValue={String(qty)} inputMode="decimal" /></Field>
          <Field id={`rs-std-${orderId}`} label="Temps standard (min / pièce)" errors={st?.fieldErrors?.std_minutes}><Input id={`rs-std-${orderId}`} name="std_minutes" defaultValue={String(std)} inputMode="decimal" /></Field>
          <span />
          <Field id={`rs-start-${orderId}`} label="Début" errors={st?.fieldErrors?.start}><Input id={`rs-start-${orderId}`} name="start" type="date" defaultValue={start} /></Field>
          <Field id={`rs-end-${orderId}`} label="Fin" errors={st?.fieldErrors?.end}><Input id={`rs-end-${orderId}`} name="end" type="date" defaultValue={end} /></Field>
        </div>
      )}
    </ActionDialog>
  )
}

/** Saisie de suivi : heures, quantité bonne, rebut. Le journal est immuable. */
export function LogDialog({ orderId, today, remaining }: { orderId: string; today: string; remaining: number }) {
  return (
    <ActionDialog trigger={<><Send className="h-4 w-4" /> Saisir le suivi</>} triggerVariant="primary" title="Saisie de suivi" action={logProductionAction} hidden={{ order_id: orderId }} submit="Enregistrer la saisie"
      description={`Reste à produire : ${remaining} pièce(s). Une saisie ne peut pas être modifiée ensuite.`}>
      {(st) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id={`lg-date-${orderId}`} label="Date *" errors={st?.fieldErrors?.date}><Input id={`lg-date-${orderId}`} name="date" type="date" defaultValue={today} /></Field>
          <Field id={`lg-h-${orderId}`} label="Heures travaillées *" errors={st?.fieldErrors?.hours}><Input id={`lg-h-${orderId}`} name="hours" inputMode="decimal" /></Field>
          <Field id={`lg-g-${orderId}`} label="Quantité bonne *" errors={st?.fieldErrors?.good}><Input id={`lg-g-${orderId}`} name="good" inputMode="decimal" defaultValue="0" /></Field>
          <Field id={`lg-s-${orderId}`} label="Rebut *" errors={st?.fieldErrors?.scrap}><Input id={`lg-s-${orderId}`} name="scrap" inputMode="decimal" defaultValue="0" /></Field>
          <div className="sm:col-span-2"><Field id={`lg-n-${orderId}`} label="Note" errors={st?.fieldErrors?.note}><Input id={`lg-n-${orderId}`} name="note" maxLength={300} /></Field></div>
        </div>
      )}
    </ActionDialog>
  )
}

export function SuspendDialog({ orderId }: { orderId: string }) {
  return (
    <ActionDialog trigger={<><Pause className="h-4 w-4" /> Suspendre</>} triggerVariant="secondary" title="Suspendre l’ordre" action={suspendOrderAction} hidden={{ order_id: orderId }} submit="Suspendre"
      description="Le motif est conservé dans la traçabilité de l’ordre.">
      {(st) => <Field id={`sp-${orderId}`} label="Motif *" errors={st?.fieldErrors?.reason}><Input id={`sp-${orderId}`} name="reason" maxLength={300} /></Field>}
    </ActionDialog>
  )
}

/** Boutons de transition selon le statut courant. Droits et statut sont contrôlés en base. */
export function OrderActions({ id, status, closed, today, remaining }: { id: string; status: string; closed: boolean; today: string; remaining: number }) {
  if (closed) return <span className="inline-flex items-center gap-1 text-sm text-ink-soft"><Lock className="h-4 w-4" aria-hidden /> Ordre clôturé</span>
  return (
    <div className="flex flex-wrap items-center gap-2">
      {status === 'planned' && <RpcButton action={launchOrderAction} fields={{ order_id: id }} variant="primary" size="sm"><Play className="h-4 w-4" /> Lancer</RpcButton>}
      {(status === 'launched' || status === 'in_progress') && <LogDialog orderId={id} today={today} remaining={remaining} />}
      {(status === 'launched' || status === 'in_progress') && <SuspendDialog orderId={id} />}
      {status === 'suspended' && <RpcButton action={resumeOrderAction} fields={{ order_id: id }} variant="primary" size="sm"><Play className="h-4 w-4" /> Reprendre</RpcButton>}
      {(status === 'launched' || status === 'in_progress') && (
        <RpcButton action={finishOrderAction} fields={{ order_id: id }} variant="secondary" size="sm" confirm="Terminer cet ordre ? Il ne pourra plus recevoir de saisie avant clôture."><Flag className="h-4 w-4" /> Terminer</RpcButton>
      )}
      {status === 'done' && <RpcButton action={closeOrderAction} fields={{ order_id: id }} variant="primary" size="sm" confirm="Clôturer cet ordre ? Il sera verrouillé."><CheckCircle2 className="h-4 w-4" /> Clôturer</RpcButton>}
    </div>
  )
}

/** Création d'un poste de travail (planification). */
export function WorkCenterDialog() {
  return (
    <ActionDialog trigger={<><PlusCircle className="h-4 w-4" /> Nouveau poste</>} triggerVariant="primary" title="Nouveau poste de travail" action={saveWorkCenterAction} submit="Créer le poste"
      description="Heures par jour et rendement de référence servent au calcul de la charge atelier.">
      {(st) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="wc-code" label="Code *" errors={st?.fieldErrors?.code}><Input id="wc-code" name="code" maxLength={20} /></Field>
          <Field id="wc-kind" label="Type *" errors={st?.fieldErrors?.kind}><Select id="wc-kind" name="kind" defaultValue="couture">{WORK_CENTER_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</Select></Field>
          <div className="sm:col-span-2"><Field id="wc-name" label="Nom *" errors={st?.fieldErrors?.name}><Input id="wc-name" name="name" maxLength={120} /></Field></div>
          <Field id="wc-h" label="Heures par jour *" errors={st?.fieldErrors?.hours_per_day}><Input id="wc-h" name="hours_per_day" defaultValue="8" inputMode="decimal" /></Field>
          <Field id="wc-e" label="Rendement de référence (%) *" errors={st?.fieldErrors?.efficiency_pct}><Input id="wc-e" name="efficiency_pct" defaultValue="85" inputMode="decimal" /></Field>
        </div>
      )}
    </ActionDialog>
  )
}
