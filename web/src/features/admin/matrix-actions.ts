'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { getAuthContext } from '@/features/auth/services/access.service'
import { logAccessDenied } from '@/features/rbac/services/audit-write.service'
import { P } from '@/lib/rbac/permissions'
import type { AccessChoice } from '@/lib/admin/matrix'

/** Actions des matrices d'administration. Les droits sont vérifiés en base (RPC) ; ici, contrôle de session et messages. */

export type MatrixResult = { ok: true; message: string } | { ok: false; message: string }

const denied = (t: string) => /RBAC_FORBIDDEN|42501|row-level security/.test(t)

export async function setRolePermissionsAction(roleId: string, codes: string[]): Promise<MatrixResult> {
  const ctx = await getAuthContext()
  if (!ctx) redirect('/login')
  const parsed = z.object({ roleId: z.uuid(), codes: z.array(z.string().regex(/^[a-z_]+\.[a-z_.]+$/)).max(200) }).safeParse({ roleId, codes })
  if (!parsed.success) return { ok: false, message: 'Données invalides.' }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('rbac_set_role_permissions', { p_role: parsed.data.roleId, p_codes: parsed.data.codes })
  if (error) {
    if (denied(`${error.message} ${error.code ?? ''}`)) await logAccessDenied(ctx, P.ROLES_WRITE, { via: 'server-action' })
    return { ok: false, message: denied(`${error.message} ${error.code ?? ''}`) ? 'Vous n’avez pas la permission de modifier les rôles.' : 'Enregistrement impossible. Réessayez.' }
  }
  revalidatePath('/admin', 'layout')
  const r = data as { added: string[]; removed: string[] }
  return { ok: true, message: r.added.length + r.removed.length === 0 ? 'Aucun changement.' : `Enregistré : +${r.added.length} / −${r.removed.length}.` }
}

export async function setWarehouseAccessAction(userId: string, warehouseId: string, choice: AccessChoice): Promise<MatrixResult> {
  const ctx = await getAuthContext()
  if (!ctx) redirect('/login')
  const parsed = z.object({ u: z.uuid(), w: z.uuid(), c: z.enum(['none', 'viewer', 'operator', 'manager']) })
    .safeParse({ u: userId, w: warehouseId, c: choice })
  if (!parsed.success) return { ok: false, message: 'Données invalides.' }
  const supabase = await createClient()
  const { error } = parsed.data.c === 'none'
    ? await supabase.rpc('wh_revoke_user', { p_user: parsed.data.u, p_warehouse: parsed.data.w })
    : await supabase.rpc('wh_assign_user', { p_user: parsed.data.u, p_warehouse: parsed.data.w, p_role: parsed.data.c })
  if (error) {
    const t = `${error.message} ${error.code ?? ''}`
    if (denied(t)) await logAccessDenied(ctx, P.WAREHOUSES_MANAGE, { via: 'server-action' })
    return { ok: false, message: denied(t) ? 'Vous n’avez pas la permission de gérer les accès à cet entrepôt.' : 'Modification impossible : vérifiez qu’un responsable reste affecté.' }
  }
  revalidatePath('/admin', 'layout')
  return { ok: true, message: parsed.data.c === 'none' ? 'Accès retiré.' : 'Accès enregistré.' }
}
