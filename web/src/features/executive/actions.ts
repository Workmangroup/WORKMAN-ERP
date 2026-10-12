'use server'

import { redirect } from 'next/navigation'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'
import { getAuthContext } from '@/features/auth/services/access.service'
import { logAccessDenied } from '@/features/rbac/services/audit-write.service'
import type { ExecutiveSnapshot } from './types'

/** Rafraîchissement du tableau de bord DG (appelé toutes les 30 secondes par la page). */
export async function refreshExecutiveAction(months: number): Promise<{ ok: true; data: ExecutiveSnapshot } | { ok: false; message: string }> {
  const ctx = await getAuthContext()
  if (!ctx) redirect('/login')
  if (!ctx.permissions.includes(P.DASHBOARD_EXECUTIVE)) {
    await logAccessDenied(ctx, P.DASHBOARD_EXECUTIVE, { via: 'server-action' })
    return { ok: false, message: 'Vous n’avez pas accès au tableau de bord DG.' }
  }
  const parsed = z.number().int().min(3).max(24).safeParse(months)
  if (!parsed.success) return { ok: false, message: 'Période invalide.' }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('executive_dashboard', { p_months: parsed.data })
  if (error || !data) return { ok: false, message: 'Impossible de charger les indicateurs. Réessayez dans un instant.' }
  return { ok: true, data: data as ExecutiveSnapshot }
}
