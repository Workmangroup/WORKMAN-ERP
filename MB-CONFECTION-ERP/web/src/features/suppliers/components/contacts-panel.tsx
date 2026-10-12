'use client'

import { useActionState, useEffect, useState } from 'react'
import { Mail, Pencil, Phone, Plus, Smartphone, Star, Trash2 } from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { FormField } from '@/components/auth/form-field'
import { SubmitButton } from '@/components/auth/submit-button'
import { LANGUAGES, label } from '@/lib/clients/options'
import { deleteSupplierContactAction, saveSupplierContactAction } from '../actions'
import type { SupplierContact } from '../types'

function ContactForm({ supplierId, contact, onDone }: { supplierId: string; contact?: SupplierContact; onDone: () => void }) {
  const [state, formAction] = useActionState(saveSupplierContactAction, null)
  const errs = state?.fieldErrors ?? {}
  const k = contact?.id ?? 'new'
  const v = (f: keyof SupplierContact) => state?.values?.[f] ?? (contact?.[f] === null || contact?.[f] === undefined ? '' : String(contact[f]))
  useEffect(() => { if (state?.ok) onDone() }, [state, onDone])

  return (
    <form action={formAction} className="space-y-4 rounded-md border border-brand-200 bg-brand-50/40 p-4" noValidate>
      <input type="hidden" name="supplier_id" value={supplierId} />
      {contact && <input type="hidden" name="id" value={contact.id} />}
      {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField id={`sc-name-${k}`} label="Nom complet *" errors={errs.full_name}><Input id={`sc-name-${k}`} name="full_name" required autoFocus defaultValue={v('full_name')} /></FormField>
        <FormField id={`sc-title-${k}`} label="Fonction" errors={errs.job_title}><Input id={`sc-title-${k}`} name="job_title" defaultValue={v('job_title')} /></FormField>
        <FormField id={`sc-mail-${k}`} label="E-mail" errors={errs.email}><Input id={`sc-mail-${k}`} name="email" type="email" defaultValue={v('email')} /></FormField>
        <FormField id={`sc-lang-${k}`} label="Langue" errors={errs.language}>
          <Select id={`sc-lang-${k}`} name="language" defaultValue={v('language')}>
            <option value="">—</option>
            {LANGUAGES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
          </Select>
        </FormField>
        <FormField id={`sc-phone-${k}`} label="Téléphone" errors={errs.phone}><Input id={`sc-phone-${k}`} name="phone" type="tel" defaultValue={v('phone')} /></FormField>
        <FormField id={`sc-mobile-${k}`} label="Mobile" errors={errs.mobile}><Input id={`sc-mobile-${k}`} name="mobile" type="tel" defaultValue={v('mobile')} /></FormField>
      </div>
      <FormField id={`sc-notes-${k}`} label="Notes" errors={errs.notes}><Textarea id={`sc-notes-${k}`} name="notes" rows={2} defaultValue={v('notes')} /></FormField>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox name="is_primary" defaultChecked={state?.values ? state.values.is_primary === 'on' : contact?.is_primary} /> Contact principal
      </label>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onDone}>Annuler</Button>
        <SubmitButton pendingText="Enregistrement…">{contact ? 'Enregistrer' : 'Ajouter le contact'}</SubmitButton>
      </div>
    </form>
  )
}

export function SupplierContactsPanel({ supplierId, contacts, canWrite, locked }: { supplierId: string; contacts: SupplierContact[]; canWrite: boolean; locked: boolean }) {
  const [mode, setMode] = useState<{ type: 'none' } | { type: 'new' } | { type: 'edit'; id: string }>({ type: 'none' })
  const close = () => setMode({ type: 'none' })
  const editable = canWrite && !locked
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-ink-soft">{contacts.length} contact(s)</p>
        {editable && mode.type === 'none' && <Button size="sm" onClick={() => setMode({ type: 'new' })}><Plus className="h-4 w-4" /> Ajouter un contact</Button>}
      </div>
      {mode.type === 'new' && <ContactForm supplierId={supplierId} onDone={close} />}
      <ul className="grid gap-3 md:grid-cols-2">
        {contacts.map((c) =>
          mode.type === 'edit' && mode.id === c.id ? (
            <li key={c.id} className="md:col-span-2"><ContactForm supplierId={supplierId} contact={c} onDone={close} /></li>
          ) : (
            <li key={c.id} className="rounded-md border border-line bg-white p-4 shadow-card">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 font-semibold">{c.full_name}{c.is_primary && <Badge tone="brand"><Star className="mr-1 h-3 w-3" /> Principal</Badge>}</p>
                  {c.job_title && <p className="text-sm text-ink-soft">{c.job_title}</p>}
                </div>
                {editable && (
                  <div className="flex shrink-0 gap-1">
                    <Button variant="ghost" size="sm" onClick={() => setMode({ type: 'edit', id: c.id })} aria-label={`Modifier ${c.full_name}`}><Pencil className="h-4 w-4" /></Button>
                    <form action={deleteSupplierContactAction} onSubmit={(e) => { if (!window.confirm(`Supprimer le contact « ${c.full_name} » ?`)) e.preventDefault() }}>
                      <input type="hidden" name="id" value={c.id} /><input type="hidden" name="supplier_id" value={supplierId} />
                      <Button variant="ghost" size="sm" type="submit" aria-label={`Supprimer ${c.full_name}`}><Trash2 className="h-4 w-4 text-danger-text" /></Button>
                    </form>
                  </div>
                )}
              </div>
              <dl className="mt-3 space-y-1.5 text-sm">
                {c.email && <div className="flex items-center gap-2"><Mail className="h-4 w-4 shrink-0 text-ink-faint" /><a className="truncate text-brand-700 hover:underline" href={`mailto:${c.email}`}>{c.email}</a></div>}
                {c.phone && <div className="flex items-center gap-2"><Phone className="h-4 w-4 shrink-0 text-ink-faint" /><a className="hover:underline" href={`tel:${c.phone}`}>{c.phone}</a></div>}
                {c.mobile && <div className="flex items-center gap-2"><Smartphone className="h-4 w-4 shrink-0 text-ink-faint" /><a className="hover:underline" href={`tel:${c.mobile}`}>{c.mobile}</a></div>}
                {c.language && <p className="text-xs text-ink-soft">Langue : {label(LANGUAGES, c.language)}</p>}
                {c.notes && <p className="text-xs text-ink-soft">{c.notes}</p>}
              </dl>
            </li>
          ),
        )}
        {contacts.length === 0 && mode.type !== 'new' && (
          <li className="rounded-md border border-dashed border-line-strong p-8 text-center text-sm text-ink-soft md:col-span-2">Aucun contact. {editable ? 'Ajoutez le commercial ou l’interlocuteur logistique.' : ''}</li>
        )}
      </ul>
    </div>
  )
}
