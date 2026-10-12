'use client'

import { useActionState, useEffect, useRef, useState } from 'react'
import { Network, Package, Plus, Save, Trash2 } from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { SubmitButton } from '@/components/auth/submit-button'
import { useManualAction } from '@/lib/use-manual-action'
import { MATERIAL_CATEGORIES, formatMinutes, formatMoney, formatPct, formatQty, formatUnitPrice, unitLabel } from '@/lib/bom/options'
import { addLineAction, addOperationAction, deleteLineAction, deleteOperationAction, saveCostingAction, updateLineAction, updateOperationAction } from '../actions'
import type { MaterialOption } from '../services/bom.service'
import type { TreeLine, TreeNode } from '../types'

const dec = (n: number | undefined | null) => (n === undefined || n === null ? '' : String(n).replace('.', ','))

function Msg({ state }: { state: { ok: boolean; message?: string } | null }) {
  if (!state?.message) return null
  return <p role={state.ok ? 'status' : 'alert'} className={state.ok ? 'text-xs text-success-text' : 'text-xs text-danger-text'}>{state.message}</p>
}

/** Éditeur de la version en brouillon : composants, sous-ensembles, main-d'œuvre et paramètres de coût. */
export function CompositionEditor({
  bomId, versionId, tree, materials, subs, costs, editable,
}: {
  bomId: string
  versionId: string
  tree: TreeNode
  materials: MaterialOption[]
  subs: { id: string; code: string; name: string; kind: string }[]
  costs: boolean
  editable: boolean
}) {
  const t = tree.totals
  return (
    <div className="space-y-4">
      {costs && t && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {([['Matière', t.material], ['Main-d’œuvre', t.labor], ['Frais généraux', t.overhead], ['Coût de revient', t.total]] as const).map(([k, v], i) => (
            <div key={k} className={`rounded-md border p-3 shadow-card ${i === 3 ? 'border-brand-300 bg-brand-50' : 'border-line bg-white'}`}>
              <p className="text-xs text-ink-soft">{k}</p>
              <p className="text-lg font-semibold tabular-nums">{formatMoney(v)}</p>
            </div>
          ))}
        </div>
      )}
      {costs && t && t.missing.length > 0 && <Alert tone="warning">Prix manquant pour : {t.missing.join(', ')}. Le coût affiché est incomplet et la validation sera refusée.</Alert>}

      <section className="rounded-md border border-line bg-white shadow-card">
        <div className="border-b border-line px-5 py-3">
          <h2 className="text-base font-semibold">Composants et sous-ensembles</h2>
          <p className="text-xs text-ink-soft">Quantité pour une pièce finie (taille de référence). La perte majore la quantité consommée.</p>
        </div>
        {tree.lines.length === 0 ? (
          <p className="p-6 text-center text-sm text-ink-soft">Aucun composant. Ajoutez le tissu, la fermeture, la mercerie, le fil…</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[44rem] text-sm">
              <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft">
                <tr><th className="px-4 py-2 font-semibold">Composant</th><th className="w-28 px-2 py-2 font-semibold">Quantité</th><th className="w-24 px-2 py-2 font-semibold">Perte %</th><th className="px-2 py-2 font-semibold">Note</th>{costs && <th className="w-28 px-2 py-2 text-right font-semibold">Coût</th>}<th className="w-24 px-4 py-2" /></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {tree.lines.map((l) => <LineRow key={l.id} line={l} bomId={bomId} costs={costs} editable={editable} />)}
              </tbody>
            </table>
          </div>
        )}
        {editable && <AddLine bomId={bomId} versionId={versionId} materials={materials} subs={subs} costs={costs} />}
      </section>

      <section className="rounded-md border border-line bg-white shadow-card">
        <div className="border-b border-line px-5 py-3">
          <h2 className="text-base font-semibold">Main-d’œuvre</h2>
          <p className="text-xs text-ink-soft">Opérations de confection ; coût = durée × taux horaire de la version.</p>
        </div>
        {tree.operations.length === 0 ? (
          <p className="p-6 text-center text-sm text-ink-soft">Aucune opération (coupe, assemblage, finitions…).</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm">
              <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft">
                <tr><th className="px-4 py-2 font-semibold">Opération</th><th className="w-32 px-2 py-2 font-semibold">Durée (min)</th>{costs && <th className="w-28 px-2 py-2 text-right font-semibold">Coût</th>}<th className="w-24 px-4 py-2" /></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {tree.operations.map((o) => <OpRow key={o.id} op={o} bomId={bomId} costs={costs} editable={editable} />)}
              </tbody>
              <tfoot className="border-t border-line bg-canvas text-xs"><tr><td className="px-4 py-2 font-semibold">Total</td><td className="px-2 py-2 font-semibold">{formatMinutes(tree.operations.reduce((a, o) => a + o.minutes, 0))}</td>{costs && <td className="px-2 py-2 text-right font-semibold tabular-nums">{formatMoney(tree.operations.reduce((a, o) => a + (o.cost ?? 0), 0))}</td>}<td /></tr></tfoot>
            </table>
          </div>
        )}
        {editable && <AddOperation bomId={bomId} versionId={versionId} />}
        {costs && tree.hourly_rate !== undefined && <Costing bomId={bomId} versionId={versionId} hourlyRate={tree.hourly_rate} overheadPct={tree.overhead_pct ?? 0} editable={editable} />}
      </section>
    </div>
  )
}

