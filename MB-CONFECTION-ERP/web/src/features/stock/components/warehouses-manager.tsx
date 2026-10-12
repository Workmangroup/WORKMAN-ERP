'use client'

import { useActionState, useEffect, useState } from 'react'
import { Archive, ArchiveRestore, MapPin, Pencil, Plus, Warehouse as WarehouseIcon } from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { FormField } from '@/components/auth/form-field'
import { SubmitButton } from '@/components/auth/submit-button'
import { LOCATION_KINDS } from '@/lib/stock/options'
import { archiveLocationAction, archiveWarehouseAction, saveLocationAction, saveWarehouseAction } from '../actions'
import type { WarehouseWithLocations } from '../types'
import { RpcButton } from './rpc-button'

type Dlg = null | { wh: WarehouseWithLocations | 'new' } | { loc: { warehouse: WarehouseWithLocations; edit?: WarehouseWithLocations['locations'][number] } }

export function WarehousesManager({ warehouses, canWrite }: { warehouses: WarehouseWithLocations[]; canWrite: boolean }) {
  const [dlg, setDlg] = useState<Dlg>(null)
  const close = () => setDlg(null)
  const title = !dlg ? '' : 'wh' in dlg ? (dlg.wh === 'new' ? 'Nouvel entrepôt' : `Modifier ${dlg.wh.code}`) : dlg.loc.edit ? `Modifier ${dlg.loc.edit.code}` : `Nouvel emplacement — ${dlg.loc.warehouse.code}`
  return (
    <div className="space-y-4">
      {canWrite && <div className="flex justify-end"><Button size="sm" onClick={() => setDlg({ wh: 'new' })}><Plus className="h-4 w-4" /> Nouvel entrepôt</Button></div>}
      {warehouses.length === 0 && <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">Aucun entrepôt. Créez le premier pour enregistrer du stock.</p>}
      {warehouses.map((w) => (
        <section key={w.id} className={`rounded-md border border-line bg-white shadow-card ${w.archived_at ? 'opacity-70' : ''}`}>
          <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3">
            <WarehouseIcon className="h-5 w-5 text-brand-600" aria-hidden />
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-semibold"><span className="mr-2 font-mono text-sm text-brand-700">{w.code}</span>{w.name}{w.archived_at && <Badge className="ml-2">Archivé</Badge>}</h2>
              <p className="text-xs text-ink-soft">{[w.city, w.address].filter(Boolean).join(' · ') || 'Adresse non renseignée'}</p>
            </div>
            {canWrite && (
              <div className="flex flex-wrap items-start gap-1">
                {!w.archived_at && <Button variant="ghost" size="sm" onClick={() => setDlg({ wh: w })}><Pencil className="h-4 w-4" /> Modifier</Button>}
                {!w.archived_at && <Button variant="ghost" size="sm" onClick={() => setDlg({ loc: { warehouse: w } })}><MapPin className="h-4 w-4" /> Emplacement</Button>}
                <RpcButton action={archiveWarehouseAction} fields={{ id: w.id, archive: w.archived_at ? '0' : '1' }} variant="ghost" size="sm" confirm={w.archived_at ? undefined : `Archiver l’entrepôt ${w.code} ?`}>
                  {w.archived_at ? <><ArchiveRestore className="h-4 w-4" /> Restaurer</> : <><Archive className="h-4 w-4" /> Archiver</>}
                </RpcButton>
              </div>
            )}
          </div>
          <ul className="divide-y divide-line">
            {w.locations.map((l) => (
              <li key={l.id} className={`flex flex-wrap items-center gap-3 px-5 py-2 text-sm ${l.archived_at ? 'text-ink-faint' : ''}`}>
                <span className="w-24 font-mono text-xs font-semibold">{l.code}</span>
                <span className="min-w-0 flex-1 truncate">{l.name ?? '—'}</span>
                <Badge>{LOCATION_KINDS.find((k) => k.value === l.kind)?.label}</Badge>
                {l.archived_at ? <Badge>Archivé</Badge> : <span className="text-xs text-ink-soft">{l.on_hand_lots} lot(s) en stock</span>}
                {canWrite && !w.archived_at && (
                  <span className="flex items-start gap-1">
                    {!l.archived_at && <Button variant="ghost" size="sm" aria-label={`Modifier ${l.code}`} onClick={() => setDlg({ loc: { warehouse: w, edit: l } })}><Pencil className="h-4 w-4" /></Button>}
                    <RpcButton action={archiveLocationAction} fields={{ id: l.id, archive: l.archived_at ? '0' : '1' }} variant="ghost" size="sm" aria-label={l.archived_at ? `Restaurer ${l.code}` : `Archiver ${l.code}`}>
                      {l.archived_at ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
                    </RpcButton>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}

      <Dialog open={dlg !== null} onClose={close} title={title}>
        {dlg && 'wh' in dlg && <WarehouseForm warehouse={dlg.wh === 'new' ? undefined : dlg.wh} onDone={close} />}
        {dlg && 'loc' in dlg && <LocationForm warehouse={dlg.loc.warehouse} edit={dlg.loc.edit} onDone={close} />}
      </Dialog>
    </div>
  )
}

function WarehouseForm({ warehouse, onDone }: { warehouse?: WarehouseWithLocations; onDone: () => void }) {
  const [state, action] = useActionState(saveWarehouseAction, null)
  useEffect(() => { if (state?.ok) onDone() }, [state, onDone])
  const errs = state?.fieldErrors ?? {}
  const v = (k: string, fb: string | null | undefined = '') => state?.values?.[k] ?? fb ?? ''
  return (
    <form action={action} className="space-y-3" noValidate>
      {warehouse && <input type="hidden" name="id" value={warehouse.id} />}
      {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}
      <FormField id="w-name" label="Nom *" errors={errs.name}><Input id="w-name" name="name" maxLength={120} defaultValue={v('name', warehouse?.name)} placeholder="Magasin principal" autoFocus aria-invalid={Boolean(errs.name)} /></FormField>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField id="w-city" label="Ville" errors={errs.city}><Input id="w-city" name="city" maxLength={80} defaultValue={v('city', warehouse?.city)} /></FormField>
        <FormField id="w-addr" label="Adresse" errors={errs.address}><Input id="w-addr" name="address" maxLength={200} defaultValue={v('address', warehouse?.address)} /></FormField>
      </div>
      {!warehouse && <p className="text-xs text-ink-soft">Le code WH-xx est généré. Un emplacement général « GEN » est créé automatiquement.</p>}
      <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onDone}>Annuler</Button><SubmitButton pendingText="Enregistrement…">{warehouse ? 'Enregistrer' : 'Créer'}</SubmitButton></div>
    </form>
  )
}

function LocationForm({ warehouse, edit, onDone }: { warehouse: WarehouseWithLocations; edit?: WarehouseWithLocations['locations'][number]; onDone: () => void }) {
  const [state, action] = useActionState(saveLocationAction, null)
  useEffect(() => { if (state?.ok) onDone() }, [state, onDone])
  const errs = state?.fieldErrors ?? {}
  const v = (k: string, fb: string | null | undefined = '') => state?.values?.[k] ?? fb ?? ''
  return (
    <form action={action} className="space-y-3" noValidate>
      <input type="hidden" name="warehouse_id" value={warehouse.id} />
      {edit && <input type="hidden" name="id" value={edit.id} />}
      {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField id="l-code" label="Code *" errors={errs.code} hint="Ex. A-01-02 (lettres, chiffres, . _ -).">
          {edit ? <><Input id="l-code" value={edit.code} disabled readOnly /><input type="hidden" name="code" value={edit.code} /></> : <Input id="l-code" name="code" maxLength={30} defaultValue={v('code')} autoFocus aria-invalid={Boolean(errs.code)} />}
        </FormField>
        <FormField id="l-kind" label="Type *" errors={errs.kind}><Select id="l-kind" name="kind" defaultValue={v('kind', edit?.kind ?? 'storage')}>{LOCATION_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</Select></FormField>
      </div>
      <FormField id="l-name" label="Désignation" errors={errs.name}><Input id="l-name" name="name" maxLength={80} defaultValue={v('name', edit?.name)} placeholder="Allée A, rayon 1" /></FormField>
      <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onDone}>Annuler</Button><SubmitButton pendingText="Enregistrement…">{edit ? 'Enregistrer' : 'Créer'}</SubmitButton></div>
    </form>
  )
}
