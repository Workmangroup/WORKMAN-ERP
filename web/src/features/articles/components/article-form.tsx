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
import { ARTICLE_STATUS, FAMILIES } from '@/lib/articles/options'
import { createArticleAction, updateArticleAction } from '../actions'
import type { Article } from '../types'

export function ArticleForm({
  article,
  clients,
  defaultClient,
  canActivate,
}: {
  article?: Article
  clients: { id: string; name: string; code: string }[]
  defaultClient?: string
  canActivate?: boolean
}) {
  const editing = Boolean(article)
  const [state, formAction] = useActionState(editing ? updateArticleAction : createArticleAction, null)
  const errs = state?.fieldErrors ?? {}
  const v = (k: string, fb: string | null | undefined = '') => state?.values?.[k] ?? fb ?? ''
  const inv = (k: string) => ({ 'aria-invalid': Boolean(errs[k]), 'aria-describedby': errs[k] ? `${k}-error` : undefined })

  return (
    <form action={formAction} className="space-y-4" noValidate>
      {article && <input type="hidden" name="id" value={article.id} />}
      {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}

      <section className="rounded-md border border-line bg-white shadow-card">
        <div className="border-b border-line px-5 py-3">
          <h2 className="text-base font-semibold">Identification</h2>
          <p className="text-xs text-ink-soft">Chaque client a ses propres références ; la référence interne MB est unique.</p>
        </div>
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <FormField id="client_id" label="Client *" errors={errs.client_id}>
            {editing ? (
              <>
                <Input id="client_id" value={clients.find((c) => c.id === article!.client_id)?.name ?? '—'} disabled readOnly />
                <input type="hidden" name="client_id" value={article!.client_id} />
              </>
            ) : (
              <Select id="client_id" name="client_id" required defaultValue={v('client_id', defaultClient)} {...inv('client_id')}>
                <option value="">— Choisir un client —</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.code})</option>)}
              </Select>
            )}
          </FormField>
          <FormField id="family" label="Famille *" errors={errs.family}>
            <Select id="family" name="family" required defaultValue={v('family', article?.family ?? 'jacket')} {...inv('family')}>
              {FAMILIES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </Select>
          </FormField>
          <FormField id="client_ref" label="Référence client *" errors={errs.client_ref} hint="Telle qu’indiquée par le client. Ex. LAF-HV-JKT-2027">
            <Input id="client_ref" name="client_ref" required className="font-mono uppercase" defaultValue={v('client_ref', article?.client_ref)} {...inv('client_ref')} />
          </FormField>
          <FormField id="internal_ref" label="Référence interne" errors={errors(errs, 'internal_ref')}
            hint={editing ? 'La référence interne ne peut plus être modifiée.' : 'Ex. JKT001. Laissez vide pour une numérotation automatique (ART0001…).'}>
            <Input id="internal_ref" name="internal_ref" className="font-mono uppercase" defaultValue={v('internal_ref', article?.internal_ref)} disabled={editing} {...inv('internal_ref')} />
          </FormField>
          <div className="sm:col-span-2">
            <FormField id="name" label="Désignation *" errors={errs.name}>
              <Input id="name" name="name" required defaultValue={v('name', article?.name)} placeholder="Veste haute visibilité classe 2" {...inv('name')} />
            </FormField>
          </div>
          <div className="sm:col-span-2">
            <FormField id="description" label="Description" errors={errs.description}>
              <Textarea id="description" name="description" rows={4} maxLength={2000} defaultValue={v('description', article?.description)} />
            </FormField>
          </div>
          {editing && (
            <FormField id="status" label="Statut" errors={errs.status}
              hint={canActivate ? 'Un article devient actif à la validation de sa première version.' : 'Le statut « Actif » nécessite une version validée.'}>
              <Select id="status" name="status" defaultValue={v('status', article!.status)}>
                {Object.entries(ARTICLE_STATUS).map(([k, s]) => <option key={k} value={k} disabled={k === 'active' && !article!.active_version_id}>{s.label}</option>)}
              </Select>
            </FormField>
          )}
        </div>
      </section>

      <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center justify-end gap-2 border-t border-line bg-canvas/95 px-1 py-3 backdrop-blur">
        <Link href={article ? `/articles/${article.id}` : '/articles'} className={buttonVariants({ variant: 'secondary' })}>Annuler</Link>
        <SubmitButton pendingText="Enregistrement…">{editing ? 'Enregistrer' : 'Créer l’article'}</SubmitButton>
      </div>
    </form>
  )
}

const errors = (e: Record<string, string[] | undefined>, k: string) => e[k]
