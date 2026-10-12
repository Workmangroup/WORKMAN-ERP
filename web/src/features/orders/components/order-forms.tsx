'use client'

import { useActionState } from 'react'
import Link from 'next/link'
import { Plus } from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { FormField } from '@/components/auth/form-field'
import { SubmitButton } from '@/components/auth/submit-button'
import { addOrderLineAction, createOrderAction } from '../actions'

const today = () => new Date().toISOString().slice(0, 10)

export function NewOrderForm({ clients }: { clients: { id: string; name: string; code: string }[] }) {
  const [state, action] = useActionState(createOrderAction, null)
  const errs = state?.fieldErrors ?? {}
  const v = (k: string, fb = '') => state?.values?.[k] ?? fb
  return (
    <form action={action} className="space-y-4" noValidate>
      {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}
      <section className="rounded-md border border-line bg-white shadow-card">
        <div className="border-b border-line px-5 py-3"><h2 className="text-base font-semibold">Commande client</h2><p className="text-xs text-ink-soft">Le code CMD-xxxx est généré. Ajoutez les lignes (article, quantité, date de livraison) puis confirmez : une commande confirmée alimente le MRP.</p></div>
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <FormField id="client_id" label="Client *" errors={errs.client_id}>
            <Select id="client_id" name="client_id" defaultValue={v('client_id')} aria-invalid={Boolean(errs.client_id)}><option value="">— Choisir un client —</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.code})</option>)}</Select>
          </FormField>
          <FormField id="client_ref" label="N° de commande du client" errors={errs.client_ref}><Input id="client_ref" name="client_ref" maxLength={60} defaultValue={v('client_ref')} placeholder="PO-LAF-2026-118" /></FormField>
          <FormField id="order_date" label="Date de commande *" errors={errs.order_date}><Input id="order_date" name="order_date" type="date" defaultValue={v('order_date', today())} /></FormField>
          <div className="sm:col-span-2"><FormField id="notes" label="Notes" errors={errs.notes}><Textarea id="notes" name="notes" rows={2} maxLength={1000} defaultValue={v('notes')} /></FormField></div>
        </div>
      </section>
      <div className="flex justify-end gap-2"><Link href="/orders" className={buttonVariants({ variant: 'secondary' })}>Annuler</Link><SubmitButton pendingText="Création…">Créer la commande</SubmitButton></div>
    </form>
  )
}

export function AddLineForm({ orderId, articles }: { orderId: string; articles: { id: string; ref: string; name: string }[] }) {
  const [state, action] = useActionState(addOrderLineAction, null)
  const errs = state?.fieldErrors ?? {}
  const v = (k: string) => state?.values?.[k] ?? ''
  return (
    <form action={action} className="space-y-3 border-t border-line bg-canvas/50 p-4" noValidate>
      <input type="hidden" name="order_id" value={orderId} />
      <p className="text-sm font-semibold">Ajouter une ligne</p>
      {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}
      <div className="grid gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1.5fr)_6rem_7rem_6rem_9rem] md:items-end">
        <FormField id="ol-article" label="Article du client" errors={errs.article_id}><Select id="ol-article" name="article_id" defaultValue={v('article_id')}><option value="">— Ligne libre —</option>{articles.map((a) => <option key={a.id} value={a.id}>{a.ref} — {a.name}</option>)}</Select></FormField>
        <FormField id="ol-desc" label="Désignation (ligne libre)" errors={errs.description}><Input id="ol-desc" name="description" maxLength={300} defaultValue={v('description')} placeholder="Transport, échantillon…" /></FormField>
        <FormField id="ol-qty" label="Quantité *" errors={errs.qty}><Input id="ol-qty" name="qty" inputMode="decimal" defaultValue={v('qty')} placeholder="120" /></FormField>
        <FormField id="ol-price" label="Prix unit. HT" errors={errs.unit_price}><Input id="ol-price" name="unit_price" inputMode="decimal" defaultValue={v('unit_price')} placeholder="0" /></FormField>
        <FormField id="ol-disc" label="Remise %" errors={errs.discount_pct}><Input id="ol-disc" name="discount_pct" inputMode="decimal" defaultValue={v('discount_pct')} placeholder="0" /></FormField>
        <FormField id="ol-due" label="Livraison *" errors={errs.due_date}><Input id="ol-due" name="due_date" type="date" defaultValue={v('due_date')} /></FormField>
      </div>
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
        <FormField id="ol-note" label="Note" errors={errs.note}><Input id="ol-note" name="note" maxLength={300} defaultValue={v('note')} /></FormField>
        <SubmitButton pendingText="Ajout…"><Plus className="h-4 w-4" /> Ajouter</SubmitButton>
      </div>
      {articles.length === 0 && <p className="text-xs text-warn-text">Ce client n’a aucun article actif : créez d’abord ses articles (menu Articles).</p>}
    </form>
  )
}
