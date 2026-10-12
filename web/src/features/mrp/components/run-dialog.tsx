'use client'

import { useState } from 'react'
import { Play } from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { FormField } from '@/components/auth/form-field'
import { SubmitButton } from '@/components/auth/submit-button'
import { useManualAction } from '@/lib/use-manual-action'
import { runMrpAction } from '../actions'

/** Lancer une simulation MRP : hypothèses (horizon, délai de production, prévisions, brouillons, stock de sécurité). */
export function RunDialog({ variant = 'primary' }: { variant?: 'primary' | 'secondary' }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button size="sm" variant={variant} onClick={() => setOpen(true)}><Play className="h-4 w-4" /> Lancer une simulation</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Nouvelle simulation MRP" className="max-w-xl">
        <RunForm onCancel={() => setOpen(false)} />
      </Dialog>
    </>
  )
}

function RunForm({ onCancel }: { onCancel: () => void }) {
  const [state, action, pending] = useManualAction(runMrpAction, null)
  const errs = state?.fieldErrors ?? {}
  const v = (k: string, fb: string) => state?.values?.[k] ?? fb
  return (
    <form onSubmit={action} className="space-y-3" noValidate>
      {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}
      <FormField id="name" label="Nom de la simulation" errors={errs.name}><Input id="name" name="name" maxLength={160} defaultValue={v('name', '')} placeholder="Besoins de la collection été" autoFocus /></FormField>
      <div className="grid gap-3 sm:grid-cols-3">
        <FormField id="horizon_days" label="Horizon (jours)" errors={errs.horizon_days}><Input id="horizon_days" name="horizon_days" inputMode="numeric" defaultValue={v('horizon_days', '90')} /></FormField>
        <FormField id="offset_days" label="Délai de production (j)" errors={errs.offset_days} hint="Avant la livraison."><Input id="offset_days" name="offset_days" inputMode="numeric" defaultValue={v('offset_days', '7')} /></FormField>
        <FormField id="default_lead_days" label="Délai d’appro. par défaut (j)" errors={errs.default_lead_days} hint="Si ni composant ni fournisseur."><Input id="default_lead_days" name="default_lead_days" inputMode="numeric" defaultValue={v('default_lead_days', '14')} /></FormField>
      </div>
      <fieldset className="space-y-2 rounded-md border border-line p-3 text-sm">
        <legend className="px-1 text-xs font-semibold text-ink-soft">Sources de la demande et règles</legend>
        <p className="text-xs text-ink-soft">Les commandes client <strong>confirmées</strong> sont toujours incluses.</p>
        <label className="flex items-center gap-2"><input type="checkbox" name="include_forecasts" defaultChecked className="h-4 w-4 accent-brand-500" /> Inclure les prévisions</label>
        <label className="flex items-center gap-2"><input type="checkbox" name="include_draft_orders" className="h-4 w-4 accent-brand-500" /> Inclure les commandes en brouillon (hypothèse)</label>
        <label className="flex items-center gap-2"><input type="checkbox" name="use_safety" defaultChecked className="h-4 w-4 accent-brand-500" /> Maintenir le stock de sécurité</label>
      </fieldset>
      <p className="text-xs text-ink-soft">La simulation est figée : elle n’affecte ni le stock ni les commandes. Vous pouvez en lancer plusieurs avec des hypothèses différentes.</p>
      <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onCancel}>Annuler</Button><SubmitButton disabled={pending}>{pending ? 'Calcul en cours…' : 'Lancer le calcul'}</SubmitButton></div>
    </form>
  )
}
