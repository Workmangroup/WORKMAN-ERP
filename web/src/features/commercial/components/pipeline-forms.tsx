'use client'

import { useActionState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import type { FormState } from '@/features/auth/types'
import { createOpportunityAction, setOpportunityStageAction } from '../opportunity-actions'

export function OpportunityCreateForm({ clients, currencies }: { clients: { id: string; name: string }[]; currencies: string[] }) {
  const [state, action, pending] = useActionState<FormState, FormData>(createOpportunityAction, null)
  return (
    <form action={action} className="grid gap-3 rounded-md border border-line bg-white p-4 shadow-card sm:grid-cols-2 lg:grid-cols-4">
      <label className="space-y-1 text-sm sm:col-span-2"><span className="font-medium">Client *</span>
        <Select name="client" required defaultValue={state?.values?.client ?? ''}>
          <option value="" disabled>Choisir un client</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
      </label>
      <label className="space-y-1 text-sm sm:col-span-2"><span className="font-medium">Nom de l’opportunité *</span>
        <Input name="name" required minLength={2} maxLength={120} defaultValue={state?.values?.name ?? ''} />
      </label>
      <label className="space-y-1 text-sm"><span className="font-medium">Montant *</span>
        <Input name="amount" required inputMode="decimal" defaultValue={state?.values?.amount ?? ''} />
      </label>
      <label className="space-y-1 text-sm"><span className="font-medium">Devise *</span>
        <Select name="currency" required defaultValue={state?.values?.currency ?? currencies[0] ?? 'EUR'}>
          {currencies.map((c) => <option key={c} value={c}>{c}</option>)}
        </Select>
      </label>
      <label className="space-y-1 text-sm"><span className="font-medium">Date attendue</span>
        <Input name="expected_close" type="date" defaultValue={state?.values?.expected_close ?? ''} />
      </label>
      <label className="space-y-1 text-sm sm:col-span-2"><span className="font-medium">Prochaine action</span>
        <Input name="next_action" maxLength={200} defaultValue={state?.values?.next_action ?? ''} />
      </label>
      <label className="space-y-1 text-sm"><span className="font-medium">Date de l’action</span>
        <Input name="next_date" type="date" defaultValue={state?.values?.next_date ?? ''} />
      </label>
      <div className="flex items-end gap-3 sm:col-span-2">
        <Button type="submit" disabled={pending}>Créer l’opportunité</Button>
        {state?.message && <p role="status" className={state.ok ? 'text-sm text-ink-soft' : 'text-sm text-danger'}>{state.message}</p>}
      </div>
    </form>
  )
}

/** Changement d'étape : seules les transitions paramétrées sont acceptées ; une perte exige un motif. */
export function StageMoveForm({ id, current, stages }: { id: string; current: string | null; stages: { code: string; label: string; kind: string }[] }) {
  const [state, action, pending] = useActionState<FormState, FormData>(setOpportunityStageAction, null)
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="id" value={id} />
      <Select name="stage" defaultValue={current ?? ''} aria-label="Étape" className="h-8 w-auto text-xs">
        {stages.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
      </Select>
      <Input name="reason" placeholder="Motif (si perdu)" maxLength={300} className="h-8 w-44 text-xs" />
      <Button type="submit" size="sm" variant="secondary" disabled={pending}>Changer</Button>
      {state?.message && <span role="status" className={state.ok ? 'text-xs text-ink-soft' : 'text-xs text-danger'}>{state.message}</span>}
    </form>
  )
}
