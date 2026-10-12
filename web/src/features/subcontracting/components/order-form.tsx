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
import { SERVICES, today } from '@/lib/subcontracting/options'
import { createOrderAction } from '../actions'

/** Nouvelle commande de sous-traitance (brouillon, envoyée ensuite depuis sa fiche). */
export function OrderForm({ subs, products }: { subs: { id: string; name: string; services: string[] }[]; products: { id: string; label: string }[] }) {
  const [state, action] = useActionState(createOrderAction, null)
  const errs = state?.fieldErrors ?? {}
  const v = (k: string, fb = '') => state?.values?.[k] ?? fb
  return (
    <form action={action} className="space-y-4" noValidate>
      {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}
      <section className="rounded-md border border-line bg-white shadow-card">
        <div className="border-b border-line px-5 py-3">
          <h2 className="text-base font-semibold">Commande de sous-traitance</h2>
          <p className="text-xs text-ink-soft">La commande démarre en brouillon. Elle est envoyée au sous-traitant depuis sa fiche, avec l’échéance de retour.</p>
        </div>
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <FormField id="subcontractor_id" label="Sous-traitant *" errors={errs.subcontractor_id}>
            <Select id="subcontractor_id" name="subcontractor_id" defaultValue={v('subcontractor_id')}><option value="">— Choisir —</option>{subs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
          </FormField>
          <FormField id="service" label="Prestation *" errors={errs.service}>
            <Select id="service" name="service" defaultValue={v('service', 'embroidery')}>{SERVICES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</Select>
          </FormField>
          <FormField id="product_id" label="Produit concerné" errors={errs.product_id}>
            <Select id="product_id" name="product_id" defaultValue={v('product_id')}><option value="">— Aucun —</option>{products.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</Select>
          </FormField>
          <FormField id="qty" label="Quantité (pièces) *" errors={errs.qty}><Input id="qty" name="qty" inputMode="numeric" defaultValue={v('qty')} placeholder="120" /></FormField>
          <div className="sm:col-span-2"><FormField id="description" label="Travail demandé *" errors={errs.description}><Input id="description" name="description" maxLength={300} defaultValue={v('description')} placeholder="Broderie logo poitrine gauche, fil 1 couleur" /></FormField></div>
          <FormField id="requested_on" label="Date de la demande *" errors={errs.requested_on}><Input id="requested_on" name="requested_on" type="date" defaultValue={v('requested_on', today())} /></FormField>
          <FormField id="due_date" label="Retour attendu le" errors={errs.due_date}><Input id="due_date" name="due_date" type="date" defaultValue={v('due_date')} /></FormField>
          <div className="sm:col-span-2"><FormField id="notes" label="Notes et consignes" errors={errs.notes}><Textarea id="notes" name="notes" rows={3} maxLength={2000} defaultValue={v('notes')} /></FormField></div>
        </div>
      </section>
      <div className="flex justify-end gap-2"><Link href="/subcontracting/orders" className={buttonVariants({ variant: 'secondary' })}>Annuler</Link><SubmitButton pendingText="Création…">Créer la commande</SubmitButton></div>
    </form>
  )
}
