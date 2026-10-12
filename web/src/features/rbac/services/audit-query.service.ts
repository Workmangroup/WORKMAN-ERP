import 'server-only'
import { createClient } from '@/lib/supabase/server'
import { AUDIT_READ_COLUMNS } from '../audit-columns'
import type { AuditFilters, AuditRow, AuthEventFull } from '../types'

export const PAGE_SIZE = 50
const DATE = /^\d{4}-\d{2}-\d{2}$/

const clean = (v: string | undefined) => (v ?? '').replace(/[%,()*\\]/g, ' ').trim().slice(0, 80)
const dateOrNull = (v: string | undefined) => (v && DATE.test(v) ? v : null)

/**
 * Lecture du journal par la fonction audit_search (permission audit.read) : prix et coûts masqués ou cachés selon costs.read,
 * IP et navigateur absents. Le total vient de audit_count, avec les mêmes filtres.
 */
export async function queryAudit(f: AuditFilters, opts: { all?: boolean } = {}): Promise<{ rows: AuditRow[]; total: number }> {
  const supabase = await createClient()
  const page = Math.max(1, f.page ?? 1)
  const args = {
    p_scope: f.scope || null,
    p_actor: clean(f.actor) || null,
    p_from: dateOrNull(f.from),
    p_to: dateOrNull(f.to),
  }
  const limit = opts.all ? 5000 : PAGE_SIZE
  const offset = opts.all ? 0 : (page - 1) * PAGE_SIZE
  const [rows, count] = await Promise.all([
    supabase.rpc('audit_search', { ...args, p_limit: limit, p_offset: offset }),
    supabase.rpc('audit_count', args),
  ])
  if (rows.error) throw new Error(rows.error.message)
  if (count.error) throw new Error(count.error.message)
  return { rows: (rows.data ?? []) as AuditRow[], total: Number(count.data ?? 0) }
}

/** Journal des événements d'authentification (visibles avec audit.read). */
export async function queryAuthEvents(f: AuditFilters): Promise<{ rows: AuthEventFull[]; total: number }> {
  const supabase = await createClient()
  const page = Math.max(1, f.page ?? 1)
  let q = supabase.from('auth_events').select('*', { count: 'exact' }).order('created_at', { ascending: false }).order('id', { ascending: false })
  const actor = clean(f.actor)
  if (actor) q = q.ilike('email', `%${actor}%`)
  if (f.from && DATE.test(f.from)) q = q.gte('created_at', `${f.from}T00:00:00Z`)
  if (f.to && DATE.test(f.to)) q = q.lte('created_at', `${f.to}T23:59:59.999Z`)
  q = q.range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1)
  const { data, count, error } = await q
  if (error) throw new Error(error.message)
  return { rows: (data ?? []) as AuthEventFull[], total: count ?? 0 }
}

/** Dernières entrées d'audit concernant une entité (fiche utilisateur / rôle). Lecture directe, filtrée par les politiques RLS. */
export async function recentAuditFor(entityType: string, entityId: string, limit = 8): Promise<AuditRow[]> {
  const supabase = await createClient()
  const { data } = await supabase
    .from('audit_logs')
    .select(AUDIT_READ_COLUMNS)
    .eq('entity_type', entityType)
    .eq('entity_id', entityId)
    .order('created_at', { ascending: false })
    .limit(limit)
  return (data ?? []) as unknown as AuditRow[]
}

const esc = (v: unknown) => {
  const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
  // Neutralise l'injection de formules Excel (=, +, -, @) et échappe les guillemets
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
  return `"${safe.replace(/"/g, '""')}"`
}

/** Export auditeur : appelle audit_export (permission audit.export, journalisé par la base). */
export async function exportAuditRows(f: { scope?: string; from?: string; to?: string }): Promise<AuditRow[]> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('audit_export', {
    p_scope: f.scope || null,
    p_from: dateOrNull(f.from),
    p_to: dateOrNull(f.to),
    p_limit: 5000,
  })
  if (error) throw new Error(error.message)
  return (data ?? []) as unknown as AuditRow[]
}

export function auditToCsv(rows: AuditRow[]): string {
  const head = ['id', 'date_utc', 'acteur', 'type_acteur', 'pour_le_compte_de', 'action', 'entite', 'entite_id', 'libelle', 'avant', 'apres',
    'details', 'motif', 'significatif', 'correlation_id', 'version', 'source', 'ip', 'user_agent', 'perimetre']
  const lines = rows.map((r) =>
    [r.id, r.created_at, r.actor_email, r.actor_kind, r.on_behalf_of, r.action, r.entity_type, r.entity_id, r.entity_label, r.before_data, r.after_data,
      r.metadata, r.reason, r.significant, r.correlation_id, r.entity_version, r.source, r.ip, r.user_agent, r.scope]
      .map(esc)
      .join(','),
  )
  return '﻿' + [head.join(','), ...lines].join('\r\n')
}
