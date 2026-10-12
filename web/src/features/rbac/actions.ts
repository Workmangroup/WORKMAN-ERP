'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'
import { getAuthContext } from '@/features/auth/services/access.service'
import type { AuthContextValue, FormState } from '@/features/auth/types'
import { isForbidden, rbacErrorMessage } from './errors'
import { logAccessDenied } from './services/audit-write.service'

/**
 * Actions de gestion RBAC. Double contrôle :
 *  1. vérification de la permission (message clair + refus journalisé) ;
 *  2. les fonctions SQL rbac_* re-vérifient tout (permission, anti-escalade, dernier admin)
 *     avec l'identité de l'appelant : même un appel direct à l'API est contrôlé.
 */

const uuid = z.uuid({ error: 'Identifiant invalide' })

async function authorize(permission: string): Promise<{ ctx: AuthContextValue } | { error: FormState }> {
  const ctx = await getAuthContext()
  if (!ctx) redirect('/login')
  if (!ctx.permissions.includes(permission)) {
    await logAccessDenied(ctx, permission, { via: 'server-action' })
    return { error: { ok: false, message: 'Vous n’avez pas la permission d’effectuer cette action.' } }
  }
  return { ctx }
}

async function fail(ctx: AuthContextValue, permission: string, err: { message?: string; details?: string | null }): Promise<FormState> {
  if (isForbidden(err)) await logAccessDenied(ctx, permission, { via: 'database' })
  return { ok: false, message: rbacErrorMessage(err) }
}

const flat = (e: z.ZodError): FormState => ({ ok: false, message: 'Veuillez corriger les champs en erreur.', fieldErrors: z.flattenError(e).fieldErrors })

// ---------------------------------------------------------------------
// Rôles
// ---------------------------------------------------------------------
const roleCreateSchema = z.object({
  code: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_]{1,31}$/, 'Minuscules, chiffres et _ (2 à 32 caractères), commence par une lettre'),
  label: z.string().trim().min(2, 'Libellé requis').max(60, '60 caractères maximum'),
  description: z.string().trim().max(300, '300 caractères maximum').optional(),
})

export async function createRoleAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize(P.ROLES_WRITE)
  if ('error' in auth) return auth.error
  const parsed = roleCreateSchema.safeParse({
    code: formData.get('code'),
    label: formData.get('label'),
    description: formData.get('description') || undefined,
  })
  if (!parsed.success) return flat(parsed.error)

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('rbac_create_role', {
    p_code: parsed.data.code,
    p_label: parsed.data.label,
    p_description: parsed.data.description ?? null,
  })
  if (error) return fail(auth.ctx, P.ROLES_WRITE, error)
  revalidatePath('/admin/roles')
  redirect(`/admin/roles/${data}?created=1`)
}

const roleUpdateSchema = z.object({
  roleId: uuid,
  label: z.string().trim().min(2, 'Libellé requis').max(60),
  description: z.string().trim().max(300).optional(),
})

export async function updateRoleAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize(P.ROLES_WRITE)
  if ('error' in auth) return auth.error
  const parsed = roleUpdateSchema.safeParse({
    roleId: formData.get('roleId'),
    label: formData.get('label'),
    description: formData.get('description') || undefined,
  })
  if (!parsed.success) return flat(parsed.error)

  const supabase = await createClient()
  const { error } = await supabase.rpc('rbac_update_role', {
    p_role: parsed.data.roleId,
    p_label: parsed.data.label,
    p_description: parsed.data.description ?? null,
  })
  if (error) return fail(auth.ctx, P.ROLES_WRITE, error)
  revalidatePath('/admin/roles', 'layout')
  return { ok: true, message: 'Rôle mis à jour.' }
}

export async function deleteRoleAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize(P.ROLES_WRITE)
  if ('error' in auth) return auth.error
  const id = uuid.safeParse(formData.get('roleId'))
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }

  const supabase = await createClient()
  const { error } = await supabase.rpc('rbac_delete_role', { p_role: id.data })
  if (error) return fail(auth.ctx, P.ROLES_WRITE, error)
  revalidatePath('/admin/roles')
  redirect('/admin/roles?deleted=1')
}

const permsSchema = z.object({
  roleId: uuid,
  perms: z.array(z.string().regex(/^[a-z_]+\.[a-z_]+$/)).max(200),
})

export async function saveRolePermissionsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize(P.ROLES_WRITE)
  if ('error' in auth) return auth.error
  const parsed = permsSchema.safeParse({ roleId: formData.get('roleId'), perms: formData.getAll('perm').map(String) })
  if (!parsed.success) return { ok: false, message: 'Données invalides.' }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('rbac_set_role_permissions', { p_role: parsed.data.roleId, p_codes: parsed.data.perms })
  if (error) return fail(auth.ctx, P.ROLES_WRITE, error)

  revalidatePath('/admin/roles', 'layout')
  const res = data as { added: string[]; removed: string[] }
  const changed = res.added.length + res.removed.length
  return {
    ok: true,
    message: changed === 0 ? 'Aucun changement.' : `Permissions enregistrées (+${res.added.length} / −${res.removed.length}).`,
  }
}

// ---------------------------------------------------------------------
// Utilisateurs
// ---------------------------------------------------------------------
const userRolesSchema = z.object({ userId: uuid, roleIds: z.array(uuid).max(50) })

export async function saveUserRolesAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize(P.ROLES_ASSIGN)
  if ('error' in auth) return auth.error
  const parsed = userRolesSchema.safeParse({ userId: formData.get('userId'), roleIds: formData.getAll('role').map(String) })
  if (!parsed.success) return { ok: false, message: 'Données invalides.' }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('rbac_set_user_roles', { p_user: parsed.data.userId, p_role_ids: parsed.data.roleIds })
  if (error) return fail(auth.ctx, P.ROLES_ASSIGN, error)

  const self = parsed.data.userId === auth.ctx.user.id
  let note = ''
  if (self) {
    await supabase.auth.refreshSession() // recalcule les claims (rôles/permissions) du jeton courant
  } else if (formData.get('force_logout') === 'on' && auth.ctx.permissions.includes(P.SESSIONS_MANAGE)) {
    const { error: e2 } = await supabase.rpc('rbac_revoke_user_sessions', { p_user: parsed.data.userId })
    note = e2 ? ' (échec de la déconnexion forcée)' : ' Sessions de l’utilisateur révoquées.'
  }

  revalidatePath('/admin/users', 'layout')
  const roles = ((data as { roles?: string[] })?.roles ?? []).length
  return { ok: true, message: `Rôles enregistrés (${roles}).${note}` }
}

export async function setUserActiveAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize(P.USERS_WRITE)
  if ('error' in auth) return auth.error
  const id = uuid.safeParse(formData.get('userId'))
  const active = formData.get('active') === '1'
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }

  const supabase = await createClient()
  const { error } = await supabase.rpc('rbac_set_user_active', { p_user: id.data, p_active: active })
  if (error) return fail(auth.ctx, P.USERS_WRITE, error)

  revalidatePath('/admin/users', 'layout')
  return { ok: true, message: active ? 'Compte activé.' : 'Compte désactivé et sessions révoquées.' }
}

export async function revokeUserSessionsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize(P.SESSIONS_MANAGE)
  if ('error' in auth) return auth.error
  const id = uuid.safeParse(formData.get('userId'))
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('rbac_revoke_user_sessions', { p_user: id.data })
  if (error) return fail(auth.ctx, P.SESSIONS_MANAGE, error)
  revalidatePath('/admin/users', 'layout')
  return { ok: true, message: `${data ?? 0} session(s) révoquée(s).` }
}
