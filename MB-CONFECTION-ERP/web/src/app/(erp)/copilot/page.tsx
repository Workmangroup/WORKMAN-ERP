import type { Metadata } from 'next'
import { requirePermission } from '@/features/auth/guards'
import { CopilotChat } from '@/features/copilot/components/copilot-chat'
import { listConversations, listMessages } from '@/features/copilot/services/history.service'
import { P } from '@/lib/rbac/permissions'
import { z } from 'zod'

export const metadata: Metadata = { title: 'WORKMAN ERP 360 Copilot IA' }

export default async function CopilotPage({ searchParams }: { searchParams: Promise<{ c?: string }> }) {
  await requirePermission(P.COPILOT_USE)
  const sp = await searchParams
  const activeId = z.uuid().safeParse(sp.c ?? '').success ? (sp.c as string) : null
  const [conversations, messages] = await Promise.all([listConversations(), activeId ? listMessages(activeId) : Promise.resolve([])])
  return <CopilotChat conversations={conversations} messages={messages} activeId={activeId} />
}
