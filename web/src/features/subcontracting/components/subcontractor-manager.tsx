'use client'

import { useActionState } from 'react'
import { Pencil, Plus } from 'lucide-react'
import { ActionDialog } from '@/components/common/action-dialog'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { FormField } from '@/components/auth/form-field'
import { SERVICES, COUNTRIES, serviceLabel } from '@/lib/subcontracting/options'
import { cn } from '@/lib/utils'
import { saveSubcontractorAction, toggleSubcontractorAction } from '../actions'
import type { SubRow } from '../services/subcontracting.service'

function SubFields({ st, s }: { st: { fieldErrors?: Record<string, string[] | undefined>; values?: Record<string, string> } | null; s?: SubRow }) {
  const e = st?.fieldErrors ?? {}
  const v = (k: string, fb: string | number | null | undefined = '') => st?.values?.[k] ?? (fb === null || fb === undefined ? '' : String(fb))
  const id = s?.id ?? 'new'
  const chosen = s?.services ?? []
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="sm:col-span-2"><FormField id={`sb-name-${id}`} label="Nom *" errors={e.name}><Input id={`sb-name-${id}`} name="name" maxLength={120} defaultValue={v('name', s?.name)} placeholder="Broderie Atelier Sfax" /></FormField></div>
      <fieldset className="sm:col-span-2">
        <legend className="mb-1 text-sm font-semibold">Prestations proposées *</legend>
        {e.services && <p className="mb-1 text-xs text-danger-text">{e.services[0]}</p>}
        <div className="grid grid-cols-2 gap-1.5 rounded-md border border-line p-2 sm:grid-cols-3">
          {SERVICES.map((sv) => (
            <label key={sv.value} className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-1 text-sm hover:bg-canvas">
              <Checkbox name="services" value={sv.value} defaultChecked={chosen.includes(sv.value)} />{sv.label}
            </label>
          ))}
        </div>
      </fieldset>
      <FormField id={`sb-country-${id}`} label="Pays" errors={e.country}><Select id={`sb-country-${id}`} name="country" defaultValue={v('country', s?.country ?? 'TN')}><option value="">—</option>{COUNTRIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</Select></FormField>
      <FormField id={`sb-city-${id}`} label="Ville" errors={e.city}><Input id={`sb-city-${id}`} name="city" maxLength={80} defaultValue={v('city', s?.city)} /></FormField>
      <FormField id={`sb-contact-${id}`} label="Contact" errors={e.contact_name}><Input id={`sb-contact-${id}`} name="contact_name" maxLength={120} defaultValue={v('contact_name', s?.contact_name)} /></FormField>
      <FormField id={`sb-email-${id}`} label="E-mail" errors={e.email}><Input id={`sb-email-${id}`} name="email" type="email" maxLength={120} defaultValue={v('email', s?.email)} /></FormField>
      <FormField id={`sb-phone-${id}`} label="Téléphone" errors={e.phone}><Input id={`sb-phone-${id}`} name="phone" maxLength={40} defaultValue={v('phone', s?.phone)} /></FormField>
      <FormField id={`sb-lead-${id}`} label="Délai habituel (jours)" errors={e.default_lead_days}><Input id={`sb-lead-${id}`} name="default_lead_days" inputMode="numeric" defaultValue={v('default_lead_days', s?.default_lead_days ?? 14)} /></FormField>
      <div className="sm:col-span-2"><FormField id={`sb-notes-${id}`} label="Notes" errors={e.notes}><Textarea id={`sb-notes-${id}`} name="notes" rows={2} maxLength={2000} defaultValue={v('notes', s?.notes)} /></FormField></div>
    </div>
  )
}

/** Répertoire des sous-traitants : création, modification, activation / désactivation. */
export function SubcontractorManager({ subs, canWrite }: { subs: SubRow[]; canWrite: boolean }) {
  const [t, tAction] = useActionState(toggleSubcontractorAction, null)
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-soft">{subs.filter((s) => s.active).length} sous-traitant(s) actif(s). Un sous-traitant désactivé ne reçoit plus de nouvelles commandes.</p>
        {canWrite && <ActionDialog trigger={<><Plus className="h-4 w-4" /> Nouveau sous-traitant</>} triggerVariant="primary" title="Nouveau sous-traitant" action={saveSubcontractorAction} submit="Créer" wide>{(st) => <SubFields st={st} />}</ActionDialog>}
      </div>
      {t && !t.ok && <Alert tone="error">{t.message}</Alert>}
      {subs.length === 0 ? <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">Aucun sous-traitant. Ajoutez votre atelier de broderie, de sérigraphie ou de lavage.</p> : (
        <div className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
          <table className="w-full min-w-[46rem] text-sm">
            <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Sous-traitant</th><th className="px-2 py-2 font-semibold">Prestations</th><th className="px-2 py-2 font-semibold">Lieu</th><th className="px-2 py-2 text-right font-semibold">Délai habituel</th><th className="px-2 py-2 font-semibold">Contact</th><th className="px-2 py-2 font-semibold">Statut</th>{canWrite && <th className="px-2 py-2" />}</tr></thead>
            <tbody className="divide-y divide-line">
              {subs.map((s) => (
                <tr key={s.id} className={cn(!s.active && 'text-ink-faint')}>
                  <td className="px-4 py-2"><span className="font-mono text-xs text-ink-soft">{s.code}</span><span className="block font-semibold">{s.name}</span></td>
                  <td className="px-2 py-2"><span className="flex flex-wrap gap-1">{s.services.map((x) => <Badge key={x} tone="brand">{serviceLabel(x)}</Badge>)}</span></td>
                  <td className="px-2 py-2">{[s.city, s.country].filter(Boolean).join(', ') || '—'}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{s.default_lead_days} j</td>
                  <td className="px-2 py-2 text-ink-soft">{s.contact_name ?? '—'}{s.email && <span className="block text-xs">{s.email}</span>}</td>
                  <td className="px-2 py-2"><Badge tone={s.active ? 'success' : 'neutral'}>{s.active ? 'Actif' : 'Désactivé'}</Badge></td>
                  {canWrite && (
                    <td className="px-2 py-2 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <ActionDialog trigger={<Pencil className="h-4 w-4" />} triggerVariant="ghost" triggerLabel={`Modifier ${s.name}`} title={`Modifier ${s.name}`} action={saveSubcontractorAction} hidden={{ id: s.id, active: s.active ? 'on' : 'off' }} submit="Enregistrer" wide>
                          {(st) => <SubFields st={st} s={s} />}
                        </ActionDialog>
                        <form action={tAction}><input type="hidden" name="id" value={s.id} /><input type="hidden" name="active" value={String(!s.active)} /><Button type="submit" variant="ghost" size="sm">{s.active ? 'Désactiver' : 'Réactiver'}</Button></form>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

