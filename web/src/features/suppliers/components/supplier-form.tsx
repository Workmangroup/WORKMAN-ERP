'use client'

import { useActionState } from 'react'
import Link from 'next/link'
import { Alert } from '@/components/ui/alert'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { buttonVariants } from '@/components/ui/button'
import { FormField } from '@/components/auth/form-field'
import { SubmitButton } from '@/components/auth/submit-button'
import { CURRENCIES, INCOTERMS, LANGUAGES, PAYMENT_METHODS, countryOptions } from '@/lib/clients/options'
import { QUALIFICATIONS, SUPPLIER_CATEGORIES } from '@/lib/suppliers/options'
import type { PaymentTerm } from '@/features/clients/types'
import { createSupplierAction, updateSupplierAction } from '../actions'
import type { Supplier } from '../types'

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-md border border-line bg-white shadow-card">
      <div className="border-b border-line px-5 py-3">
        <h2 className="text-base font-semibold">{title}</h2>
        {description && <p className="text-xs text-ink-soft">{description}</p>}
      </div>
      <div className="grid gap-4 p-5 sm:grid-cols-2">{children}</div>
    </section>
  )
}

export function SupplierForm({
  supplier,
  terms,
  buyers,
}: {
  supplier?: Supplier
  terms: PaymentTerm[]
  buyers: { id: string; full_name: string }[]
}) {
  const editing = Boolean(supplier)
  const [state, formAction] = useActionState(editing ? updateSupplierAction : createSupplierAction, null)
  const errs = state?.fieldErrors ?? {}
  const v = (k: string, fb: string | number | null | undefined = '') => state?.values?.[k] ?? (fb === null || fb === undefined ? '' : String(fb))
  const inv = (k: string) => ({ 'aria-invalid': Boolean(errs[k]), 'aria-describedby': errs[k] ? `${k}-error` : undefined })
  const s = supplier

  return (
    <form action={formAction} className="space-y-4" noValidate>
      {s && <input type="hidden" name="id" value={s.id} />}
      {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}

      <Section title="Informations fournisseur" description="Identité et coordonnées du fournisseur.">
        <FormField id="name" label="Raison sociale *" errors={errs.name}>
          <Input id="name" name="name" required autoFocus={!editing} defaultValue={v('name', s?.name)} {...inv('name')} />
        </FormField>
        <FormField id="code" label="Code fournisseur" errors={errs.code} hint={editing ? 'Le code ne peut plus être modifié.' : 'Vide = numérotation automatique (FOU-0001…).'}>
          <Input id="code" name="code" className="font-mono uppercase" defaultValue={v('code', s?.code)} disabled={editing} placeholder="FOU-0001" {...inv('code')} />
        </FormField>
        <FormField id="legal_name" label="Dénomination légale" errors={errs.legal_name}>
          <Input id="legal_name" name="legal_name" defaultValue={v('legal_name', s?.legal_name)} {...inv('legal_name')} />
        </FormField>
        <FormField id="category" label="Catégorie *" errors={errs.category}>
          <Select id="category" name="category" defaultValue={v('category', s?.category ?? 'fabric')} {...inv('category')}>
            {SUPPLIER_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </Select>
        </FormField>
        <FormField id="tax_id" label="Identifiant fiscal / n° TVA" errors={errs.tax_id}>
          <Input id="tax_id" name="tax_id" defaultValue={v('tax_id', s?.tax_id)} {...inv('tax_id')} />
        </FormField>
        <FormField id="registration_no" label="Registre du commerce" errors={errs.registration_no}>
          <Input id="registration_no" name="registration_no" defaultValue={v('registration_no', s?.registration_no)} {...inv('registration_no')} />
        </FormField>
        <FormField id="email" label="E-mail général" errors={errs.email}>
          <Input id="email" name="email" type="email" defaultValue={v('email', s?.email)} {...inv('email')} />
        </FormField>
        <FormField id="phone" label="Téléphone" errors={errs.phone}>
          <Input id="phone" name="phone" type="tel" defaultValue={v('phone', s?.phone)} {...inv('phone')} />
        </FormField>
        <FormField id="website" label="Site web" errors={errs.website}>
          <Input id="website" name="website" defaultValue={v('website', s?.website)} placeholder="www.exemple.com" {...inv('website')} />
        </FormField>
        <FormField id="language" label="Langue des échanges" errors={errs.language}>
          <Select id="language" name="language" defaultValue={v('language', s?.language ?? 'fr')} {...inv('language')}>
            {LANGUAGES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
          </Select>
        </FormField>
        <div className="sm:col-span-2"><FormField id="address_line1" label="Adresse" errors={errs.address_line1}>
          <Input id="address_line1" name="address_line1" defaultValue={v('address_line1', s?.address_line1)} {...inv('address_line1')} />
        </FormField></div>
        <div className="sm:col-span-2"><FormField id="address_line2" label="Complément d’adresse" errors={errs.address_line2}>
          <Input id="address_line2" name="address_line2" defaultValue={v('address_line2', s?.address_line2)} />
        </FormField></div>
        <FormField id="postal_code" label="Code postal" errors={errs.postal_code}>
          <Input id="postal_code" name="postal_code" defaultValue={v('postal_code', s?.postal_code)} />
        </FormField>
        <FormField id="city" label="Ville" errors={errs.city}>
          <Input id="city" name="city" defaultValue={v('city', s?.city)} />
        </FormField>
        <FormField id="region" label="Région" errors={errs.region}>
          <Input id="region" name="region" defaultValue={v('region', s?.region)} />
        </FormField>
        <FormField id="country" label="Pays *" errors={errs.country}>
          <Select id="country" name="country" required defaultValue={v('country', s?.country ?? 'TN')} {...inv('country')}>
            {countryOptions().map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </Select>
        </FormField>
      </Section>

      <Section title="Conditions d’achat" description="Paiement, délai de livraison et Incoterm par défaut.">
        <FormField id="currency" label="Devise *" errors={errs.currency}>
          <Select id="currency" name="currency" required defaultValue={v('currency', s?.currency ?? 'EUR')} {...inv('currency')}>
            {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
        </FormField>
        <FormField id="payment_terms_id" label="Conditions de paiement" errors={errs.payment_terms_id}>
          <Select id="payment_terms_id" name="payment_terms_id" defaultValue={v('payment_terms_id', s?.payment_terms_id)} {...inv('payment_terms_id')}>
            <option value="">— À définir —</option>
            {terms.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </Select>
        </FormField>
        <FormField id="payment_method" label="Mode de règlement" errors={errs.payment_method}>
          <Select id="payment_method" name="payment_method" defaultValue={v('payment_method', s?.payment_method)} {...inv('payment_method')}>
            <option value="">— À définir —</option>
            {PAYMENT_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </Select>
        </FormField>
        <FormField id="lead_time_days" label="Délai de livraison (jours)" errors={errs.lead_time_days} hint="Délai standard annoncé, comparé au délai réel dans les statistiques.">
          <Input id="lead_time_days" name="lead_time_days" inputMode="numeric" defaultValue={v('lead_time_days', s?.lead_time_days)} {...inv('lead_time_days')} />
        </FormField>
        <FormField id="incoterm" label="Incoterm" errors={errs.incoterm}>
          <Select id="incoterm" name="incoterm" defaultValue={v('incoterm', s?.incoterm)} {...inv('incoterm')}>
            <option value="">— À définir —</option>
            {INCOTERMS.map((i) => <option key={i} value={i}>{i}</option>)}
          </Select>
        </FormField>
        <FormField id="incoterm_place" label="Lieu de l’Incoterm" errors={errs.incoterm_place} hint="Ex. Prato, Port de Radès…">
          <Input id="incoterm_place" name="incoterm_place" defaultValue={v('incoterm_place', s?.incoterm_place)} />
        </FormField>
        <FormField id="min_order_amount" label="Minimum de commande" errors={errs.min_order_amount} hint="Dans la devise du fournisseur.">
          <Input id="min_order_amount" name="min_order_amount" inputMode="decimal" defaultValue={v('min_order_amount', s?.min_order_amount)} {...inv('min_order_amount')} />
        </FormField>
        <FormField id="buyer_id" label="Acheteur référent" errors={errs.buyer_id}>
          <Select id="buyer_id" name="buyer_id" defaultValue={v('buyer_id', s?.buyer_id)} {...inv('buyer_id')}>
            <option value="">— Non affecté —</option>
            {buyers.map((b) => <option key={b.id} value={b.id}>{b.full_name}</option>)}
          </Select>
        </FormField>
      </Section>

      <Section title="Qualification" description="Suivi de l’agrément fournisseur.">
        <FormField id="qualification" label="Statut" errors={errs.qualification}>
          <Select id="qualification" name="qualification" defaultValue={v('qualification', s?.qualification ?? 'pending')} {...inv('qualification')}>
            {QUALIFICATIONS.map((q) => <option key={q.value} value={q.value}>{q.label}</option>)}
          </Select>
        </FormField>
        <FormField id="rating" label="Note (1 à 5)" errors={errs.rating}>
          <Input id="rating" name="rating" inputMode="numeric" defaultValue={v('rating', s?.rating)} {...inv('rating')} />
        </FormField>
        <div className="sm:col-span-2"><FormField id="notes" label="Notes internes" errors={errs.notes}>
          <Textarea id="notes" name="notes" rows={4} maxLength={2000} defaultValue={v('notes', s?.notes)} />
        </FormField></div>
      </Section>

      <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center justify-end gap-2 border-t border-line bg-canvas/95 px-1 py-3 backdrop-blur">
        <Link href={s ? `/suppliers/${s.id}` : '/suppliers'} className={buttonVariants({ variant: 'secondary' })}>Annuler</Link>
        <SubmitButton pendingText="Enregistrement…">{editing ? 'Enregistrer les modifications' : 'Créer le fournisseur'}</SubmitButton>
      </div>
    </form>
  )
}
