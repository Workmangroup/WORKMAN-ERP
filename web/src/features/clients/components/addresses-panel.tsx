'use client'

import { useActionState, useEffect, useState } from 'react'
import { MapPin, Pencil, Plus, Trash2 } from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { FormField } from '@/components/auth/form-field'
import { SubmitButton } from '@/components/auth/submit-button'
import { ADDRESS_TYPES, countryName, countryOptions, flag, label } from '@/lib/clients/options'
import { deleteAddressAction, saveAddressAction } from '../actions'
import type { ClientAddress } from '../types'

function AddressForm({ clientId, address, defaultCountry, onDone }: { clientId: string; address?: ClientAddress; defaultCountry: string; onDone: () => void }) {
  const [state, formAction] = useActionState(saveAddressAction, null)
  const errs = state?.fieldErrors ?? {}
  const key = address?.id ?? 'new'
  const v = (k: keyof ClientAddress, fb = '') => state?.values?.[k] ?? (address?.[k] === null || address?.[k] === undefined ? fb : String(address[k]))

  useEffect(() => {
    if (state?.ok) onDone()
  }, [state, onDone])

  return (
    <form action={formAction} className="space-y-4 rounded-md border border-brand-200 bg-brand-50/40 p-4" noValidate>
      <input type="hidden" name="client_id" value={clientId} />
      {address && <input type="hidden" name="id" value={address.id} />}
      {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField id={`a-type-${key}`} label="Type *" errors={errs.type}>
          <Select id={`a-type-${key}`} name="type" defaultValue={v('type', 'billing')}>
            {ADDRESS_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </Select>
        </FormField>
        <FormField id={`a-label-${key}`} label="Libellé" errors={errs.label}>
          <Input id={`a-label-${key}`} name="label" defaultValue={v('label')} placeholder="Ex. Entrepôt Lille" />
        </FormField>
        <div className="sm:col-span-2">
          <FormField id={`a-line1-${key}`} label="Adresse *" errors={errs.line1}>
            <Input id={`a-line1-${key}`} name="line1" required autoFocus defaultValue={v('line1')} aria-invalid={Boolean(errs.line1)} />
          </FormField>
        </div>
        <div className="sm:col-span-2">
          <FormField id={`a-line2-${key}`} label="Complément" errors={errs.line2}>
            <Input id={`a-line2-${key}`} name="line2" defaultValue={v('line2')} />
          </FormField>
        </div>
        <FormField id={`a-zip-${key}`} label="Code postal" errors={errs.postal_code}>
          <Input id={`a-zip-${key}`} name="postal_code" defaultValue={v('postal_code')} />
        </FormField>
        <FormField id={`a-city-${key}`} label="Ville *" errors={errs.city}>
          <Input id={`a-city-${key}`} name="city" required defaultValue={v('city')} aria-invalid={Boolean(errs.city)} />
        </FormField>
        <FormField id={`a-region-${key}`} label="Région / État" errors={errs.region}>
          <Input id={`a-region-${key}`} name="region" defaultValue={v('region')} />
        </FormField>
        <FormField id={`a-country-${key}`} label="Pays *" errors={errs.country}>
          <Select id={`a-country-${key}`} name="country" defaultValue={v('country', defaultCountry)}>
            {countryOptions().map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </Select>
        </FormField>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox name="is_default" defaultChecked={state?.values ? state.values.is_default === 'on' : address?.is_default} /> Adresse par défaut pour ce type
      </label>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onDone}>Annuler</Button>
        <SubmitButton pendingText="Enregistrement…">{address ? 'Enregistrer' : 'Ajouter l’adresse'}</SubmitButton>
      </div>
    </form>
  )
}

export function AddressesPanel({
  clientId,
  addresses,
  defaultCountry,
  canWrite,
  locked,
}: {
  clientId: string
  addresses: ClientAddress[]
  defaultCountry: string
  canWrite: boolean
  locked: boolean
}) {
  const [mode, setMode] = useState<{ type: 'none' } | { type: 'new' } | { type: 'edit'; id: string }>({ type: 'none' })
  const close = () => setMode({ type: 'none' })
  const editable = canWrite && !locked

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-ink-soft">{addresses.length} adresse(s)</p>
        {editable && mode.type === 'none' && (
          <Button size="sm" onClick={() => setMode({ type: 'new' })}><Plus className="h-4 w-4" /> Ajouter une adresse</Button>
        )}
      </div>

      {mode.type === 'new' && <AddressForm clientId={clientId} defaultCountry={defaultCountry} onDone={close} />}

      <ul className="grid gap-3 md:grid-cols-2">
        {addresses.map((a) =>
          mode.type === 'edit' && mode.id === a.id ? (
            <li key={a.id} className="md:col-span-2"><AddressForm clientId={clientId} address={a} defaultCountry={defaultCountry} onDone={close} /></li>
          ) : (
            <li key={a.id} className="rounded-md border border-line bg-white p-4 shadow-card">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 font-semibold">
                    <MapPin className="h-4 w-4 text-ink-faint" aria-hidden />
                    {a.label || label(ADDRESS_TYPES, a.type)}
                    <Badge>{label(ADDRESS_TYPES, a.type)}</Badge>
                    {a.is_default && <Badge tone="brand">Par défaut</Badge>}
                  </p>
                </div>
                {editable && (
                  <div className="flex shrink-0 gap-1">
                    <Button variant="ghost" size="sm" onClick={() => setMode({ type: 'edit', id: a.id })} aria-label="Modifier l’adresse"><Pencil className="h-4 w-4" /></Button>
                    <form action={deleteAddressAction} onSubmit={(e) => { if (!window.confirm('Supprimer cette adresse ?')) e.preventDefault() }}>
                      <input type="hidden" name="id" value={a.id} />
                      <input type="hidden" name="client_id" value={clientId} />
                      <Button variant="ghost" size="sm" type="submit" aria-label="Supprimer l’adresse"><Trash2 className="h-4 w-4 text-danger-text" /></Button>
                    </form>
                  </div>
                )}
              </div>
              <address className="mt-3 text-sm not-italic leading-relaxed text-ink">
                {a.line1}<br />
                {a.line2 && <>{a.line2}<br /></>}
                {[a.postal_code, a.city].filter(Boolean).join(' ')}{a.region ? `, ${a.region}` : ''}<br />
                {flag(a.country)} {countryName(a.country)}
              </address>
            </li>
          ),
        )}
        {addresses.length === 0 && mode.type !== 'new' && (
          <li className="rounded-md border border-dashed border-line-strong p-8 text-center text-sm text-ink-soft md:col-span-2">
            Aucune adresse. {editable ? 'Ajoutez au moins l’adresse de facturation.' : ''}
          </li>
        )}
      </ul>
    </div>
  )
}
