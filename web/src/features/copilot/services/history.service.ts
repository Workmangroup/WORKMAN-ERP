import 'server-only'
import { createClient } from '@/lib/supabase/server'
import type { CopilotAnswer } from '../engine/answer'

export interface ConversationRow { id: string; title: string; updated_at: string }
export interface MessageRow { id: string; role: 'user' | 'assistant'; content: string; payload: (CopilotAnswer & { intent?: string }) | null; created_at: string }

/** Conversations de l'utilisateur courant (RLS : auteur seul). */
export async function listConversations(): Promise<ConversationRow[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('copilot_conversations').select('id,title,updated_at').order('updated_at', { ascending: false }).limit(100)
  return (data ?? []) as ConversationRow[]
}

export async function listMessages(conversationId: string): Promise<MessageRow[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('copilot_messages').select('id,role,content,payload,created_at')
    .eq('conversation_id', conversationId).order('created_at').limit(500)
  return (data ?? []) as MessageRow[]
}
