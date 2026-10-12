'use client'

import { useActionState, useEffect, useRef, useState } from 'react'
import { Plus, Save } from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { FormField } from '@/components/auth/form-field'
import { SubmitButton } from '@/components/auth/submit-button'
import { formatQty, unitLabel } from '@/lib/bom/options'
import { cn } from '@/lib/utils'
import { useManualAction } from '@/lib/use-manual-action'
import { addInventoryLineAction, countLineAction, createInventoryAction } from '../actions'
import type { InventoryLine, Location, WarehouseWithLocations } from '../types'

export function NewInventory({ warehouses }: { warehouses: WarehouseWithLocations[] }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> Nouvel inventaire</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Nouvel inventaire">
        <NewInventoryForm warehouses={warehouses.filter((w) => !w.archived_at)} onCancel={() => setOpen(false)} />
      </Dialog>
    </>
  )
}
function NewInventoryForm({ warehouses, onCancel }: { warehouses: WarehouseWithLocations[]; onCancel: () => void }) {
  const [state, action, pending] = useManualAction(createInventoryAction, null)
  const [wh, setWh] = useState(warehouses[0]?.id ?? '')
  const locs = (warehouses.find((w) => w.id === wh)?.locations ?? []).filter((l) => !l.archived_at)
  return (
    <form onSubmit={action} className="space-y-3">
      {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}
      <FormField id="inv-wh" label="Entrepôt *"><Select id="inv-wh" name="warehouse_id" value={wh} onChange={(e) => setWh(e.target.value)}>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}</Select></FormField>
      <FormField id="inv-loc" label="Périmètre" hint="Un seul inventaire ouvert à la fois par périmètre."><Select id="inv-loc" name="location_id" key={wh} defaultValue=""><option value="">Tout l’entrepôt</option>{locs.map((l) => <option key={l.id} value={l.id}>{l.code}</option>)}</Select></FormField>
      <FormField id="inv-note" label="Note"><Input id="inv-note" name="note" maxLength={300} placeholder="Inventaire de fin de mois" /></FormField>
      <p className="text-xs text-ink-soft">Les quantités théoriques actuelles sont figées ; vous saisissez ensuite les quantités comptées. Les écarts sont appliqués à la validation.</p>
      <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onCancel}>Annuler</Button><SubmitButton disabled={pending}>{pending ? 'Création…' : 'Créer l’inventaire'}</SubmitButton></div>
    </form>
  )
}

export function CountTable({ lines, editable }: { lines: InventoryLine[]; editable: boolean }) {
  return (
    <div className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
      <table className="w-full min-w-[40rem] text-sm">
        <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft">
          <tr><th className="px-4 py-2 font-semibold">Composant</th><th className="px-2 py-2 font-semibold">Emplacement</th><th className="px-2 py-2 text-right font-semibold">Théorique</th><th className="w-40 px-2 py-2 font-semibold">Compté</th><th className="px-2 py-2 text-right font-semibold">Écart</th><th className="w-12 px-4 py-2" /></tr>
        </thead>
        <tbody className="divide-y divide-line">
          {lines.length === 0 && <tr><td colSpan={6} className="p-6 text-center text-ink-soft">Aucune ligne : ajoutez les composants à compter.</td></tr>}
          {lines.map((l) => <CountRow key={l.id} line={l} editable={editable} />)}
        </tbody>
      </table>
    </div>
  )
}
function CountRow({ line, editable }: { line: InventoryLine; editable: boolean }) {
  const [state, action] = useActionState(countLineAction, null)
  const [val, setVal] = useState(line.counted_qty === null ? '' : String(line.counted_qty).replace('.', ','))
  const parsed = val.trim() === '' ? null : Number(val.replace(',', '.'))
  const delta = line.applied_delta ?? (parsed !== null && Number.isFinite(parsed) ? parsed - line.system_qty : null)
  const formId = `cnt-${line.id}`
  return (
    <tr>
      <td className="px-4 py-2"><span className="font-medium">{line.material_name}</span><span className="ml-2 font-mono text-xs text-ink-faint">{line.material_code}</span></td>
      <td className="px-2 py-2 font-mono text-xs">{line.location_code}</td>
      <td className="px-2 py-2 text-right tabular-nums">{formatQty(line.system_qty)} {unitLabel(line.unit)}</td>
      <td className="px-2 py-2">
        {editable ? (<><form id={formId} action={action}><input type="hidden" name="id" value={line.id} /></form>
          <Input form={formId} name="counted" inputMode="decimal" value={val} onChange={(e) => setVal(e.target.value)} aria-label={`Quantité comptée ${line.material_name}`} className="h-8 w-28" placeholder="—" />
          {state?.message && <p role={state.ok ? 'status' : 'alert'} className={cn('text-xs', state.ok ? 'text-success-text' : 'text-danger-text')}>{state.message}</p>}</>)
          : <span className="tabular-nums">{line.counted_qty === null ? '—' : formatQty(line.counted_qty)}</span>}
      </td>
      <td className={cn('px-2 py-2 text-right font-semibold tabular-nums', delta === null || delta === 0 ? 'text-ink-soft' : delta > 0 ? 'text-success-text' : 'text-danger-text')}>{delta === null ? '—' : `${delta > 0 ? '+' : ''}${formatQty(delta)}`}</td>
      <td className="px-4 py-2 text-right">{editable && <Button type="submit" form={formId} variant="ghost" size="sm" aria-label="Enregistrer le comptage" title="Enregistrer"><Save className="h-4 w-4" /></Button>}</td>
    </tr>
  )
}

export function AddLine({ inventoryId, materials, locations }: { inventoryId: string; materials: { id: string; code: string; name: string }[]; locations: Location[] }) {
  const [state, action] = useActionState(addInventoryLineAction, null)
  const ref = useRef<HTMLFormElement>(null)
  useEffect(() => { if (state?.ok) ref.current?.reset() }, [state])
  return (
    <form ref={ref} action={action} className="space-y-2 rounded-md border border-line bg-white p-4 shadow-card">
      <input type="hidden" name="inventory_id" value={inventoryId} />
      <p className="text-sm font-semibold">Ajouter un composant non listé</p>
      {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}
      <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto] sm:items-end">
        <Select name="material_id" aria-label="Composant" defaultValue=""><option value="">— Composant —</option>{materials.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.code})</option>)}</Select>
        <Select name="location_id" aria-label="Emplacement" defaultValue=""><option value="">— Emplacement —</option>{locations.filter((l) => !l.archived_at).map((l) => <option key={l.id} value={l.id}>{l.code}</option>)}</Select>
        <SubmitButton variant="secondary" pendingText="Ajout…"><Plus className="h-4 w-4" /> Ajouter</SubmitButton>
      </div>
    </form>
  )
}
