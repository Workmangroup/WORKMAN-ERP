'use client'

import { useActionState } from 'react'
import { Alert } from '@/components/ui/alert'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { FormField } from '@/components/auth/form-field'
import { SubmitButton } from '@/components/auth/submit-button'
import { unitLabel } from '@/lib/bom/options'
import { createSourcingAction, openSourcingAction, requestAwardAction, submitOfferAction } from '../actions'
import type { SourcingLine } from '../services/sourcing.service'

const INCOTERMS = ['EXW', 'FCA', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP']

export function CreateSourcingForm({ materials }: { materials: { id: string; code: string; name: string; unit: string }[] }) {
  const [state, action] = useActionState(createSourcingAction, null)
  const errs = state?.fieldErrors ?? {}
  return (
    <form action={action} className="space-y-4" noValidate>
      {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}
      <section className="space-y-4 rounded-md border border-line bg-white p-5 shadow-card">
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField id="title" label="Intitulé *" errors={errs.title}><Input id="title" name="title" maxLength={160} /></FormField>
          <FormField id="needed_date" label="Besoin au plus tard le" errors={errs.needed_date}><Input id="needed_date" name="needed_date" type="date" /></FormField>
        </div>
        <div className="space-y-2">
          <p className="text-sm font-semibold">Composants et quantités à comparer</p>
          <p className="text-xs text-ink-soft">Toutes les offres porteront sur ces mêmes lignes et quantités : le comparatif est établi sur une base identique.</p>
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="grid gap-3 md:grid-cols-[minmax(0,2fr)_9rem]">
              <Select aria-label={`Composant ligne ${i + 1}`} name={`material_${i}`} defaultValue="">
                <option value="">— Aucun —</option>
                {materials.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.code})</option>)}
              </Select>
              <Input aria-label={`Quantité ligne ${i + 1}`} name={`qty_${i}`} inputMode="decimal" placeholder="Quantité" />
            </div>
          ))}
        </div>
      </section>
      <div className="flex justify-end"><SubmitButton pendingText="Création…">Créer la consultation</SubmitButton></div>
    </form>
  )
}

/** Ouverture : les pondérations sont saisies (aucune valeur par défaut) et doivent totaliser 100. */
export function OpenSourcingForm({ eventId }: { eventId: string }) {
  const [state, action] = useActionState(openSourcingAction, null)
  return (
    <form action={action} className="space-y-3" noValidate>
      <input type="hidden" name="event_id" value={eventId} />
      {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}
      {state?.ok && <Alert tone="success">{state.message}</Alert>}
      <div className="grid gap-3 md:grid-cols-[repeat(3,minmax(0,1fr))_auto] md:items-end">
        <FormField id="w-price" label="Poids prix *"><Input id="w-price" name="weight_price" inputMode="numeric" /></FormField>
        <FormField id="w-lead" label="Poids délai *"><Input id="w-lead" name="weight_lead" inputMode="numeric" /></FormField>
        <FormField id="w-quality" label="Poids qualité *" hint="Total des trois poids : 100."><Input id="w-quality" name="weight_quality" inputMode="numeric" /></FormField>
        <SubmitButton pendingText="Ouverture…">Ouvrir la consultation</SubmitButton>
      </div>
    </form>
  )
}

/** Saisie d'une offre : une version par envoi ; toutes les lignes de la consultation sont chiffrées. */
export function OfferForm({ eventId, suppliers, lines }: { eventId: string; suppliers: { id: string; name: string }[]; lines: SourcingLine[] }) {
  const [state, action] = useActionState(submitOfferAction, null)
  return (
    <form action={action} className="space-y-4" noValidate>
      <input type="hidden" name="event_id" value={eventId} />
      {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}
      {state?.ok && <Alert tone="success">{state.message}</Alert>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <FormField id="o-sup" label="Fournisseur *" hint="Qualifié uniquement.">
          <Select id="o-sup" name="supplier_id" defaultValue=""><option value="">— Choisir —</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
        </FormField>
        <FormField id="o-cur" label="Devise de l’offre *" hint="Ex. EUR, TND, USD (taux du jour requis)."><Input id="o-cur" name="currency" maxLength={3} /></FormField>
        <FormField id="o-inc" label="Incoterm"><Select id="o-inc" name="incoterm" defaultValue=""><option value="">— Non précisé —</option>{INCOTERMS.map((t) => <option key={t} value={t}>{t}</option>)}</Select></FormField>
        <FormField id="o-lead" label="Délai (jours) *"><Input id="o-lead" name="lead_time_days" inputMode="numeric" /></FormField>
        <FormField id="o-tr" label="Transport (devise de l’offre)"><Input id="o-tr" name="transport_amount" inputMode="decimal" placeholder="0" /></FormField>
        <FormField id="o-du" label="Droits et taxes (devise de l’offre)"><Input id="o-du" name="duties_amount" inputMode="decimal" placeholder="0" /></FormField>
        <FormField id="o-valid" label="Valable jusqu’au"><Input id="o-valid" name="valid_until" type="date" /></FormField>
        <FormField id="o-ref" label="Référence du document *" hint="Ex. numéro d’offre ou nom du fichier reçu."><Input id="o-ref" name="source_reference" maxLength={160} /></FormField>
        <FormField id="o-sha" label="Empreinte SHA-256 du document" hint="Facultatif : 64 caractères hexadécimaux."><Input id="o-sha" name="source_sha256" maxLength={64} /></FormField>
      </div>
      <div className="space-y-2">
        <p className="text-sm font-semibold">Prix unitaires (devise de l’offre)</p>
        {lines.map((l) => (
          <div key={l.id} className="grid gap-3 md:grid-cols-[minmax(0,2fr)_10rem] md:items-center">
            <span className="text-sm">{l.material_name} <span className="font-mono text-xs text-ink-faint">{l.material_code}</span> — {l.qty} {unitLabel(l.unit)}</span>
            <Input aria-label={`Prix unitaire ${l.material_code}`} name={`price_${l.id}`} inputMode="decimal" placeholder="Prix unitaire" />
          </div>
        ))}
      </div>
      <div className="flex justify-end"><SubmitButton pendingText="Enregistrement…">Enregistrer l’offre</SubmitButton></div>
    </form>
  )
}

/** Demande d'attribution : l'offre retenue (version courante) et un motif ; la décision reste humaine (approbateur distinct). */
export function AwardForm({ eventId, offers }: { eventId: string; offers: { version_id: string; supplier_name: string; version: number }[] }) {
  const [state, action] = useActionState(requestAwardAction, null)
  return (
    <form action={action} className="space-y-3" noValidate>
      <input type="hidden" name="event_id" value={eventId} />
      {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}
      {state?.ok && <Alert tone="success">{state.message}</Alert>}
      <FormField id="aw-ver" label="Offre retenue *">
        <Select id="aw-ver" name="version_id" defaultValue=""><option value="">— Choisir —</option>{offers.map((o) => <option key={o.version_id} value={o.version_id}>{o.supplier_name} — version {o.version}</option>)}</Select>
      </FormField>
      <FormField id="aw-rat" label="Motif de la sélection *" hint="20 caractères minimum. Un autre approbateur décide : vous ne pouvez pas valider votre propre demande.">
        <Textarea id="aw-rat" name="rationale" rows={3} maxLength={1000} />
      </FormField>
      <div className="flex justify-end"><SubmitButton pendingText="Envoi…">Demander l’attribution</SubmitButton></div>
    </form>
  )
}

