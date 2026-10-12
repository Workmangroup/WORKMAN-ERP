'use client'

import { useActionState } from 'react'
import Link from 'next/link'
import { Alert } from '@/components/ui/alert'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { buttonVariants } from '@/components/ui/button'
import { FormField } from '@/components/auth/form-field'
import { SubmitButton } from '@/components/auth/submit-button'
import { CURRENCIES, INCOTERMS, LANGUAGES, PAYMENT_METHODS, countryOptions } from '@/lib/clients/options'
import { cn } from '@/lib/utils'
import { createClientAction, updateClientAction } from '../actions'
import type { Client, DirectoryUser, PaymentTerm } from '../types'

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

const span2 = 'sm:col-span-2'

/** Formulaire de création / modification d'un client (sections responsives). */
export function ClientForm({
  client,
  terms,
  reps,
  canSetCode,
}: {
  client?: Client
  terms: PaymentTerm[]
  reps: DirectoryUser[]
  canSetCode?: boolean
}) {
  const editing = Boolean(client)
  const [state, formAction] = useActionState(editing ? updateClientAction : createClientAction, null)
  const errs = state?.fieldErrors ?? {}
  const v = (k: string, fallback: string | number | null | undefined = '') => state?.values?.[k] ?? (fallback === null || fallback === undefined ? '' : String(fallback))
  const err = (k: string) => errs[k]
  const inv = (k: string) => ({ 'aria-invalid': Boolean(errs[k]), 'aria-describedby': errs[k] ? `${k}-error` : undefined })
  const countries = countryOptions()

  return (
    <form action={formAction} className="space-y-4" noValidate>
      {client && <input type="hidden" name="id" value={client.id} />}
      {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}

      <Section title="Informations générales" description="Identité du client telle qu’elle apparaîtra sur les documents.">
        <FormField id="name" label="Raison sociale *" errors={err('name')}>
          <Input id="name" name="name" required defaultValue={v('name', client?.name)} autoFocus={!editing} {...inv('name')} />
        </FormField>
        <FormField id="code" label="Code client" errors={err('code')} hint={editing ? 'Le code ne peut plus être modifié.' : 'Laissez vide pour une numérotation automatique (CLI-0001…).'}>
          <Input id="code" name="code" className="font-mono uppercase" defaultValue={v('code', client?.code)} disabled={editing || !canSetCode} placeholder="CLI-0001" {...inv('code')} />
        </FormField>
        <FormField id="legal_name" label="Dénomination légale" errors={err('legal_name')}>
          <Input id="legal_name" name="legal_name" defaultValue={v('legal_name', client?.legal_name)} {...inv('legal_name')} />
        </FormField>
        <FormField id="tax_id" label="Identifiant fiscal / n° TVA" errors={err('tax_id')}>
          <Input id="tax_id" name="tax_id" defaultValue={v('tax_id', client?.tax_id)} placeholder="FR12345678901" {...inv('tax_id')} />
        </FormField>
        <FormField id="registration_no" label="Registre du commerce" errors={err('registration_no')}>
          <Input id="registration_no" name="registration_no" defaultValue={v('registration_no', client?.registration_no)} {...inv('registration_no')} />
        </FormField>
        <FormField id="country" label="Pays *" errors={err('country')}>
          <Select id="country" name="country" required defaultValue={v('country', client?.country ?? 'FR')} {...inv('country')}>
            {countries.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </Select>
        </FormField>
        <FormField id="email" label="E-mail général" errors={err('email')}>
          <Input id="email" name="email" type="email" autoComplete="off" defaultValue={v('email', client?.email)} {...inv('email')} />
        </FormField>
        <FormField id="phone" label="Téléphone" errors={err('phone')}>
          <Input id="phone" name="phone" type="tel" defaultValue={v('phone', client?.phone)} {...inv('phone')} />
        </FormField>
        <FormField id="website" label="Site web" errors={err('website')}>
          <Input id="website" name="website" defaultValue={v('website', client?.website)} placeholder="www.exemple.com" {...inv('website')} />
        </FormField>
        <FormField id="language" label="Langue des documents" errors={err('language')}>
          <Select id="language" name="language" defaultValue={v('language', client?.language ?? 'fr')} {...inv('language')}>
            {LANGUAGES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
          </Select>
        </FormField>
      </Section>

      <Section title="Commercial et conditions" description="Devise, règlement et responsable du compte.">
        <FormField id="sales_rep_id" label="Commercial affecté" errors={err('sales_rep_id')}>
          <Select id="sales_rep_id" name="sales_rep_id" defaultValue={v('sales_rep_id', client?.sales_rep_id)} {...inv('sales_rep_id')}>
            <option value="">— Non affecté —</option>
            {reps.map((r) => <option key={r.id} value={r.id}>{r.full_name}</option>)}
          </Select>
        </FormField>
        <FormField id="currency" label="Devise *" errors={err('currency')}>
          <Select id="currency" name="currency" required defaultValue={v('currency', client?.currency ?? 'EUR')} {...inv('currency')}>
            {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
        </FormField>
        <FormField id="payment_terms_id" label="Conditions de paiement" errors={err('payment_terms_id')}>
          <Select id="payment_terms_id" name="payment_terms_id" defaultValue={v('payment_terms_id', client?.payment_terms_id)} {...inv('payment_terms_id')}>
            <option value="">— À définir —</option>
            {terms.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </Select>
        </FormField>
        <FormField id="payment_method" label="Mode de règlement" errors={err('payment_method')}>
          <Select id="payment_method" name="payment_method" defaultValue={v('payment_method', client?.payment_method)} {...inv('payment_method')}>
            <option value="">— À définir —</option>
            {PAYMENT_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </Select>
        </FormField>
        <FormField id="credit_limit" label="Plafond de crédit" errors={err('credit_limit')} hint="Dans la devise du client.">
          <Input id="credit_limit" name="credit_limit" inputMode="decimal" defaultValue={v('credit_limit', client?.credit_limit)} {...inv('credit_limit')} />
        </FormField>
        <FormField id="incoterm" label="Incoterm" errors={err('incoterm')}>
          <Select id="incoterm" name="incoterm" defaultValue={v('incoterm', client?.incoterm)} {...inv('incoterm')}>
            <option value="">— À définir —</option>
            {INCOTERMS.map((i) => <option key={i} value={i}>{i}</option>)}
          </Select>
        </FormField>
        <FormField id="delivery_tolerance_pct" label="Tolérance de livraison (%)" errors={err('delivery_tolerance_pct')}>
          <Input id="delivery_tolerance_pct" name="delivery_tolerance_pct" inputMode="decimal" defaultValue={v('delivery_tolerance_pct', client?.delivery_tolerance_pct ?? 5)} {...inv('delivery_tolerance_pct')} />
        </FormField>
        <FormField id="aql_level" label="Niveau AQL" errors={err('aql_level')} hint="Ex. 1.5, 2.5, 4.0">
          <Input id="aql_level" name="aql_level" defaultValue={v('aql_level', client?.aql_level)} {...inv('aql_level')} />
        </FormField>
        <label className={cn('flex items-center gap-2 text-sm', span2)}>
          <Checkbox name="vat_exempt" defaultChecked={state?.values ? state.values.vat_exempt === 'on' : client?.vat_exempt} />
          Client exonéré de TVA (export hors UE, autoliquidation…)
        </label>
      </Section>

      <Section title="Notes internes">
        <div className={span2}>
          <FormField id="notes" label="Notes" errors={err('notes')}>
            <Textarea id="notes" name="notes" rows={4} maxLength={2000} defaultValue={v('notes', client?.notes)} />
          </FormField>
        </div>
      </Section>

      <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center justify-end gap-2 border-t border-line bg-canvas/95 px-1 py-3 backdrop-blur">
        <Link href={client ? `/clients/${client.id}` : '/clients'} className={buttonVariants({ variant: 'secondary' })}>Annuler</Link>
        <SubmitButton pendingText="Enregistrement…">{editing ? 'Enregistrer les modifications' : 'Créer le client'}</SubmitButton>
      </div>
    </form>
  )
}
