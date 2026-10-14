'use client'

import { useRef } from 'react'
import { Check, X } from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { FormField } from '@/components/auth/form-field'
import type { FormState } from '@/features/auth/types'
import { useManualAction } from '@/lib/use-manual-action'
import { decideMergeAction, proposeMergeAction } from '../actions'

function Messages({ state }: { state: FormState }) {
  if (!state) return null
  return state.ok ? <Alert tone="success">{state.message}</Alert> : <Alert tone="error">{state.message}</Alert>
}

export function ProposeMergeForm({ source, target }: { source: string; target: string }) {
  const [state, onSubmit, pending] = useManualAction(proposeMergeAction, null)
  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="source" value={source} />
      <input type="hidden" name="target" value={target} />
      <FormField id={`pm-${source}-${target}`} label="Motif de la fusion">
        <Input id={`pm-${source}-${target}`} name="reason" minLength={5} maxLength={300} required />
      </FormField>
      <Button type="submit" size="sm" disabled={pending}>Proposer la fusion</Button>
      <div className="w-full"><Messages state={state} /></div>
    </form>
  )
}

/** Décision du steward : valider (avec le choix de la raison sociale) ou refuser (commentaire requis). */
export function DecideMergeForm({ id }: { id: string }) {
  const [state, onSubmit, pending] = useManualAction(decideMergeAction, null)
  const formRef = useRef<HTMLFormElement>(null)
  const decision = useRef<HTMLInputElement>(null)
  // Le choix d'une décision passe par un champ caché réglé avant la soumission (FormData n'inclut pas le bouton cliqué)
  const decide = (value: 'approve' | 'reject') => { if (decision.current) decision.current.value = value; formRef.current?.requestSubmit() }
  return (
    <form ref={formRef} onSubmit={onSubmit} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="decision" ref={decision} defaultValue="approve" />
      <FormField id={`dm-choice-${id}`} label="Raison sociale retenue">
        <Select id={`dm-choice-${id}`} name="legal_name" defaultValue="target">
          <option value="target">Celle du tiers conservé</option>
          <option value="source">Celle du tiers fusionné</option>
        </Select>
      </FormField>
      <FormField id={`dm-comment-${id}`} label="Commentaire (obligatoire pour un refus)">
        <Input id={`dm-comment-${id}`} name="comment" maxLength={300} />
      </FormField>
      <Button type="button" size="sm" disabled={pending} onClick={() => decide('approve')}><Check className="h-4 w-4" /> Fusionner</Button>
      <Button type="button" size="sm" variant="danger" disabled={pending} onClick={() => decide('reject')}><X className="h-4 w-4" /> Refuser</Button>
      <div className="w-full"><Messages state={state} /></div>
    </form>
  )
}
