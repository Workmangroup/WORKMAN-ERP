'use client'

import { ActionDialog } from '@/components/common/action-dialog'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { FormField } from '@/components/auth/form-field'
import { Textarea } from '@/components/ui/textarea'
import { BIN_KINDS, WAREHOUSE_KINDS, ZONE_TYPES } from '@/lib/warehouses/options'
import { createWarehouseAction, saveBinAction, saveZoneAction, updateWarehouseAction } from '../actions'
import type { BinRow, WarehouseRow, ZoneRow } from '../services/warehouses.service'

type St = { fieldErrors?: Record<string, string[] | undefined>; values?: Record<string, string> } | null

/** Champs d'un entrepôt (création et modification). */
function WhFields({ st, w }: { st: St; w?: WarehouseRow }) {
  const e = st?.fieldErrors ?? {}
  const v = (k: string, fb: string | null | undefined = '') => st?.values?.[k] ?? fb ?? ''
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="sm:col-span-2"><FormField id={`wh-name-${w?.id ?? 'new'}`} label="Nom *" errors={e.name}><Input id={`wh-name-${w?.id ?? 'new'}`} name="name" maxLength={120} defaultValue={v('name', w?.name)} placeholder="Entrepôt Tissus" /></FormField></div>
      <FormField id={`wh-kind-${w?.id ?? 'new'}`} label="Type *" errors={e.kind}><Select id={`wh-kind-${w?.id ?? 'new'}`} name="kind" defaultValue={v('kind', w?.kind ?? 'fabric')}>{WAREHOUSE_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</Select></FormField>
      <FormField id={`wh-city-${w?.id ?? 'new'}`} label="Ville" errors={e.city}><Input id={`wh-city-${w?.id ?? 'new'}`} name="city" maxLength={80} defaultValue={v('city', w?.city)} /></FormField>
      <div className="sm:col-span-2"><FormField id={`wh-addr-${w?.id ?? 'new'}`} label="Adresse" errors={e.address}><Textarea id={`wh-addr-${w?.id ?? 'new'}`} name="address" rows={2} maxLength={200} defaultValue={v('address', w?.address)} /></FormField></div>
    </div>
  )
}

export function NewWarehouseDialog() {
  return <ActionDialog trigger="Nouvel entrepôt" triggerVariant="primary" title="Nouvel entrepôt" action={createWarehouseAction} submit="Créer l’entrepôt"
    description="Vous en devenez le responsable. Un emplacement général est créé automatiquement.">{(st) => <WhFields st={st} />}</ActionDialog>
}

export function EditWarehouseDialog({ w }: { w: WarehouseRow }) {
  return <ActionDialog trigger="Modifier" triggerVariant="command" title="Modifier l’entrepôt" action={updateWarehouseAction} hidden={{ id: w.id }} submit="Enregistrer">{(st) => <WhFields st={st} w={w} />}</ActionDialog>
}

export function ZoneDialog({ warehouseId, z }: { warehouseId: string; z?: ZoneRow }) {
  return (
    <ActionDialog trigger={z ? 'Modifier' : 'Nouvelle zone'} triggerVariant={z ? 'ghost' : 'primary'} triggerSize="sm" title={z ? `Zone ${z.code}` : 'Nouvelle zone'} action={saveZoneAction} hidden={{ warehouse_id: warehouseId, ...(z ? { id: z.id } : {}) }} submit="Enregistrer"
      description={z ? 'Le code de zone ne change pas.' : 'Une zone regroupe des emplacements (zone de coupe, accessoires, quarantaine…).'}>
      {(st) => {
        const e = st?.fieldErrors ?? {}
        const v = (k: string, fb: string | null | undefined = '') => st?.values?.[k] ?? fb ?? ''
        return (
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField id={`zc-${z?.id ?? 'new'}`} label="Code *" errors={e.code}><Input id={`zc-${z?.id ?? 'new'}`} name="code" maxLength={20} disabled={Boolean(z)} defaultValue={v('code', z?.code)} placeholder="ZC" /></FormField>
            <FormField id={`zt-${z?.id ?? 'new'}`} label="Type" errors={e.zone_type}><Select id={`zt-${z?.id ?? 'new'}`} name="zone_type" defaultValue={v('zone_type', z?.zone_type ?? 'storage')}>{ZONE_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</Select></FormField>
            <div className="sm:col-span-2"><FormField id={`zn-${z?.id ?? 'new'}`} label="Nom *" errors={e.name}><Input id={`zn-${z?.id ?? 'new'}`} name="name" maxLength={80} defaultValue={v('name', z?.name)} placeholder="Zone de coupe" /></FormField></div>
            <div className="sm:col-span-2"><FormField id={`zo-${z?.id ?? 'new'}`} label="Notes" errors={e.notes}><Textarea id={`zo-${z?.id ?? 'new'}`} name="notes" rows={2} maxLength={300} defaultValue={v('notes', z?.notes)} /></FormField></div>
          </div>
        )
      }}
    </ActionDialog>
  )
}

export function BinDialog({ warehouseId, zones, b }: { warehouseId: string; zones: ZoneRow[]; b?: BinRow }) {
  return (
    <ActionDialog trigger={b ? 'Modifier' : 'Nouvel emplacement'} triggerVariant={b ? 'ghost' : 'primary'} triggerSize="sm" title={b ? `Emplacement ${b.code}` : 'Nouvel emplacement'} action={saveBinAction} hidden={{ warehouse_id: warehouseId, ...(b ? { id: b.id } : {}) }} submit="Enregistrer"
      description={b ? 'Le code d’emplacement ne change pas.' : 'Allée, rack ou zone de réception : c’est là que le stock est physiquement rangé.'}>
      {(st) => {
        const e = st?.fieldErrors ?? {}
        const v = (k: string, fb: string | null | undefined = '') => st?.values?.[k] ?? fb ?? ''
        const id = b?.id ?? 'new'
        return (
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField id={`bc-${id}`} label="Code *" errors={e.code}><Input id={`bc-${id}`} name="code" maxLength={30} disabled={Boolean(b)} defaultValue={v('code', b?.code)} placeholder="A-01" /></FormField>
            <FormField id={`bk-${id}`} label="Usage" errors={e.kind}><Select id={`bk-${id}`} name="kind" defaultValue={v('kind', b?.kind ?? 'storage')}>{BIN_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</Select></FormField>
            <FormField id={`bn-${id}`} label="Nom" errors={e.name}><Input id={`bn-${id}`} name="name" maxLength={80} defaultValue={v('name', b?.name)} placeholder="Allée A" /></FormField>
            <FormField id={`bz-${id}`} label="Zone" errors={e.zone_id}><Select id={`bz-${id}`} name="zone_id" defaultValue={v('zone_id', b?.zone_id)}><option value="">— Aucune —</option>{zones.filter((z) => !z.archived_at).map((z) => <option key={z.id} value={z.id}>{z.code} — {z.name}</option>)}</Select></FormField>
          </div>
        )
      }}
    </ActionDialog>
  )
}