function LineRow({ line, bomId, costs, editable }: { line: TreeLine; bomId: string; costs: boolean; editable: boolean }) {
  const [state, action] = useActionState(updateLineAction, null)
  const isMat = line.type === 'material'
  const unit = isMat ? unitLabel(line.material.unit) : 'pièce'
  const formId = `line-${line.id}`
  return (
    <tr className="align-top">
      <td className="px-4 py-2">
        <div className="flex items-start gap-2">
          {isMat ? <Package className="mt-0.5 h-4 w-4 shrink-0 text-ink-soft" aria-hidden /> : <Network className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" aria-hidden />}
          <div className="min-w-0">
            <p className="font-medium">{isMat ? line.material.name : line.child.name}</p>
            <p className="text-xs text-ink-soft">
              <span className="font-mono">{isMat ? line.material.code : line.child.code}</span>
              {isMat ? ` · ${MATERIAL_CATEGORIES.find((c) => c.value === line.material.category)?.label}${line.material.color ? ` · ${line.material.color}` : ''}` : ' · sous-ensemble'}
              {isMat && line.material.archived && <Badge tone="warning" className="ml-1">archivé</Badge>}
              {!isMat && !line.child.validated && <Badge tone="warning" className="ml-1">non validé</Badge>}
            </p>
            {costs && isMat && <p className="text-xs text-ink-faint">{line.unit_cost === null || line.unit_cost === undefined ? <span className="text-warn-text">Prix non renseigné</span> : `${formatUnitPrice(line.unit_cost)} / ${unit}`}</p>}
            <Msg state={state} />
          </div>
        </div>
      </td>
      {editable ? (
        <>
          <td className="px-2 py-2"><form id={formId} action={action}><input type="hidden" name="id" value={line.id} /><input type="hidden" name="bom_id" value={bomId} /></form>
            <div className="flex items-center gap-1"><Input form={formId} name="quantity" inputMode="decimal" defaultValue={dec(line.qty)} aria-label="Quantité" className="h-8 w-20" /><span className="text-xs text-ink-soft">{unit}</span></div></td>
          <td className="px-2 py-2">{isMat ? <Input form={formId} name="waste_pct" inputMode="decimal" defaultValue={dec(line.waste_pct)} aria-label="Perte en pourcentage" className="h-8 w-16" /> : <span className="text-ink-faint">—</span>}</td>
          <td className="px-2 py-2"><Input form={formId} name="note" defaultValue={line.note ?? ''} maxLength={300} aria-label="Note" className="h-8" /></td>
        </>
      ) : (
        <>
          <td className="px-2 py-2 tabular-nums">{formatQty(line.qty)} {unit}</td>
          <td className="px-2 py-2 tabular-nums">{isMat ? formatPct(line.waste_pct) : '—'}</td>
          <td className="px-2 py-2 text-ink-soft">{line.note ?? ''}</td>
        </>
      )}
      {costs && <td className="px-2 py-2 text-right tabular-nums">{line.cost === null || line.cost === undefined ? '—' : formatMoney(line.cost)}</td>}
      <td className="px-4 py-2 text-right">
        {editable && (
          <div className="flex justify-end gap-1">
            <Button type="submit" form={formId} variant="ghost" size="sm" aria-label="Enregistrer la ligne" title="Enregistrer"><Save className="h-4 w-4" /></Button>
            <form action={deleteLineAction} onSubmit={(e) => { if (!window.confirm('Retirer cette ligne de la nomenclature ?')) e.preventDefault() }}>
              <input type="hidden" name="id" value={line.id} /><input type="hidden" name="bom_id" value={bomId} />
              <Button type="submit" variant="ghost" size="sm" aria-label="Retirer la ligne" title="Retirer"><Trash2 className="h-4 w-4 text-danger-text" /></Button>
            </form>
          </div>
        )}
      </td>
    </tr>
  )
}

function AddLine({ bomId, versionId, materials, subs, costs }: { bomId: string; versionId: string; materials: MaterialOption[]; subs: { id: string; code: string; name: string; kind: string }[]; costs: boolean }) {
  const [state, action, pending] = useManualAction(addLineAction, null)
  const ref = useRef<HTMLFormElement>(null)
  const [component, setComponent] = useState('')
  useEffect(() => { if (state?.ok) { ref.current?.reset(); setComponent('') } }, [state])
  const picked = component.startsWith('m:') ? materials.find((m) => m.id === component.slice(2)) : undefined
  const isSub = component.startsWith('b:')
  const errs = state?.fieldErrors ?? {}
  return (
    <form ref={ref} onSubmit={action} className="space-y-3 border-t border-line bg-canvas/50 p-4">
      <input type="hidden" name="bom_id" value={bomId} /><input type="hidden" name="version_id" value={versionId} />
      <p className="text-sm font-semibold">Ajouter une ligne</p>
      {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}
      {state?.ok && <p role="status" className="text-xs text-success-text">{state.message}</p>}
      <div className="grid gap-3 md:grid-cols-[minmax(0,2fr)_8rem_6rem_minmax(0,1.2fr)_auto] md:items-end">
        <div>
          <label htmlFor="component" className="mb-1 block text-xs font-semibold">Composant ou sous-ensemble *</label>
          <Select id="component" name="component" value={component} onChange={(e) => setComponent(e.target.value)} aria-invalid={Boolean(errs.component)}>
            <option value="">— Choisir —</option>
            {MATERIAL_CATEGORIES.map((c) => {
              const list = materials.filter((m) => m.category === c.value)
              return list.length ? (
                <optgroup key={c.value} label={c.label}>
                  {list.map((m) => <option key={m.id} value={`m:${m.id}`}>{m.name}{m.color ? ` — ${m.color}` : ''} ({m.code})</option>)}
                </optgroup>
              ) : null
            })}
            {subs.length > 0 && <optgroup label="Sous-ensembles validés">{subs.map((s) => <option key={s.id} value={`b:${s.id}`}>{s.name} ({s.code})</option>)}</optgroup>}
          </Select>
        </div>
        <div>
          <label htmlFor="quantity" className="mb-1 block text-xs font-semibold">Quantité * {picked ? `(${unitLabel(picked.unit)})` : isSub ? '(pièces)' : ''}</label>
          <Input id="quantity" name="quantity" inputMode="decimal" placeholder="ex. 2,2" aria-invalid={Boolean(errs.quantity)} />
        </div>
        <div>
          <label htmlFor="waste_pct" className="mb-1 block text-xs font-semibold">Perte %</label>
          <Input id="waste_pct" name="waste_pct" inputMode="decimal" placeholder="0" disabled={isSub} />
        </div>
        <div>
          <label htmlFor="note" className="mb-1 block text-xs font-semibold">Note</label>
          <Input id="note" name="note" maxLength={300} placeholder="Emplacement, remarque…" />
        </div>
        <SubmitButton disabled={pending}><Plus className="h-4 w-4" /> {pending ? 'Ajout…' : 'Ajouter'}</SubmitButton>
      </div>
      {costs && picked && <p className="text-xs text-ink-soft">{picked.unit_cost === null ? 'Prix non renseigné pour ce composant.' : `Prix : ${formatUnitPrice(picked.unit_cost)} / ${unitLabel(picked.unit)}`}</p>}
      {materials.length === 0 && <p className="text-xs text-warn-text">Le catalogue est vide : créez d’abord les composants (menu « Composants »).</p>}
    </form>
  )
}

function OpRow({ op, bomId, costs, editable }: { op: TreeNode['operations'][number]; bomId: string; costs: boolean; editable: boolean }) {
  const [state, action] = useActionState(updateOperationAction, null)
  const formId = `op-${op.id}`
  return (
    <tr className="align-top">
      {editable ? (
        <>
          <td className="px-4 py-2"><form id={formId} action={action}><input type="hidden" name="id" value={op.id} /><input type="hidden" name="bom_id" value={bomId} /></form>
            <Input form={formId} name="name" defaultValue={op.name} maxLength={120} aria-label="Nom de l’opération" className="h-8" /><Msg state={state} /></td>
          <td className="px-2 py-2"><Input form={formId} name="minutes" inputMode="decimal" defaultValue={dec(op.minutes)} aria-label="Durée en minutes" className="h-8 w-24" /></td>
        </>
      ) : (
        <><td className="px-4 py-2 font-medium">{op.name}</td><td className="px-2 py-2 tabular-nums">{formatMinutes(op.minutes)}</td></>
      )}
      {costs && <td className="px-2 py-2 text-right tabular-nums">{op.cost === undefined ? '—' : formatMoney(op.cost)}</td>}
      <td className="px-4 py-2 text-right">
        {editable && (
          <div className="flex justify-end gap-1">
            <Button type="submit" form={formId} variant="ghost" size="sm" aria-label="Enregistrer l’opération" title="Enregistrer"><Save className="h-4 w-4" /></Button>
            <form action={deleteOperationAction} onSubmit={(e) => { if (!window.confirm('Supprimer cette opération ?')) e.preventDefault() }}>
              <input type="hidden" name="id" value={op.id} /><input type="hidden" name="bom_id" value={bomId} />
              <Button type="submit" variant="ghost" size="sm" aria-label="Supprimer l’opération" title="Supprimer"><Trash2 className="h-4 w-4 text-danger-text" /></Button>
            </form>
          </div>
        )}
      </td>
    </tr>
  )
}

function AddOperation({ bomId, versionId }: { bomId: string; versionId: string }) {
  const [state, action] = useActionState(addOperationAction, null)
  const ref = useRef<HTMLFormElement>(null)
  useEffect(() => { if (state?.ok) ref.current?.reset() }, [state])
  return (
    <form ref={ref} action={action} className="space-y-3 border-t border-line bg-canvas/50 p-4">
      <input type="hidden" name="bom_id" value={bomId} /><input type="hidden" name="version_id" value={versionId} />
      <p className="text-sm font-semibold">Ajouter une opération</p>
      {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}
      {state?.ok && <p role="status" className="text-xs text-success-text">{state.message}</p>}
      <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_9rem_auto] sm:items-end">
        <div><label htmlFor="op-name" className="mb-1 block text-xs font-semibold">Opération *</label><Input id="op-name" name="name" maxLength={120} placeholder="Coupe, assemblage, finitions…" /></div>
        <div><label htmlFor="op-minutes" className="mb-1 block text-xs font-semibold">Durée (min) *</label><Input id="op-minutes" name="minutes" inputMode="decimal" placeholder="ex. 18" /></div>
        <SubmitButton pendingText="Ajout…"><Plus className="h-4 w-4" /> Ajouter</SubmitButton>
      </div>
    </form>
  )
}

