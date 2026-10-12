import 'server-only'
import { createClient } from '@/lib/supabase/server'
import type { ChecklistItem } from '@/lib/development/options'
import type { DevAlert, DevDashboard, DevDocument, DevFilters, DevProject, DevProjectRow, Exchange, Industrialization, Prototype, ProtoCost, Sample, Validation } from '../types'

export const PAGE_SIZE = 24
const clean = (v: string | undefined) => (v ?? '').replace(/[%,()*\\:"{}]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)

async function decorate(projects: DevProject[]): Promise<DevProjectRow[]> {
  const supabase = await createClient()
  const clientIds = [...new Set(projects.map((p) => p.client_id))]
  const ownerIds = [...new Set(projects.map((p) => p.owner_id).filter(Boolean) as string[])]
  const ids = projects.map((p) => p.id)
  const [{ data: clients }, { data: owners }, { data: vals }] = await Promise.all([
    clientIds.length ? supabase.from('clients').select('id,name').in('id', clientIds) : Promise.resolve({ data: [] }),
    ownerIds.length ? supabase.from('company_directory').select('id,full_name').in('id', ownerIds) : Promise.resolve({ data: [] }),
    ids.length ? supabase.from('customer_validations').select('project_id,due_date,submitted_on').eq('status', 'pending').in('project_id', ids) : Promise.resolve({ data: [] }),
  ])
  const cm = new Map((clients ?? []).map((c) => [c.id as string, c.name as string]))
  const om = new Map((owners ?? []).map((o) => [o.id as string, o.full_name as string]))
  const today = new Date().toISOString().slice(0, 10)
  const pend = new Map<string, number>()
  const alerts = new Map<string, number>()
  for (const v of vals ?? []) {
    const pid = v.project_id as string
    pend.set(pid, (pend.get(pid) ?? 0) + 1)
    const due = (v.due_date as string | null)?.slice(0, 10)
    const late = due ? due <= new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10) : (v.submitted_on as string).slice(0, 10) <= new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10)
    if (late) alerts.set(pid, (alerts.get(pid) ?? 0) + 1)
  }
  return projects.map((p) => {
    const overdue = p.status === 'active' && p.stage !== 'production' && p.due_date && p.due_date.slice(0, 10) < today ? 1 : 0
    return { ...p, client_name: cm.get(p.client_id) ?? '—', owner_name: p.owner_id ? om.get(p.owner_id) ?? null : null, pending_validations: pend.get(p.id) ?? 0, open_alerts: (alerts.get(p.id) ?? 0) + overdue }
  })
}

export async function listProjects(f: DevFilters, opts: { all?: boolean } = {}): Promise<{ rows: DevProjectRow[]; total: number }> {
  const supabase = await createClient()
  const page = Math.max(1, f.page ?? 1)
  let q = supabase.from('development_projects').select('*', { count: 'exact' })
  if (f.client) q = q.eq('client_id', f.client)
  if (f.stage) q = q.eq('stage', f.stage)
  if (f.priority) q = q.eq('priority', f.priority)
  if (f.status && ['active', 'on_hold', 'cancelled', 'completed'].includes(f.status)) q = q.eq('status', f.status)
  else if (f.status !== 'all' && !opts.all) q = q.in('status', ['active', 'on_hold'])
  const term = clean(f.q)
  if (term) q = q.or(['code', 'name', 'description'].map((c) => `${c}.ilike.%${term}%`).join(','))
  q = q.order('priority', { ascending: false }).order('created_at', { ascending: false })
  q = opts.all ? q.limit(500) : q.range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1)
  const { data, count, error } = await q
  if (error) throw new Error(error.message)
  return { rows: await decorate((data ?? []) as DevProject[]), total: count ?? 0 }
}

export async function getProject(id: string): Promise<DevProject | null> {
  const supabase = await createClient()
  const { data } = await supabase.from('development_projects').select('*').eq('id', id).maybeSingle()
  return (data as DevProject | null) ?? null
}

export async function listPrototypes(projectId: string): Promise<Prototype[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('prototypes').select('*').eq('project_id', projectId).order('version_no', { ascending: false })
  return (data ?? []) as Prototype[]
}
/** Coûts : tableau vide sans droit (RLS) — l'interface masque alors la rubrique. */
export async function listCosts(projectId: string): Promise<ProtoCost[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('prototype_costs').select('id,prototype_id,kind,description,quantity,unit_cost,amount,incurred_on').eq('project_id', projectId).order('incurred_on', { ascending: false })
  return ((data ?? []) as Record<string, unknown>[]).map((c) => ({ ...(c as unknown as ProtoCost), quantity: Number(c.quantity), unit_cost: Number(c.unit_cost), amount: Number(c.amount) }))
}
export async function listSamples(projectId: string): Promise<Sample[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('samples').select('*').eq('project_id', projectId).order('version_no', { ascending: false })
  return (data ?? []) as Sample[]
}
export async function listValidations(projectId: string): Promise<Validation[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('customer_validations').select('*').eq('project_id', projectId).order('submitted_on', { ascending: false }).order('version_no', { ascending: false })
  return (data ?? []) as Validation[]
}
export async function getIndustrialization(projectId: string): Promise<Industrialization | null> {
  const supabase = await createClient()
  const { data } = await supabase.from('industrialization').select('*').eq('project_id', projectId).maybeSingle()
  return data ? ({ ...(data as unknown as Industrialization), checklist: ((data.checklist as ChecklistItem[]) ?? []) }) : null
}
export async function listExchanges(projectId: string): Promise<Exchange[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('development_exchanges').select('*').eq('project_id', projectId).order('exchanged_on', { ascending: false }).order('created_at', { ascending: false })
  return (data ?? []) as Exchange[]
}

