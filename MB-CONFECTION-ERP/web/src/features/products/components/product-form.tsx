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
import { FAMILIES } from '@/lib/products/options'
import { createProductAction, updateProductAction } from '../actions'
import type { Product } from '../types'

export function ProductForm({ product, clients, defaultClient, articles }: {
  product?: Product
  clients?: { id: string; name: string; code: string }[]
  defaultClient?: string
  articles?: { id: string; label: string }[]
}) {
  const editing = Boolean(product)
  const [state, formAction] = useActionState(editing ? updateProductAction : createProductAction, null)
  const errs = state?.fieldErrors ?? {}
  const v = (k: string, fb: string | null | undefined = '') => state?.values?.[k] ?? fb ?? ''
  return (
    <form action={formAction} className="space-y-4" noValidate>
      {product && <input type="hidden" name="id" value={product.id} />}
      {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}
      <section className="rounded-md border border-line bg-white shadow-card">
        <div className="border-b border-line px-5 py-3">
          <h2 className="text-base font-semibold">{editing ? `Produit ${product?.code}` : 'Nouveau produit'}</h2>
          <p className="text-xs text-ink-soft">{editing ? 'Le code et le client ne changent plus. La fiche technique se modifie dans une version (onglet Versions).' : 'Le code PRD-xxxx est généré. La version 1 (brouillon) de la fiche technique est créée automatiquement.'}</p>
        </div>
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          {!editing && (
            <FormField id="client_id" label="Client *" errors={errs.client_id}>
              <Select id="client_id" name="client_id" defaultValue={v('client_id', defaultClient)} aria-invalid={Boolean(errs.client_id)}>
                <option value="">— Choisir un client —</option>{clients?.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.code})</option>)}
              </Select>
            </FormField>
          )}
          <FormField id="name" label="Désignation *" errors={errs.name}><Input id="name" name="name" maxLength={160} defaultValue={v('name', product?.name)} placeholder="Veste haute visibilité classe 2" aria-invalid={Boolean(errs.name)} /></FormField>
          <FormField id="family" label="Famille *" errors={errs.family}>
            <Select id="family" name="family" defaultValue={v('family', product?.family ?? 'jacket')}>{FAMILIES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}</Select>
          </FormField>
          {editing && (
            <FormField id="article_id" label="Article client lié (donne accès à la nomenclature)" errors={errs.article_id}>
              <Select id="article_id" name="article_id" defaultValue={v('article_id', product?.article_id)}>
                <option value="">— Aucun —</option>{articles?.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
              </Select>
            </FormField>
          )}
          <div className="sm:col-span-2"><FormField id="description" label="Description" errors={errs.description}><Textarea id="description" name="description" rows={3} maxLength={2000} defaultValue={v('description', product?.description)} /></FormField></div>
        </div>
      </section>
      <div className="flex justify-end gap-2">
        <Link href={product ? `/products/${product.id}` : '/products'} className={buttonVariants({ variant: 'secondary' })}>Annuler</Link>
        <SubmitButton pendingText="Enregistrement…">{editing ? 'Enregistrer' : 'Créer le produit'}</SubmitButton>
      </div>
    </form>
  )
}
