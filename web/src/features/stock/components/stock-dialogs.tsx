'use client'

import { useActionState, useCallback, useEffect, useMemo, useState } from 'react'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { FormField } from '@/components/auth/form-field'
import { SubmitButton } from '@/components/auth/submit-button'
import { formatQty, unitLabel } from '@/lib/bom/options'
import { useManualAction } from '@/lib/use-manual-action'
import { moveAction, reserveAction, setSafetyAction } from '../actions'
import type { ReservationRow, WarehouseWithLocations } from '../types'

export interface StockContext {
  materials: { id: string; code: string; name: string; unit: string }[]
  warehouses: WarehouseWithLocations[]
  levels: Record<string, { on_hand: number; available: number }>
  reservations: ReservationRow[]
  canWrite: boolean
  canAdjust: boolean
  costs: boolean
}
type Kind = 'in' | 'out' | 'transfer' | 'adjustment' | 'reserve' | 'safety'
interface Preset { material_id?: string; warehouse_id?: string; qty?: number }

const TITLES: Record<Kind, string> = { in: 'Entrée de stock', out: 'Sortie de stock', transfer: 'Transfert', adjustment: 'Ajustement de stock', reserve: 'Réserver du stock', safety: 'Stock de sécurité' }

/** Hook : ouvre les boîtes de dialogue de mouvement / réservation / sécurité, avec présélection éventuelle. */
export function useStockDialogs(ctx: StockContext) {
  const [dlg, setDlg] = useState<null | { kind: Kind; preset: Preset }>(null)
  const open = useCallback((kind: Kind, preset: Preset = {}) => setDlg({ kind, preset }), [])
  const close = useCallback(() => setDlg(null), [])
  const element = (
    <Dialog open={dlg !== null} onClose={close} title={dlg ? TITLES[dlg.kind] : ''} className="max-w-xl">
      {dlg && (dlg.kind === 'reserve' ? <ReserveForm ctx={ctx} preset={dlg.preset} onDone={close} />
        : dlg.kind === 'safety' ? <SafetyForm ctx={ctx} preset={dlg.preset} onDone={close} />
        : <MovementForm ctx={ctx} kind={dlg.kind} preset={dlg.preset} onDone={close} />)}
    </Dialog>
  )
  return { open, element }
}

const SUBMIT = { in: 'Enregistrer l’entrée', out: 'Enregistrer la sortie', transfer: 'Enregistrer le transfert', adjustment: 'Enregistrer l’ajustement' } as const
const matLabel = (m: { code: string; name: string }) => `${m.name} (${m.code})`

function MaterialSelect({ ctx, value, onChange, error }: { ctx: StockContext; value: string; onChange: (v: string) => void; error?: string }) {
  return (
    <FormField id="material_id" label="Composant *" errors={error ? [error] : undefined}>
      <Select id="material_id" name="material_id" value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={Boolean(error)}>
        <option value="">— Choisir —</option>
        {ctx.materials.map((m) => <option key={m.id} value={m.id}>{matLabel(m)}</option>)}
      </Select>
    </FormField>
  )
}

function Level({ ctx, material, warehouse }: { ctx: StockContext; material: string; warehouse: string }) {
  const lv = ctx.levels[`${material}|${warehouse}`]
  const m = ctx.materials.find((x) => x.id === material)
  if (!material || !warehouse) return null
  return <p className="text-xs text-ink-soft">En stock : <strong>{formatQty(lv?.on_hand ?? 0)}</strong> · disponible : <strong>{formatQty(lv?.available ?? 0)}</strong> {unitLabel(m?.unit)}</p>
}