function Costing({ bomId, versionId, hourlyRate, overheadPct, editable }: { bomId: string; versionId: string; hourlyRate: number; overheadPct: number; editable: boolean }) {
  const [state, action] = useActionState(saveCostingAction, null)
  return (
    <form action={action} className="space-y-3 border-t border-line p-4">
      <input type="hidden" name="bom_id" value={bomId} /><input type="hidden" name="version_id" value={versionId} />
      <p className="text-sm font-semibold">Paramètres de coût de la version</p>
      {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}
      {state?.ok && <p role="status" className="text-xs text-success-text">{state.message}</p>}
      <div className="grid gap-3 sm:grid-cols-[10rem_10rem_auto] sm:items-end">
        <div><label htmlFor="hourly_rate" className="mb-1 block text-xs font-semibold">Taux horaire (€ / h)</label><Input id="hourly_rate" name="hourly_rate" inputMode="decimal" defaultValue={dec(hourlyRate)} disabled={!editable} /></div>
        <div><label htmlFor="overhead_pct" className="mb-1 block text-xs font-semibold">Frais généraux (%)</label><Input id="overhead_pct" name="overhead_pct" inputMode="decimal" defaultValue={dec(overheadPct)} disabled={!editable} /></div>
        {editable && <SubmitButton variant="secondary" pendingText="Enregistrement…"><Save className="h-4 w-4" /> Enregistrer</SubmitButton>}
      </div>
      <p className="text-xs text-ink-soft">Les frais généraux s’appliquent à (matière + main-d’œuvre) du produit fini, une seule fois.</p>
    </form>
  )
}
