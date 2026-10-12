import 'server-only'
import { createClient } from '@/lib/supabase/server'
import { recentAuditFor } from '@/features/rbac/services/audit-query.service'
import type { AuditRow } from '@/features/rbac/types'

export interface WarehouseRow { id: string; code: string; name: string; kind: string; city: string | null; address: string | null; archived_at: string | null; role: string }
export interface ZoneRow { id: string; code: string; name: string; zone_type: string; notes: string | null; archived_at: string | null; bins: number }
export interface BinRow { id: string; code: string; name: string | null; kind: string; zone_id: string | null; zone: string | null; archived_at: string | null }
export interface AccessRow { id: string; user_id: string; full_name: string; email: string; role: string; active: boolean; granted_at: string; revoked_at: string | null }

/** Entrepôts accessibles à l'utilisateur : la base ne renvoie que les lignes autorisées (politiques RLS). Le rôle vient de ses propres affectations. */
export async function listMyWarehouses(userId: string): Promise<WarehouseRow[]> {
  const supabase = await createClient()
  const { data: whs } = await supabase.from('warehouses').select('id,code,name,kind,city,address,archived_at').order('name')
  const { data: mine } = await supabase.from('user_warehouses').select('warehouse_id,role').eq('user_id', userId).eq('active', true)
  const roles = new Map((mine ?? []).map((r) => [r.warehouse_id as string, r.role as string]))
  return ((whs ?? []) as Omit<WarehouseRow, 'role'>[]).map((w) => ({ ...w, role: roles.get(w.id) ?? 'viewer' }))
}

/** Responsables actifs par entrepôt (pour l'affichage des listes). */
export async function managersOf(ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  if (ids.length === 0) return out
  const supabase = await createClient()
  const { data } = await supabase.from('user_warehouses').select('warehouse_id,user_id').in('warehouse_id', ids).eq('role', 'manager').eq('active', true)
  const uids = [...new Set((data ?? []).map((r) => r.user_id as string))]
  const { data: users } = uids.length ? await supabase.from('company_directory').select('id,full_name,email').in('id', uids) : { data: [] }
  const name = new Map((users ?? []).map((u) => [u.id as string, ((u.full_name as string) || (u.email as string))]))
  for (const r of data ?? []) {
    const k = r.warehouse_id as string
    out.set(k, [...(out.get(k) ?? []), name.get(r.user_id as string) ?? '—'])
  }
  return out
}

export async function countsOf(ids: string[]): Promise<Map<string, { zones: number; bins: number }>> {
  const out = new Map<string, { zones: number; bins: number }>()
  if (ids.length === 0) return out
  const supabase = await createClient()
  const [{ data: zones }, { data: bins }] = await Promise.all([
    supabase.from('warehouse_locations').select('warehouse_id').in('warehouse_id', ids).is('archived_at', null),
    supabase.from('stock_locations').select('warehouse_id').in('warehouse_id', ids).is('archived_at', null),
  ])
  for (const id of ids) out.set(id, { zones: 0, bins: 0 })
  for (const z of zones ?? []) { const c = out.get(z.warehouse_id as string); if (c) c.zones++ }
  for (const b of bins ?? []) { const c = out.get(b.warehouse_id as string); if (c) c.bins++ }
  return out
}

export async function getWarehouse(id: string, userId: string): Promise<WarehouseRow | null> {
  const supabase = await createClient()
  const { data } = await supabase.from('warehouses').select('id,code,name,kind,city,address,archived_at').eq('id', id).maybeSingle()
  if (!data) return null
  const { data: mine } = await supabase.from('user_warehouses').select('role').eq('warehouse_id', id).eq('user_id', userId).eq('active', true).maybeSingle()
  return { ...(data as Omit<WarehouseRow, 'role'>), role: (mine?.role as string | undefined) ?? 'viewer' }
}

export async function listZones(warehouseId: string): Promise<ZoneRow[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('warehouse_locations').select('id,code,name,zone_type,notes,archived_at').eq('warehouse_id', warehouseId).order('code')
  const { data: bins } = await supabase.from('stock_locations').select('zone_id').eq('warehouse_id', warehouseId).is('archived_at', null)
  const n = new Map<string, number>()
  for (const b of bins ?? []) if (b.zone_id) n.set(b.zone_id as string, (n.get(b.zone_id as string) ?? 0) + 1)
  return ((data ?? []) as Omit<ZoneRow, 'bins'>[]).map((z) => ({ ...z, bins: n.get(z.id) ?? 0 }))
}

export async function listBins(warehouseId: string): Promise<BinRow[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('stock_locations').select('id,code,name,kind,zone_id,archived_at').eq('warehouse_id', warehouseId).order('code')
  const { data: zones } = await supabase.from('warehouse_locations').select('id,code').eq('warehouse_id', warehouseId)
  const zm = new Map((zones ?? []).map((z) => [z.id as string, z.code as string]))
  return ((data ?? []) as Record<string, unknown>[]).map((b) => ({
    id: b.id as string, code: b.code as string, name: (b.name as string | null) ?? null, kind: b.kind as string, zone_id: (b.zone_id as string | null) ?? null,
    zone: b.zone_id ? zm.get(b.zone_id as string) ?? null : null, archived_at: (b.archived_at as string | null) ?? null,
  }))
}

export async function listAccess(warehouseId: string): Promise<AccessRow[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('user_warehouses').select('id,user_id,role,active,granted_at,revoked_at').eq('warehouse_id', warehouseId).order('active', { ascending: false }).order('granted_at')
  const uids = [...new Set((data ?? []).map((r) => r.user_id as string))]
  const { data: users } = uids.length ? await supabase.from('company_directory').select('id,full_name,email').in('id', uids) : { data: [] }
  const um = new Map((users ?? []).map((u) => [u.id as string, u as { full_name: string; email: string }]))
  return (data ?? []).map((r) => ({
    id: r.id as string, user_id: r.user_id as string, full_name: um.get(r.user_id as string)?.full_name ?? '—', email: um.get(r.user_id as string)?.email ?? '',
    role: r.role as string, active: Boolean(r.active), granted_at: r.granted_at as string, revoked_at: (r.revoked_at as string | null) ?? null,
  }))
}

/** Utilisateurs de la société pouvant recevoir un accès (liste complète, sans les accès actifs à cet entrepôt). */
export async function candidateUsers(warehouseId: string, active: string[]): Promise<{ id: string; label: string }[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('company_directory').select('id,full_name,email').order('full_name').limit(300)
  return (data ?? []).filter((u) => !active.includes(u.id as string)).map((u) => ({ id: u.id as string, label: `${(u.full_name as string) || u.email} (${u.email})` }))
}

export async function warehouseHistory(id: string): Promise<AuditRow[]> {
  return recentAuditFor('warehouse', id, 150)
}
