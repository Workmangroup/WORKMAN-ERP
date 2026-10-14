'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'
import { getAuthContext } from '@/features/auth/services/access.service'
import type { FormState } from '@/features/auth/types'
import { logAccessDenied } from '@/features/rbac/services/audit-write.service'

/** Écritures via les fonctions client_* : droits, appartenance des liens au client et audit y sont appliqués. */

const MESSAGES: Record<string, string> = {
  RBAC_FORBIDDEN: 'Vous n’avez pas la permission d’effectuer cette action.',
  CLIENT_LINK_INVALID: 'Une pièce liée n’appartient pas à ce client ou n’est pas accessible. Aucune tâche n’a été créée.',
  CONSENT_PROOF_REQUIRED: 'Indiquez la preuve de l’autorisation (5 caractères minimum).',
  CLIENT_EMAIL_ALREADY_AUTHORIZED: 'Cette adresse est déjà autorisée pour cette finalité.',
  CLIENT_EMAIL_BAD_STATUS: 'Cette autorisation est déjà retirée.',
  TASK_DUE_REQUIRED: 'La tâche doit avoir une échéance.',
  TASK_OWNER_INVALID: 'Responsable invalide : il doit pouvoir travailler les clients.',
  TASK_BAD_STATUS: 'Cette tâche est déjà fermée.',
  CLIENT_NOT_FOUND: 'Client introuvable.',
}
const messageOf = (e: { message?: string }) => MESSAGES[e.message ?? ''] ?? 'L’opération a échoué. Vérifiez les données et réessayez.'

async function authorize(): Promise<{ ok: true } | { ok: false; message: string }> {
  const ctx = await getAuthContext()
  if (!ctx) redirect('/login')
  if (!ctx.permissions.includes(P.CLIENTS_WRITE)) {
    await logAccessDenied(ctx, P.CLIENTS_WRITE, { via: 'server-action' })
    return { ok: false, message: MESSAGES.RBAC_FORBIDDEN }
  }
  return { ok: true }
}

const client = z.uuid()
const txt = (max: number) => z.string().trim().max(max)

export async function recordVisitAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize()
  if (!auth.ok) return { ok: false, message: auth.message }
  const id = client.safeParse(String(fd.get('client') ?? ''))
  const kind = z.enum(['visit', 'call', 'meeting']).safeParse(fd.get('kind'))
  const summary = txt(1000).min(2).safeParse(fd.get('summary'))
  const on = z.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]).safeParse(String(fd.get('on') ?? ''))
  const contact = z.union([z.literal(''), z.uuid()]).safeParse(String(fd.get('contact') ?? ''))
  if (!id.success || !kind.success || !summary.success || !on.success || !contact.success) return { ok: false, message: 'Données invalides.' }
  const supabase = await createClient()
  const { error } = await supabase.rpc('client_visit_record', {
    p_client: id.data, p_on: on.data || null, p_kind: kind.data, p_summary: summary.data, p_contact: contact.data || null,
  })
  if (error) return { ok: false, message: messageOf(error) }
  revalidatePath(`/clients/${id.data}`)
  return { ok: true, message: 'Visite enregistrée.' }
}

export async function authorizeEmailAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize()
  if (!auth.ok) return { ok: false, message: auth.message }
  const id = client.safeParse(String(fd.get('client') ?? ''))
  const email = z.string().trim().email('Adresse courriel invalide').safeParse(fd.get('email'))
  const purpose = z.enum(['commercial', 'billing', 'technical']).safeParse(fd.get('purpose'))
  const proof = txt(300).min(5, 'Preuve requise (5 caractères minimum)').safeParse(fd.get('proof'))
  if (!id.success || !email.success || !purpose.success || !proof.success) return { ok: false, message: 'Données invalides.' }
  const supabase = await createClient()
  const { error } = await supabase.rpc('client_email_authorize', { p_client: id.data, p_email: email.data, p_purpose: purpose.data, p_proof: proof.data })
  if (error) return { ok: false, message: messageOf(error) }
  revalidatePath(`/clients/${id.data}`)
  return { ok: true, message: 'Adresse autorisée.' }
}

export async function withdrawEmailAction(channel: string, clientId: string): Promise<FormState> {
  const auth = await authorize()
  if (!auth.ok) return { ok: false, message: auth.message }
  if (!client.safeParse(channel).success || !client.safeParse(clientId).success) return { ok: false, message: 'Données invalides.' }
  const supabase = await createClient()
  const { error } = await supabase.rpc('client_email_withdraw', { p_channel: channel })
  if (error) return { ok: false, message: messageOf(error) }
  revalidatePath(`/clients/${clientId}`)
  return { ok: true, message: 'Autorisation retirée (conservée dans l’historique).' }
}

export async function createClientTaskAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize()
  if (!auth.ok) return { ok: false, message: auth.message }
  const id = client.safeParse(String(fd.get('client') ?? ''))
  const title = txt(200).min(3, 'Titre requis (3 caractères minimum)').safeParse(fd.get('title'))
  const due = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Échéance requise').safeParse(String(fd.get('due') ?? ''))
  if (!id.success || !title.success || !due.success) return { ok: false, message: 'Données invalides : ' + (title.success ? 'échéance requise.' : title.error.issues[0]?.message) }
  const links = fd.getAll('link').map((v) => String(v).split(':')).filter((p) => p.length === 2)
    .map(([type, pid]) => ({ type, id: pid }))
  if (links.length > 20) return { ok: false, message: 'Trop de pièces liées (20 maximum).' }
  const supabase = await createClient()
  const { error } = await supabase.rpc('client_task_create', { p_client: id.data, p_title: title.data, p_due: due.data, p_owner: null, p_links: links })
  if (error) return { ok: false, message: messageOf(error) }
  revalidatePath(`/clients/${id.data}`)
  return { ok: true, message: 'Tâche créée.' }
}

export async function completeClientTaskAction(task: string, clientId: string): Promise<FormState> {
  const auth = await authorize()
  if (!auth.ok) return { ok: false, message: auth.message }
  if (!client.safeParse(task).success || !client.safeParse(clientId).success) return { ok: false, message: 'Données invalides.' }
  const supabase = await createClient()
  const { error } = await supabase.rpc('client_task_complete', { p_task: task })
  if (error) return { ok: false, message: messageOf(error) }
  revalidatePath(`/clients/${clientId}`)
  return { ok: true, message: 'Tâche terminée.' }
}
