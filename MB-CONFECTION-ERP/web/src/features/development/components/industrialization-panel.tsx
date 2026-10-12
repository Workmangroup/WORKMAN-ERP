'use client'

import { useActionState } from 'react'
import Link from 'next/link'
import { CheckCircle2, RotateCcw } from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { FormField } from '@/components/auth/form-field'
import { SubmitButton } from '@/components/auth/submit-button'
import { INDUSTRIALIZATION_STATUS } from '@/lib/development/options'
import { fmtDay } from '@/features/orders/status'
import { industrializationStatusAction, saveIndustrializationAction } from '../actions'
import type { Industrialization } from '../types'

/** Industrialisation : liste de contrôle, paramètres de la série pilote, nomenclature liée ; « prête » exige 100 % de la liste. */
export function IndustrializationPanel({ projectId, ind, boms, product, editable, stage }: {
  projectId: string; ind: Industrialization; boms: { id: string; label: string }[]; product: { id: string; code: string; name: string; validated: boolean } | null; editable: boolean; stage: string
}) {
  const [state, action] = useActionState(saveIndustrializationAction, null)
  const [sState, sAction] = useActionState(industrializationStatusAction, null)
  const done = ind.checklist.filter((c) => c.done).length
  const pct = ind.checklist.length ? Math.round((100 * done) / ind.checklist.length) : 0
  const errs = state?.fieldErrors ?? {}
  const locked = !editable || ind.status === 'released'
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Badge tone={INDUSTRIALIZATION_STATUS[ind.status].tone}>{INDUSTRIALIZATION_STATUS[ind.status].label}</Badge>
        <span className="text-sm text-ink-soft">{done} / {ind.checklist.length} points de contrôle ({pct} %){ind.ready_at ? ` · prête le ${fmtDay(ind.ready_at)}` : ''}{ind.released_at ? ` · livrée en série le ${fmtDay(ind.released_at)}` : ''}</span>
        <div className="h-2 w-40 overflow-hidden rounded-full bg-canvas" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Avancement de l’industrialisation"><div className="h-full bg-brand-500" style={{ width: `${pct}%` }} /></div>
        {editable && ind.status !== 'released' && (
          <form action={sAction} className="ml-auto flex items-center gap-2">
            <input type="hidden" name="project_id" value={projectId} />
            {ind.status === 'ready'
              ? <><input type="hidden" name="status" value="in_progress" /><SubmitButton variant="secondary" size="sm" pendingText="…"><RotateCcw className="h-4 w-4" /> Remettre en cours</SubmitButton></>
              : <><input type="hidden" name="status" value="ready" /><SubmitButton size="sm" pendingText="Vérification…"><CheckCircle2 className="h-4 w-4" /> Déclarer prête</SubmitButton></>}
          </form>
        )}
      </div>
      {sState && <Alert tone={sState.ok ? 'success' : 'error'}>{sState.message}</Alert>}
      {stage !== 'industrialization' && stage !== 'production' && <Alert tone="info">L’industrialisation démarre à l’étape « Industrialisation » ; vous pouvez déjà préparer la liste de contrôle.</Alert>}
      {product && <Alert tone={product.validated ? 'success' : 'warning'}>Fiche produit liée : <Link className="font-semibold underline" href={`/products/${product.id}`}>{product.code} — {product.name}</Link>. {product.validated ? 'Une version est validée : la mise en série est possible.' : 'Aucune version validée : la mise en série sera bloquée tant qu’elle ne l’est pas.'}</Alert>}

      <form action={action} className="space-y-4" noValidate>
        <input type="hidden" name="project_id" value={projectId} />
        {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}
        {state?.ok && <Alert tone="success">{state.message}</Alert>}
        <section className="rounded-md border border-line bg-white p-4 shadow-card">
          <h3 className="mb-2 text-sm font-semibold">Liste de contrôle</h3>
          <ul className="grid gap-1 sm:grid-cols-2">
            {ind.checklist.map((c) => (
              <li key={c.key}><label className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-canvas">
                <input type="checkbox" name="done" value={c.key} defaultChecked={c.done} disabled={locked} className="h-4 w-4 accent-brand-500" /><span>{c.label}</span></label></li>
            ))}
          </ul>
        </section>
        <section className="grid gap-4 rounded-md border border-line bg-white p-4 shadow-card sm:grid-cols-2 lg:grid-cols-4">
          <FormField id="in-date" label="Date cible de mise en série" errors={errs.target_date}><Input id="in-date" name="target_date" type="date" defaultValue={state?.values?.target_date ?? ind.target_date?.slice(0, 10) ?? ''} disabled={locked} /></FormField>
          <FormField id="in-pilot" label="Série pilote (pièces)" errors={errs.pilot_qty}><Input id="in-pilot" name="pilot_qty" inputMode="numeric" defaultValue={state?.values?.pilot_qty ?? ind.pilot_qty ?? ''} disabled={locked} /></FormField>
          <FormField id="in-lead" label="Délai de production (jours)" errors={errs.lead_time_days}><Input id="in-lead" name="lead_time_days" inputMode="numeric" defaultValue={state?.values?.lead_time_days ?? ind.lead_time_days ?? ''} disabled={locked} /></FormField>
          <FormField id="in-bom" label="Nomenclature (BOM)" errors={errs.bom_id}>
            <Select id="in-bom" name="bom_id" defaultValue={state?.values?.bom_id ?? ind.bom_id ?? ''} disabled={locked}><option value="">— Aucune —</option>{boms.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}</Select>
          </FormField>
          <div className="sm:col-span-2 lg:col-span-4"><FormField id="in-notes" label="Notes" errors={errs.notes}><Textarea id="in-notes" name="notes" rows={3} maxLength={2000} defaultValue={state?.values?.notes ?? ind.notes ?? ''} disabled={locked} /></FormField></div>
          {ind.bom_id && <p className="text-sm sm:col-span-2 lg:col-span-4"><Link className="text-brand-700 hover:underline" href={`/bom/${ind.bom_id}`}>Ouvrir la nomenclature liée</Link></p>}
        </section>
        {!locked && <div className="flex justify-end"><SubmitButton pendingText="Enregistrement…">Enregistrer</SubmitButton></div>}
      </form>
    </div>
  )
}
