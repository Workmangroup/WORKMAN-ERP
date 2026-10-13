'use client'

import { useActionState } from 'react'
import { Alert } from '@/components/ui/alert'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { FormField } from '@/components/auth/form-field'
import { SubmitButton } from '@/components/auth/submit-button'
import { defectUnitAction, receiveUnitAction } from '../units-actions'

export function ReceiveUnitForm({ materials, lots, warehouses, locations }: {
  materials: { id: string; name: string; family: string }[]; lots: { id: string; code: string; material_id: string }[]
  warehouses: { id: string; label: string }[]; locations: { id: string; warehouse_id: string; code: string }[]
}) {
  const [state, action] = useActionState(receiveUnitAction, null)
  return (
    <form action={action} className="grid gap-3 rounded-md border border-line bg-white p-4 shadow-card md:grid-cols-3" noValidate>
      {state && !state.ok && state.message && <div className="md:col-span-3"><Alert tone="error">{state.message}</Alert></div>}
      {state?.ok && <div className="md:col-span-3"><Alert tone="success">{state.message}</Alert></div>}
      <FormField id="ru-mat" label="Composant *"><Select id="ru-mat" name="material_id" defaultValue=""><option value="">— Choisir —</option>{materials.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.family})</option>)}</Select></FormField>
      <FormField id="ru-lot" label="Lot *"><Select id="ru-lot" name="lot_id" defaultValue=""><option value="">— Choisir —</option>{lots.map((l) => <option key={l.id} value={l.id}>{l.code}</option>)}</Select></FormField>
      <FormField id="ru-wh" label="Entrepôt *"><Select id="ru-wh" name="warehouse_id" defaultValue=""><option value="">— Choisir —</option>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}</Select></FormField>
      <FormField id="ru-loc" label="Emplacement *" hint="Emplacement de l’entrepôt choisi (vérifié en base)."><Select id="ru-loc" name="location_id" defaultValue=""><option value="">— Choisir —</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.code}</option>)}</Select></FormField>
      <FormField id="ru-len" label="Longueur (m) — tissu"><Input id="ru-len" name="length_m" inputMode="decimal" /></FormField>
      <FormField id="ru-wid" label="Largeur (cm)"><Input id="ru-wid" name="width_cm" inputMode="decimal" /></FormField>
      <FormField id="ru-dye" label="Bain de teinture"><Input id="ru-dye" name="dye_bath" maxLength={40} /></FormField>
      <FormField id="ru-ref" label="Référence (BL, OF)"><Input id="ru-ref" name="reference" maxLength={120} /></FormField>
      <div className="flex items-end md:col-span-2"><SubmitButton pendingText="Réception…">Recevoir l’unité</SubmitButton></div>
    </form>
  )
}

export function DefectUnitForm({ unitId, maxLength }: { unitId: string; maxLength: number }) {
  const [state, action] = useActionState(defectUnitAction, null)
  return (
    <form action={action} className="grid gap-2 md:grid-cols-[8rem_8rem_minmax(0,2fr)_8rem_auto] md:items-end" noValidate>
      <input type="hidden" name="unit_id" value={unitId} />
      {state && !state.ok && state.message && <div className="md:col-span-5"><Alert tone="error">{state.message}</Alert></div>}
      {state?.ok && <div className="md:col-span-5"><Alert tone="success">{state.message}</Alert></div>}
      <FormField id={`df-code-${unitId}`} label="Code défaut *"><Input id={`df-code-${unitId}`} name="code" maxLength={30} /></FormField>
      <FormField id={`df-sev-${unitId}`} label="Gravité *"><Select id={`df-sev-${unitId}`} name="severity" defaultValue="minor"><option value="minor">Mineur</option><option value="major">Majeur</option><option value="critical">Critique (quarantaine)</option></Select></FormField>
      <FormField id={`df-desc-${unitId}`} label="Description *"><Input id={`df-desc-${unitId}`} name="description" maxLength={300} /></FormField>
      <FormField id={`df-len-${unitId}`} label={`Longueur touchée (max ${maxLength})`}><Input id={`df-len-${unitId}`} name="length_affected_m" inputMode="decimal" /></FormField>
      <SubmitButton pendingText="Enregistrement…">Ajouter le défaut</SubmitButton>
    </form>
  )
}
