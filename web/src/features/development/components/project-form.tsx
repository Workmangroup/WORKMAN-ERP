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
import { FAMILIES, PRIORITY } from '@/lib/development/options'
import { createProjectAction, updateProjectAction } from '../actions'
import type { DevProject } from '../types'

const today = () => new Date().toISOString().slice(0, 10)

export function ProjectForm({ project, clients, defaultClient, owners, products }: {
  project?: DevProject
  clients?: { id: string; name: string; code: string }[]
  defaultClient?: string
  owners: { id: string; name: string }[]
  products?: { id: string; label: string }[]
}) {
  const editing = Boolean(project)
  const [state, action] = useActionState(editing ? updateProjectAction : createProjectAction, null)
  const errs = state?.fieldErrors ?? {}
  const v = (k: string, fb: string | number | null | undefined = '') => state?.values?.[k] ?? (fb === null || fb === undefined ? '' : String(fb))
  return (
    <form action={action} className="space-y-4" noValidate>
      {project && <input type="hidden" name="id" value={project.id} />}
      {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}
      <section className="rounded-md border border-line bg-white shadow-card">
        <div className="border-b border-line px-5 py-3">
          <h2 className="text-base font-semibold">{editing ? `Projet ${project?.code}` : 'Nouveau projet de développement'}</h2>
          <p className="text-xs text-ink-soft">{editing ? 'Le client et la date de la demande ne changent plus. L’étape se modifie depuis la fiche (ou le Kanban).' : 'Le projet démarre à l’étape « Demande client ». Le code DEV-xxxx est généré.'}</p>
        </div>
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          {!editing && (
            <FormField id="client_id" label="Client *" errors={errs.client_id}>
              <Select id="client_id" name="client_id" defaultValue={v('client_id', defaultClient)} aria-invalid={Boolean(errs.client_id)}><option value="">— Choisir un client —</option>{clients?.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.code})</option>)}</Select>
            </FormField>
          )}
          <FormField id="name" label="Désignation du produit *" errors={errs.name}><Input id="name" name="name" maxLength={160} defaultValue={v('name', project?.name)} placeholder="Veste haute visibilité doublée hiver" aria-invalid={Boolean(errs.name)} /></FormField>
          <FormField id="family" label="Famille *" errors={errs.family}><Select id="family" name="family" defaultValue={v('family', project?.family ?? 'jacket')}>{FAMILIES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}</Select></FormField>
          <FormField id="priority" label="Priorité" errors={errs.priority}><Select id="priority" name="priority" defaultValue={v('priority', project?.priority ?? 'normal')}>{Object.entries(PRIORITY).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}</Select></FormField>
          {!editing && <FormField id="requested_on" label="Date de la demande *" errors={errs.requested_on}><Input id="requested_on" name="requested_on" type="date" defaultValue={v('requested_on', today())} /></FormField>}
          <FormField id="due_date" label="Échéance du projet" errors={errs.due_date}><Input id="due_date" name="due_date" type="date" defaultValue={v('due_date', project?.due_date?.slice(0, 10))} /></FormField>
          <FormField id="target_qty" label="Quantité de la série visée" errors={errs.target_qty}><Input id="target_qty" name="target_qty" inputMode="numeric" defaultValue={v('target_qty', project?.target_qty)} placeholder="500" /></FormField>
          <FormField id="owner_id" label="Responsable du projet" errors={errs.owner_id}><Select id="owner_id" name="owner_id" defaultValue={v('owner_id', project?.owner_id)}><option value="">— Non affecté —</option>{owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select></FormField>
          {editing && (
            <FormField id="product_id" label="Fiche produit (PDM) liée" errors={errs.product_id}><Select id="product_id" name="product_id" defaultValue={v('product_id', project?.product_id)}><option value="">— Aucune —</option>{products?.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</Select></FormField>
          )}
          <div className="sm:col-span-2"><FormField id="description" label="Demande du client / cahier des charges" errors={errs.description}><Textarea id="description" name="description" rows={5} maxLength={4000} defaultValue={v('description', project?.description)} placeholder="Besoin, normes visées, quantités, coloris, contraintes de prix et de délai…" /></FormField></div>
        </div>
      </section>
      <div className="flex justify-end gap-2">
        <Link href={project ? `/development/projects/${project.id}` : '/development/projects'} className={buttonVariants({ variant: 'secondary' })}>Annuler</Link>
        <SubmitButton pendingText="Enregistrement…">{editing ? 'Enregistrer' : 'Créer le projet'}</SubmitButton>
      </div>
    </form>
  )
}
