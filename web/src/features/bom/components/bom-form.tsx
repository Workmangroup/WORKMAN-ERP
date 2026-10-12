'use client'

import { useState } from 'react'
import { useManualAction } from '@/lib/use-manual-action'
import Link from 'next/link'
import { Alert } from '@/components/ui/alert'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { buttonVariants } from '@/components/ui/button'
import { FormField } from '@/components/auth/form-field'
import { SubmitButton } from '@/components/auth/submit-button'
import { BOM_KINDS } from '@/lib/bom/options'
import { createBomAction, updateBomAction } from '../actions'
import type { ArticleOption } from '../services/bom.service'
import type { Bom } from '../types'

export function BomForm({ bom, articles, defaultArticle, defaultKind }: { bom?: Bom; articles: ArticleOption[]; defaultArticle?: string; defaultKind?: string }) {
  const editing = Boolean(bom)
  const [state, formAction, pending] = useManualAction(editing ? updateBomAction : createBomAction, null)
  const errs = state?.fieldErrors ?? {}
  const v = (k: string, fb: string | null | undefined = '') => state?.values?.[k] ?? fb ?? ''
  const [kind, setKind] = useState<string>(() => v('kind', bom?.kind ?? (defaultKind === 'subassembly' ? 'subassembly' : 'product')))
  const sub = kind === 'subassembly'

  return (
    <form onSubmit={formAction} className="space-y-4" noValidate>
      {bom && <input type="hidden" name="id" value={bom.id} />}
      {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}

      <section className="rounded-md border border-line bg-white shadow-card">
        <div className="border-b border-line px-5 py-3">
          <h2 className="text-base font-semibold">Identification</h2>
          <p className="text-xs text-ink-soft">Le code BOM-xxxx est généré automatiquement. Après création, composez la nomenclature (composants, opérations) puis faites-la valider.</p>
        </div>
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <FormField id="name" label="Nom *" errors={errs.name}>
            <Input id="name" name="name" required maxLength={160} defaultValue={v('name', bom?.name)} placeholder="Veste HV classe 2" aria-invalid={Boolean(errs.name)} aria-describedby={errs.name ? 'name-error' : undefined} autoFocus />
          </FormField>
          <FormField id="kind" label="Type *" errors={errs.kind} hint={sub ? 'Un sous-ensemble (capuche, doublure…) s’insère dans d’autres nomenclatures.' : undefined}>
            {editing ? (
              <>
                <Input id="kind" value={BOM_KINDS.find((k) => k.value === bom!.kind)?.label ?? ''} disabled readOnly />
                <input type="hidden" name="kind" value={bom!.kind} />
              </>
            ) : (
              <Select id="kind" name="kind" value={kind} onChange={(e) => setKind(e.target.value)}>
                {BOM_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
              </Select>
            )}
          </FormField>
          {!sub && (
            <div className="sm:col-span-2">
              <FormField id="article_id" label="Article client" errors={errs.article_id} hint="Facultatif. Un article ne peut avoir qu’une nomenclature active ; la liste ne propose que les articles encore libres.">
                <Select id="article_id" name="article_id" defaultValue={v('article_id', bom?.article_id ?? defaultArticle)}>
                  <option value="">— Aucun (modèle) —</option>
                  {articles.map((a) => <option key={a.id} value={a.id}>{a.internal_ref} — {a.name} · {a.client_name} ({a.client_ref})</option>)}
                </Select>
              </FormField>
            </div>
          )}
          <div className="sm:col-span-2">
            <FormField id="description" label="Description" errors={errs.description}>
              <Textarea id="description" name="description" rows={3} maxLength={2000} defaultValue={v('description', bom?.description)} />
            </FormField>
          </div>
        </div>
      </section>

      <div className="flex justify-end gap-2">
        <Link href={bom ? `/bom/${bom.id}` : '/bom'} className={buttonVariants({ variant: 'secondary' })}>Annuler</Link>
        <SubmitButton disabled={pending}>{pending ? (editing ? 'Enregistrement…' : 'Création…') : editing ? 'Enregistrer' : 'Créer la nomenclature'}</SubmitButton>
      </div>
    </form>
  )
}
