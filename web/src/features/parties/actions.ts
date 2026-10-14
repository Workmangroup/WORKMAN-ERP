'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import type { FormState } from '@/features/auth/types'

/**
 * Tiers : proposition et décision de fusion. Les droits et la séparation des tâches sont appliqués en base
 * (party_propose_merge, party_decide_merge) ; ces actions ne font que transmettre les saisies.
 */

const uuid = z.uuid()
const MESSAGES: Record<string, string> = {
  RBAC_FORBIDDEN: 'Vous n’avez pas la permission d’effectuer cette action.',
  SOD_SELF_APPROVAL: 'Séparation des tâches : l’auteur d’une proposition ne peut pas la décider.',
  MERGE_CROSS_COMPANY: 'Fusion impossible : ce tiers est aussi utilisé par une autre société.',
  MERGE_ARCHIVED_ROW: 'Fusion impossible : une fiche de ce tiers est archivée.',
  PARTY_NOT_ACTIVE: 'Ce tiers a déjà été fusionné.',
  PARTY_NOT_FOUND: 'Tiers introuvable.',
  PARTY_SAME: 'Un tiers ne peut pas être fusionné avec lui-même.',
  PARTY_REASON_REQUIRED: 'Indiquez le motif (5 caractères minimum).',
  PARTY_COMMENT_REQUIRED: 'Un refus exige un commentaire (3 caractères minimum).',
  PARTY_PROPOSAL_BAD_STATUS: 'Cette proposition a déjà été décidée.',
  PARTY_PROPOSAL_NOT_FOUND: 'Proposition introuvable.',
  PARTY_BAD_CHOICE: 'Choix de champ invalide.',
}
const message = (err: { message?: string; details?: string | null }) => {
  const text = `${err.message ?? ''} ${err.details ?? ''}`
  const key = Object.keys(MESSAGES).find((k) => text.includes(k))
  return key ? MESSAGES[key] : 'Action impossible : vérifiez les données et vos droits, puis réessayez.'
}
const raw = (fd: FormData) => Object.fromEntries([...fd.entries()].filter(([, v]) => typeof v === 'string')) as Record<string, string>

export async function proposeMergeAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const v = z.object({ source: uuid, target: uuid, reason: z.string().trim().min(5, 'Motif : 5 caractères minimum').max(300) }).safeParse(raw(fd))
  if (!v.success) return { ok: false, message: v.error.issues[0]?.message ?? 'Saisie invalide.' }
  const supabase = await createClient()
  const { error } = await supabase.rpc('party_propose_merge', { p_source: v.data.source, p_target: v.data.target, p_reason: v.data.reason })
  if (error) return { ok: false, message: message(error) }
  revalidatePath('/tiers/doublons')
  return { ok: true, message: 'Fusion proposée : elle sera décidée par un steward.' }
}

export async function decideMergeAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const v = z.object({
    id: uuid,
    decision: z.enum(['approve', 'reject']),
    legal_name: z.enum(['source', 'target']),
    comment: z.string().trim().max(300).optional(),
  }).safeParse(raw(fd))
  if (!v.success) return { ok: false, message: 'Saisie invalide.' }
  const supabase = await createClient()
  const approve = v.data.decision === 'approve'
  const { error } = await supabase.rpc('party_decide_merge', {
    p_proposal: v.data.id, p_approve: approve, p_choices: { legal_name: v.data.legal_name }, p_comment: v.data.comment || null,
  })
  if (error) return { ok: false, message: message(error) }
  revalidatePath('/tiers/doublons')
  return { ok: true, message: approve ? 'Fusion appliquée et tracée.' : 'Proposition refusée.' }
}