function MovementForm({ ctx, kind, preset, onDone }: { ctx: StockContext; kind: Exclude<Kind, 'reserve' | 'safety'>; preset: Preset; onDone: () => void }) {
  const [state, action, pending] = useManualAction(moveAction, null)
  useEffect(() => { if (state?.ok) onDone() }, [state, onDone])
  const errs = state?.fieldErrors ?? {}
  const v = (k: string, fb = '') => state?.values?.[k] ?? fb
  const [material, setMaterial] = useState(v('material_id', preset.material_id ?? ''))
  const [wh, setWh] = useState(v('warehouse_id', preset.warehouse_id ?? ctx.warehouses.find((w) => !w.archived_at)?.id ?? ''))
  const active = ctx.warehouses.filter((w) => !w.archived_at)
  const locs = useMemo(() => (active.find((w) => w.id === wh)?.locations ?? []).filter((l) => !l.archived_at), [active, wh])
  const allLocs = active.flatMap((w) => w.locations.filter((l) => !l.archived_at).map((l) => ({ id: l.id, label: `${w.code} / ${l.code}${l.name ? ` — ${l.name}` : ''}` })))
  const mat = ctx.materials.find((m) => m.id === material)
  const res = ctx.reservations.filter((r) => r.status === 'active' && r.material_id === material && r.warehouse_id === wh)

  return (
    <form onSubmit={action} className="space-y-3" noValidate>
      <input type="hidden" name="type" value={kind} />
      {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}
      <MaterialSelect ctx={ctx} value={material} onChange={setMaterial} error={errs.material_id?.[0]} />
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField id="warehouse_id" label="Entrepôt *" errors={errs.warehouse_id}>
          <Select id="warehouse_id" name="warehouse_id" value={wh} onChange={(e) => setWh(e.target.value)}>
            {active.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}
          </Select>
        </FormField>
        <FormField id="location_id" label={kind === 'in' ? 'Emplacement *' : kind === 'adjustment' ? 'Emplacement' : 'Emplacement source'} errors={errs.location_id}
          hint={kind === 'out' || kind === 'transfer' ? 'Vide = FIFO sur tout l’entrepôt.' : kind === 'adjustment' ? 'Obligatoire pour un ajustement positif.' : undefined}>
          <Select id="location_id" name="location_id" defaultValue={v('location_id', kind === 'in' ? locs[0]?.id : '')} key={`${wh}-${kind}`}>
            {kind !== 'in' && <option value="">{kind === 'adjustment' ? '— Aucun —' : 'Tous (FIFO)'}</option>}
            {locs.map((l) => <option key={l.id} value={l.id}>{l.code}{l.name ? ` — ${l.name}` : ''}</option>)}
          </Select>
        </FormField>
      </div>
      <Level ctx={ctx} material={material} warehouse={wh} />
      {kind === 'transfer' && (
        <FormField id="to_location_id" label="Emplacement de destination *" errors={errs.to_location_id} hint="Le lot garde sa date de réception : le transfert ne « rajeunit » pas le stock.">
          <Select id="to_location_id" name="to_location_id" defaultValue={v('to_location_id')}>
            <option value="">— Choisir —</option>
            {allLocs.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
          </Select>
        </FormField>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField id="qty" label={kind === 'adjustment' ? `Écart * ${mat ? `(${unitLabel(mat.unit)})` : ''}` : `Quantité * ${mat ? `(${unitLabel(mat.unit)})` : ''}`} errors={errs.qty}
          hint={kind === 'adjustment' ? '+ pour ajouter, − pour retirer (ex. −2,5).' : undefined}>
          <Input id="qty" name="qty" inputMode="decimal" defaultValue={v('qty', preset.qty ? String(preset.qty).replace('.', ',') : '')} placeholder={kind === 'adjustment' ? '−2,5' : '10'} aria-invalid={Boolean(errs.qty)} autoFocus />
        </FormField>
        {kind === 'in' && ctx.costs ? (
          <FormField id="unit_cost" label="Coût unitaire (€)" errors={errs.unit_cost} hint="Vide = prix du catalogue BOM.">
            <Input id="unit_cost" name="unit_cost" inputMode="decimal" defaultValue={v('unit_cost')} placeholder="8,50" />
          </FormField>
        ) : kind === 'out' && res.length > 0 ? (
          <FormField id="reservation_id" label="Réservation à consommer" hint="Sans réservation, seul le stock disponible peut sortir.">
            <Select id="reservation_id" name="reservation_id" defaultValue={v('reservation_id')}>
              <option value="">— Aucune —</option>
              {res.map((r) => <option key={r.id} value={r.id}>{r.reference} (reste {formatQty(r.qty - r.qty_consumed)})</option>)}
            </Select>
          </FormField>
        ) : <span />}
      </div>
      <FormField id="reference" label={kind === 'in' ? 'Référence (bon de livraison, lot fournisseur)' : kind === 'out' ? 'Référence (ordre de fabrication, commande)' : 'Référence'} errors={errs.reference}>
        <Input id="reference" name="reference" maxLength={120} defaultValue={v('reference')} />
      </FormField>
      <FormField id="reason" label={kind === 'adjustment' ? 'Motif *' : 'Commentaire'} errors={errs.reason}>
        {kind === 'adjustment' ? <Input id="reason" name="reason" maxLength={300} defaultValue={v('reason')} placeholder="Casse, rouleau retrouvé, erreur de saisie…" /> : <Textarea id="reason" name="reason" rows={2} maxLength={300} defaultValue={v('reason')} />}
      </FormField>
      <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onDone}>Annuler</Button><SubmitButton disabled={pending}>{pending ? 'Enregistrement…' : SUBMIT[kind]}</SubmitButton></div>
    </form>
  )
}

function ReserveForm({ ctx, preset, onDone }: { ctx: StockContext; preset: Preset; onDone: () => void }) {
  const [state, action, pending] = useManualAction(reserveAction, null)
  useEffect(() => { if (state?.ok) onDone() }, [state, onDone])
  const errs = state?.fieldErrors ?? {}
  const v = (k: string, fb = '') => state?.values?.[k] ?? fb
  const [material, setMaterial] = useState(v('material_id', preset.material_id ?? ''))
  const [wh, setWh] = useState(v('warehouse_id', preset.warehouse_id ?? ctx.warehouses.find((w) => !w.archived_at)?.id ?? ''))
  return (
    <form onSubmit={action} className="space-y-3" noValidate>
      {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}
      <MaterialSelect ctx={ctx} value={material} onChange={setMaterial} error={errs.material_id?.[0]} />
      <FormField id="warehouse_id" label="Entrepôt *" errors={errs.warehouse_id}>
        <Select id="warehouse_id" name="warehouse_id" value={wh} onChange={(e) => setWh(e.target.value)}>{ctx.warehouses.filter((w) => !w.archived_at).map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}</Select>
      </FormField>
      <Level ctx={ctx} material={material} warehouse={wh} />
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField id="qty" label="Quantité *" errors={errs.qty}><Input id="qty" name="qty" inputMode="decimal" defaultValue={v('qty')} aria-invalid={Boolean(errs.qty)} /></FormField>
        <FormField id="reference" label="Référence *" errors={errs.reference} hint="Ordre de fabrication, commande…"><Input id="reference" name="reference" maxLength={120} defaultValue={v('reference')} aria-invalid={Boolean(errs.reference)} /></FormField>
      </div>
      <FormField id="note" label="Note"><Input id="note" name="note" maxLength={300} defaultValue={v('note')} /></FormField>
      <p className="text-xs text-ink-soft">Une réservation bloque la quantité pour d’autres sorties sans la sortir physiquement du stock.</p>
      <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onDone}>Annuler</Button><SubmitButton disabled={pending}>{pending ? 'Réservation…' : 'Réserver'}</SubmitButton></div>
    </form>
  )
}

function SafetyForm({ ctx, preset, onDone }: { ctx: StockContext; preset: Preset; onDone: () => void }) {
  const [state, action] = useActionState(setSafetyAction, null)
  useEffect(() => { if (state?.ok) onDone() }, [state, onDone])
  const errs = state?.fieldErrors ?? {}
  const m = ctx.materials.find((x) => x.id === preset.material_id)
  const w = ctx.warehouses.find((x) => x.id === preset.warehouse_id)
  return (
    <form action={action} className="space-y-3" noValidate>
      <input type="hidden" name="material_id" value={preset.material_id ?? ''} /><input type="hidden" name="warehouse_id" value={preset.warehouse_id ?? ''} />
      {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}
      <p className="text-sm">{m ? matLabel(m) : ''} — {w ? `${w.code} ${w.name}` : ''}</p>
      <FormField id="qty" label={`Stock de sécurité (${unitLabel(m?.unit)}) *`} errors={errs.qty} hint="Une alerte s’affiche quand le disponible passe sous ce seuil.">
        <Input id="qty" name="qty" inputMode="decimal" defaultValue={String(preset.qty ?? 0).replace('.', ',')} autoFocus aria-invalid={Boolean(errs.qty)} />
      </FormField>
      <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onDone}>Annuler</Button><SubmitButton pendingText="Enregistrement…">Enregistrer</SubmitButton></div>
    </form>
  )
}
