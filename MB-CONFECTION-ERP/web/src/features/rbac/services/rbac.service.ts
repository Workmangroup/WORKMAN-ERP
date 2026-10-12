import 'server-only'
import { createClient } from '@/lib/supabase/server'
import { SYSTEM_ROLES } from '@/lib/rbac/permissions'
import type { PermissionRow, RoleRef, RoleRow, UserRow } from '../types'

/** Lectures RBAC avec la session de l'utilisateur : la RLS reste la barrière d'accès. */

const count = (v: unknown) => (Array.isArray(v) ? ((v[0] as { count?: number } | undefined)?.count ?? 0) : 0)

function sortRoles<T extends { code: string; label: string; is_system: boolean }>(rows: T[]) {
  const order = (r: T) => {
    const i = (SYSTEM_ROLES as readonly string[]).indexOf(r.code)
    return r.is_system && i >= 0 ? i : 100
  }
  return [...rows].sort((a, b) => order(a) - order(b) || a.label.localeCompare(b.label, 'fr'))
}

export async function listRoles(): Promise<RoleRow[]> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('roles')
    .select('id,code,label,description,is_system,role_permissions(count),user_roles(count)')
  if (error) throw new Error(error.message)
  return sortRoles(
    (data ?? []).map((r) => ({
      id: r.id as string,
      code: r.code as string,
      label: r.label as string,
      description: (r.description as string | null) ?? null,
      is_system: Boolean(r.is_system),
      permission_count: count(r.role_permissions),
      user_count: count(r.user_roles),
    })),
  )
}

export async function getRole(id: string): Promise<RoleRow | null> {
  const supabase = await createClient()
  const { data } = await supabase
    .from('roles')
    .select('id,code,label,description,is_system,role_permissions(count),user_roles(count)')
    .eq('id', id)
    .maybeSingle()
  if (!data) return null
  return {
    id: data.id as string,
    code: data.code as string,
    label: data.label as string,
    description: (data.description as string | null) ?? null,
    is_system: Boolean(data.is_system),
    permission_count: count(data.role_permissions),
    user_count: count(data.user_roles),
  }
}

export async function listPermissions(): Promise<PermissionRow[]> {
  const supabase = await createClient()
  const { data, error } = await supabase.from('permissions').select('code,module,label,description').order('module').order('code')
  if (error) throw new Error(error.message)
  return (data ?? []) as PermissionRow[]
}

export async function getRolePermissionCodes(roleId: string): Promise<string[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('role_permissions').select('permissions(code)').eq('role_id', roleId)
  return (data ?? []).map((r) => (r.permissions as unknown as { code: string } | null)?.code).filter((c): c is string => Boolean(c))
}

/** Matrice rôle → permissions (pour la vue d'ensemble). */
export async function getPermissionMatrix(): Promise<Record<string, Set<string>>> {
  const supabase = await createClient()
  const { data } = await supabase.from('role_permissions').select('role_id,permissions(code)')
  const map: Record<string, Set<string>> = {}
  for (const row of data ?? []) {
    const code = (row.permissions as unknown as { code: string } | null)?.code
    if (!code) continue
    ;(map[row.role_id as string] ??= new Set()).add(code)
  }
  return map
}

export async function listRoleUsers(roleId: string) {
  const supabase = await createClient()
  const { data } = await supabase.from('user_roles').select('profiles(id,email,full_name,is_active)').eq('role_id', roleId)
  return (data ?? [])
    .map((r) => r.profiles as unknown as { id: string; email: string; full_name: string; is_active: boolean } | null)
    .filter((p): p is NonNullable<typeof p> => Boolean(p))
}

const USER_SELECT = 'id,email,full_name,is_active,user_type,last_sign_in_at,user_roles(roles(id,code,label))'

function mapUser(r: Record<string, unknown>): UserRow {
  const roles = ((r.user_roles as { roles: RoleRef | null }[] | null) ?? [])
    .map((ur) => ur.roles)
    .filter((x): x is RoleRef => Boolean(x))
    .sort((a, b) => a.label.localeCompare(b.label, 'fr'))
  return {
    id: r.id as string,
    email: r.email as string,
    full_name: r.full_name as string,
    is_active: Boolean(r.is_active),
    user_type: r.user_type as 'internal' | 'client',
    last_sign_in_at: (r.last_sign_in_at as string | null) ?? null,
    roles,
  }
}

export async function listUsers(search?: string): Promise<UserRow[]> {
  const supabase = await createClient()
  let query = supabase.from('profiles').select(USER_SELECT).order('full_name')
  const term = (search ?? '').replace(/[%,()*\\]/g, ' ').trim().slice(0, 60)
  if (term) query = query.or(`full_name.ilike.%${term}%,email.ilike.%${term}%`)
  const { data, error } = await query
  if (error) throw new Error(error.message)
  return (data ?? []).map((r) => mapUser(r as Record<string, unknown>))
}

export async function getUser(id: string): Promise<UserRow | null> {
  const supabase = await createClient()
  const { data } = await supabase.from('profiles').select(USER_SELECT).eq('id', id).maybeSingle()
  return data ? mapUser(data as Record<string, unknown>) : null
}

/** Rôles avec leurs permissions : sert à calculer ceux que l'acteur a le droit d'affecter. */
export async function listRolesWithPermissions(): Promise<(RoleRow & { permissions: string[] })[]> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('roles')
    .select('id,code,label,description,is_system,user_roles(count),role_permissions(permissions(code))')
  if (error) throw new Error(error.message)
  const rows = (data ?? []).map((r) => {
    const perms = ((r.role_permissions as unknown as { permissions: { code: string } | null }[] | null) ?? [])
      .map((x) => x.permissions?.code)
      .filter((c): c is string => Boolean(c))
    return {
      id: r.id as string,
      code: r.code as string,
      label: r.label as string,
      description: (r.description as string | null) ?? null,
      is_system: Boolean(r.is_system),
      user_count: count(r.user_roles),
      permission_count: perms.length,
      permissions: perms,
    }
  })
  return sortRoles(rows)
}