export async function listProjectDocuments(projectId: string): Promise<DevDocument[]> {
  const supabase = await createClient()
  const { data: links } = await supabase.from('development_documents').select('*').eq('project_id', projectId).order('created_at', { ascending: false })
  const ids = (links ?? []).map((l) => l.ged_document_id as string)
  if (ids.length === 0) return []
  const { data: docs } = await supabase.from('ged_documents').select('id,client_id,title,status,version_count,file_name,mime_type,size_bytes,valid_until').in('id', ids)
  const dm = new Map((docs ?? []).map((d) => [d.id as string, d]))
  return (links ?? []).flatMap((l) => {
    const d = dm.get(l.ged_document_id as string)
    if (!d) return []
    return [{
      id: l.id as string, project_id: projectId, ged_document_id: l.ged_document_id as string, kind: l.kind as string, note: (l.note as string | null) ?? null, created_at: l.created_at as string,
      title: d.title as string, file_name: (d.file_name as string | null) ?? null, mime_type: (d.mime_type as string | null) ?? null, size_bytes: d.size_bytes === null ? null : Number(d.size_bytes),
      status: d.status as string, valid_until: (d.valid_until as string | null) ?? null, version_count: Number(d.version_count), client_id: d.client_id as string,
    }]
  })
}
export async function linkableDocuments(clientId: string, projectId: string): Promise<{ id: string; title: string; folder_id: string }[]> {
  const supabase = await createClient()
  const [{ data: docs }, { data: linked }] = await Promise.all([
    supabase.from('ged_documents').select('id,title,folder_id').eq('client_id', clientId).is('deleted_at', null).order('title').limit(400),
    supabase.from('development_documents').select('ged_document_id').eq('project_id', projectId),
  ])
  const done = new Set((linked ?? []).map((l) => l.ged_document_id as string))
  return ((docs ?? []) as { id: string; title: string; folder_id: string }[]).filter((d) => !done.has(d.id))
}

export async function ownerOptions(): Promise<{ id: string; name: string }[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('company_directory').select('id,full_name').order('full_name').limit(300)
  return (data ?? []).map((u) => ({ id: u.id as string, name: (u.full_name as string) || '—' }))
}
export async function productChoices(clientId: string): Promise<{ id: string; label: string }[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('product_master').select('id,code,name').eq('client_id', clientId).neq('status', 'archived').order('code').limit(500)
  return (data ?? []).map((p) => ({ id: p.id as string, label: `${p.code} — ${p.name}` }))
}
export async function bomChoices(clientId: string): Promise<{ id: string; label: string }[]> {
  const supabase = await createClient()
  const { data: arts } = await supabase.from('articles').select('id').eq('client_id', clientId).limit(1000)
  const ids = (arts ?? []).map((a) => a.id as string)
  if (ids.length === 0) return []
  const { data } = await supabase.from('boms').select('id,code,name').in('article_id', ids).is('archived_at', null).order('code')
  return (data ?? []).map((b) => ({ id: b.id as string, label: `${b.code} — ${b.name}` }))
}
export async function linkedProduct(productId: string | null): Promise<{ id: string; code: string; name: string; validated: boolean } | null> {
  if (!productId) return null
  const supabase = await createClient()
  const { data } = await supabase.from('product_master').select('id,code,name,active_version_id').eq('id', productId).maybeSingle()
  return data ? { id: data.id as string, code: data.code as string, name: data.name as string, validated: Boolean(data.active_version_id) } : null
}

export async function getAlerts(): Promise<DevAlert[]> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('development_alerts')
  if (error) return []
  return (data ?? []) as DevAlert[]
}
export async function getDashboard(): Promise<DevDashboard | null> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('development_dashboard')
  if (error) return null
  return data as DevDashboard
}
/** Validations en attente de tous les projets actifs (page « Validations »). */
export async function pendingValidations(): Promise<(Validation & { code: string; name: string; client_name: string })[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('customer_validations').select('*').eq('status', 'pending').order('due_date', { ascending: true, nullsFirst: false }).limit(300)
  const rows = (data ?? []) as Validation[]
  const ids = [...new Set(rows.map((r) => r.project_id))]
  if (ids.length === 0) return []
  const { data: projects } = await supabase.from('development_projects').select('id,code,name,client_id,status').in('id', ids)
  const cids = [...new Set((projects ?? []).map((p) => p.client_id as string))]
  const { data: clients } = cids.length ? await supabase.from('clients').select('id,name').in('id', cids) : { data: [] }
  const cm = new Map((clients ?? []).map((c) => [c.id as string, c.name as string]))
  const pm = new Map((projects ?? []).map((p) => [p.id as string, p]))
  return rows.flatMap((r) => {
    const p = pm.get(r.project_id)
    if (!p || p.status !== 'active') return []
    return [{ ...r, code: p.code as string, name: p.name as string, client_name: cm.get(p.client_id as string) ?? '—' }]
  })
}
