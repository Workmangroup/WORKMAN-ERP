'use server'

import { redirect } from 'next/navigation'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'
import { getAuthContext } from '@/features/auth/services/access.service'
import { logAccessDenied } from '@/features/rbac/services/audit-write.service'
import { answerQuestion } from './services/copilot-engine'
import type { CopilotAnswer } from './engine/answer'

/** Copilote : chaque question et chaque réponse est enregistrée dans l'historique personnel (RLS : auteur seul). */

const schema = z.object({
  conversationId: z.uuid().nullable(),
  question: z.string().trim().min(2, 'Question trop courte').max(1000, 'Question trop longue (1 000 caractères max.)'),
})

export type AskResult =
  | { ok: true; conversationId: string; title: string; user: { content: string }; assistant: { content: string; payload: CopilotAnswer & { intent: string } } }
  | { ok: false; message: string }

export async function askCopilotAction(conversationId: string | null, question: string): Promise<AskResult> {
  const ctx = await getAuthContext()
  if (!ctx) redirect('/login')
  if (!ctx.permissions.includes(P.COPILOT_USE)) {
    await logAccessDenied(ctx, P.COPILOT_USE, { via: 'server-action' })
    return { ok: false, message: 'Le copilote n’est pas activé pour votre rôle.' }
  }
  const parsed = schema.safeParse({ conversationId, question })
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'Question invalide.' }
  const q = parsed.data.question
  const supabase = await createClient()

  let convId = parsed.data.conversationId
  let title = ''
  if (!convId) {
    title = q.length > 60 ? `${q.slice(0, 57)}…` : q
    const { data, error } = await supabase.from('copilot_conversations').insert({ title }).select('id,title').single()
    if (error || !data) return { ok: false, message: 'Impossible de créer la conversation.' }
    convId = data.id as string
    title = data.title as string
  }

  const { error: uErr } = await supabase.from('copilot_messages').insert({ conversation_id: convId, role: 'user', content: q, payload: {} })
  if (uErr) return { ok: false, message: 'Impossible d’enregistrer votre question.' }

  const { intent, answer } = await answerQuestion(q, supabase, ctx.permissions)
  const payload = { ...answer, intent }
  const content = answer.text.join('\n')
  const { error: aErr } = await supabase.from('copilot_messages').insert({ conversation_id: convId, role: 'assistant', content, payload })
  if (aErr) return { ok: false, message: 'La réponse n’a pas pu être enregistrée.' }
  await supabase.from('copilot_conversations').update({ updated_at: new Date().toISOString() }).eq('id', convId)

  return { ok: true, conversationId: convId, title, user: { content: q }, assistant: { content, payload } }
}

export async function deleteConversationAction(conversationId: string): Promise<{ ok: boolean; message?: string }> {
  const ctx = await getAuthContext()
  if (!ctx) redirect('/login')
  const parsed = z.uuid().safeParse(conversationId)
  if (!parsed.success) return { ok: false, message: 'Conversation invalide.' }
  const supabase = await createClient()
  const { error } = await supabase.from('copilot_conversations').delete().eq('id', parsed.data)
  if (error) return { ok: false, message: 'Suppression impossible.' }
  return { ok: true }
}
