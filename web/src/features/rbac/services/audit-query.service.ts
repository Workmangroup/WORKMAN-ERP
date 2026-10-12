import 'server-only'
import { createClient } from '@/lib/supabase/server'
import type { AuditFilters, AuditRow, AuthEventFull } from '../types'

export const PAGE_SIZE = 50
const DATE = /^\d{4}-\d{2}-\d{2}$/

const clean = (v: string | undefined) => (v ?? '').replace(/[%,()*\\]/g, ' ').trim().slice(0, 80)

/** Interroge audit_logs (la RLS exige la permission audit.read). */
export async function queryAudit(f: AuditFilters, opts: { all?: boolean } = {}): Promise<{ rows: AuditRow[]; total: number }> {
  const supabase = await createClient()
  const page = Math.max(1, f.page ?? 1)
  let q = supabase.from('audit_logs').select('*', { count: 'exact' }).order('created_at', { ascending: false }).order('id', { ascending: false })

  if (f.scope) q = f.scope.endsWith('.') ? q.like('action', `${f.scope.replace(/[^a-z_.]/g, '')}%`) : q.eq('action', f.scope)
  const actor = clean(f.actor)
  if (actor) q = q.or(`actor_email.ilike.%${actor}%,entity_label.ilike.%${actor}%`)
  if (f.from && DATE.test(f.from)) q = q.gte('created_at', `${f.from}T00:00:00Z`)
  if (f.to && DATE.test(f.to)) q = q.lte('created_at', `${f.to}T23:59:59.999Z`)

  q = opts.all ? q.range(0, 4999) : q.range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1)
  const { data, count, error } = await q
  if (error) throw new Error(error.message)
  return { rows: (data ?? []) as AuditRow[], total: count ?? 0 }
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

/** Dernières entrées d'audit concernant une entité (fiche utilisateur / rôle). */
export async function recentAuditFor(entityType: string, entityId: string, limit = 8): Promise<AuditRow[]> {
  const supabase = await createClient()
  const { data } = await supabase
    .from('audit_logs')
    .select('*')
    .eq('entity_type', entityType)
    .eq('entity_id', entityId)
    .order('created_at', { ascending: false })
    .limit(limit)
  return (data ?? []) as AuditRow[]
}

const esc = (v: unknown) => {
  const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
  // Neutralise l'injection de formules Excel (=, +, -, @) et échappe les guillemets
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
  return `"${safe.replace(/"/g, '""')}"`
}

export function auditToCsv(rows: AuditRow[]): string {
  const head = ['id', 'date_utc', 'acteur', 'action', 'entite', 'entite_id', 'libelle', 'avant', 'apres', 'details', 'source', 'ip', 'user_agent']
  const lines = rows.map((r) =>
    [r.id, r.created_at, r.actor_email, r.action, r.entity_type, r.entity_id, r.entity_label, r.before_data, r.after_data, r.metadata, r.source, r.ip, r.user_agent]
      .map(esc)
      .join(','),
  )
  return '﻿' + [head.join(','), ...lines].join('\r\n')
}
