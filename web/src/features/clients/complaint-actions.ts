'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { getAuthContext } from '@/features/auth/services/access.service'
import type { FormState } from '@/features/auth/types'

const MSG: [string, string][] = [
  ['COMPLAINT_ORDER_NOT_FOUND', 'Cette commande n’appartient pas à ce client.'],
  ['COMPLAINT_RESOLUTION_REQUIRED', 'La solution doit être décrite (10 caractères minimum).'],
  ['COMPLAINT_BAD_STATUS', 'Cette étape n’est pas possible dans l’état actuel.'],
  ['RBAC_FORBIDDEN', 'Vous n’avez pas la permission d’effectuer cette action.'],
]
const msg = (t: string) => MSG.find(([k]) => t.includes(k))?.[1] ?? 'Une erreur est survenue. Réessayez.'

export async function openComplaintAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await getAuthContext()
  if (!ctx) redirect('/login')
  const parsed = z.object({
    client_id: z.uuid(),
    order_id: z.string().trim().optional().transform((v) => (v ? v : null)).pipe(z.union([z.null(), z.uuid()])),
    subject: z.string().trim().min(3, 'Objet : 3 caractères minimum').max(160),
    description: z.string().trim().max(2000).optional().transform((v) => (v ? v : null)),
    severity: z.enum(['minor', 'major', 'critical'], { message: 'Gravité inconnue' }),
  }).safeParse({ client_id: fd.get('client_id'), order_id: fd.get('order_id') ?? '', subject: fd.get('subject'), description: fd.get('description') ?? '', severity: fd.get('severity') })
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'Saisie invalide.' }
  const d = parsed.data
  const supabase = await createClient()
  const { error } = await supabase.rpc('complaint_open', { p_client: d.client_id, p_order: d.order_id, p_subject: d.subject, p_description: d.description, p_severity: d.severity })
  if (error) return { ok: false, message: msg(`${error.message} ${error.details ?? ''}`) }
  revalidatePath(`/clients/${d.client_id}`)
  return { ok: true, message: 'Réclamation ouverte.' }
}

export async function updateComplaintAction(clientId: string, complaintId: string, status: 'in_progress' | 'resolved' | 'closed', resolution: string | null): Promise<FormState> {
  const ctx = await getAuthContext()
  if (!ctx) redirect('/login')
  const parsed = z.object({ c: z.uuid(), cl: z.uuid(), s: z.enum(['in_progress', 'resolved', 'closed']) })
    .safeParse({ c: complaintId, cl: clientId, s: status })
  if (!parsed.success) return { ok: false, message: 'Action invalide.' }
  const supabase = await createClient()
  const { error } = await supabase.rpc('complaint_update', { p_complaint: parsed.data.c, p_status: parsed.data.s, p_resolution: resolution })
  if (error) return { ok: false, message: msg(`${error.message} ${error.details ?? ''}`) }
  revalidatePath(`/clients/${clientId}`)
  return { ok: true, message: 'Réclamation mise à jour.' }
}
