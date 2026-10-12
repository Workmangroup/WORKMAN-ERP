import 'server-only'
import { createClient } from '@/lib/supabase/server'
import type { Bom, BomFilters, BomListRow, BomVersion, CostResult, Material, MaterialRow, TreeNode, VersionCosting } from '../types'

export const PAGE_SIZE = 24
const clean = (v: string | undefined) => (v ?? '').replace(/[%,()*\\:"{}]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)

// ---------------------------------------------------------------------
// Nomenclatures
// ---------------------------------------------------------------------
export async function listBoms(f: BomFilters): Promise<{ rows: BomListRow[]; total: number }> {
  const supabase = await createClient()
  const page = Math.max(1, f.page ?? 1)
  let q = supabase.from('boms').select('*', { count: 'exact' })
  if (f.kind === 'product' || f.kind === 'subassembly') q = q.eq('kind', f.kind)
  if (f.state === 'archived') q = q.not('archived_at', 'is', null)
  else if (f.state !== 'all') q = q.is('archived_at', null)
  const term = clean(f.q)
  if (term) q = q.or(['code', 'name', 'description'].map((c) => `${c}.ilike.%${term}%`).join(','))
  q = q.order('code').range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1)
  const { data, count, error } = await q
  if (error) throw new Error(error.message)
  const boms = (data ?? []) as Bom[]

  const articles = new Map<string, { internal_ref: string; client_ref: string; client_id: string }>()
  const clients = new Map<string, string>()
  const artIds = [...new Set(boms.map((b) => b.article_id).filter((x): x is string => !!x))]
  if (artIds.length) {
    const { data: arts } = await supabase.from('articles').select('id,internal_ref,client_ref,client_id').in('id', artIds)
    for (const a of arts ?? []) articles.set(a.id as string, { internal_ref: a.internal_ref as string, client_ref: a.client_ref as string, client_id: a.client_id as string })
    const cids = [...new Set([...articles.values()].map((a) => a.client_id))]
    if (cids.length) {
      const { data: cl } = await supabase.from('clients').select('id,name').in('id', cids)
      for (const c of cl ?? []) clients.set(c.id as string, c.name as string)
    }
  }
  const activeIds = boms.map((b) => b.active_version_id).filter((x): x is string => !!x)
  const versionNo = new Map<string, number>()
  const cost = new Map<string, number | null>()
  if (activeIds.length) {
    const { data: vs } = await supabase.from('bom_versions').select('id,version_no').in('id', activeIds)
    for (const v of vs ?? []) versionNo.set(v.id as string, v.version_no as number)
    const { data: cs } = await supabase.from('bom_version_costs').select('version_id,snap_total').in('version_id', activeIds)   // vide sans costs.read (RLS)
    for (const c of cs ?? []) cost.set(c.version_id as string, c.snap_total === null ? null : Number(c.snap_total))
  }
  const shownIds = boms.map((b) => b.active_version_id ?? b.current_version_id).filter((x): x is string => !!x)
  const lineCount = new Map<string, number>()
  if (shownIds.length) {
    const { data: ls } = await supabase.from('bom_lines').select('version_id').in('version_id', shownIds).limit(10000)
    for (const l of ls ?? []) lineCount.set(l.version_id as string, (lineCount.get(l.version_id as string) ?? 0) + 1)
  }
  return {
    total: count ?? 0,
    rows: boms.map((b) => {
      const art = b.article_id ? articles.get(b.article_id) : undefined
      return {
        ...b,
        article_ref: art?.internal_ref ?? null,
        article_client_ref: art?.client_ref ?? null,
        client_name: art ? (clients.get(art.client_id) ?? null) : null,
        active_version_no: b.active_version_id ? (versionNo.get(b.active_version_id) ?? null) : null,
        cost_price: b.active_version_id ? (cost.get(b.active_version_id) ?? null) : null,
        line_count: lineCount.get(b.active_version_id ?? b.current_version_id ?? '') ?? 0,
      }
    }),
  }
}

export async function getBom(id: string): Promise<Bom | null> {
  const supabase = await createClient()
  const { data } = await supabase.from('boms').select('*').eq('id', id).maybeSingle()
  return (data as Bom | null) ?? null
}

export async function listVersions(bomId: string): Promise<BomVersion[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('bom_versions').select('*').eq('bom_id', bomId).order('version_no', { ascending: false })
  return (data ?? []) as BomVersion[]
}

/** Paramètres de coût des versions (vide sans costs.read). */
export async function versionCostings(versionIds: string[]): Promise<Map<string, VersionCosting>> {
  const out = new Map<string, VersionCosting>()
  if (!versionIds.length) return out
  const supabase = await createClient()
  const { data } = await supabase.from('bom_version_costs').select('version_id,hourly_rate,overhead_pct,snap_total,frozen_at').in('version_id', versionIds)
  for (const r of data ?? []) {
    out.set(r.version_id as string, {
      version_id: r.version_id as string, hourly_rate: Number(r.hourly_rate), overhead_pct: Number(r.overhead_pct),
      snap_total: r.snap_total === null ? null : Number(r.snap_total), frozen_at: (r.frozen_at as string | null) ?? null,
    })
  }
  return out
}

export async function getTree(versionId: string): Promise<TreeNode | null> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('bom_tree', { p_version: versionId })
  if (error) return null
  return data as TreeNode
}

/** Coût recalculé + coût figé ; null sans costs.read. */
export async function getCost(versionId: string): Promise<CostResult | null> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('bom_cost', { p_version: versionId })
  if (error) return null
  return data as CostResult
}

/** Nomenclatures qui utilisent celle-ci comme sous-ensemble (versions courante / validée des parents non archivés). */
export async function parentsOf(bomId: string): Promise<{ id: string; code: string; name: string }[]> {
  const supabase = await createClient()
  const { data: lines } = await supabase.from('bom_lines').select('bom_id,version_id').eq('child_bom_id', bomId).limit(500)
  const ids = [...new Set((lines ?? []).map((l) => l.bom_id as string))]
  if (!ids.length) return []
  const { data: parents } = await supabase.from('boms').select('id,code,name,archived_at,current_version_id,active_version_id').in('id', ids).is('archived_at', null)
  const live = new Set((lines ?? []).filter((l) => {
    const p = parents?.find((x) => x.id === l.bom_id)
    return p && (p.current_version_id === l.version_id || p.active_version_id === l.version_id)
  }).map((l) => l.bom_id as string))
  return (parents ?? []).filter((p) => live.has(p.id as string)).map((p) => ({ id: p.id as string, code: p.code as string, name: p.name as string })).sort((a, b) => a.code.localeCompare(b.code))
}

export interface ArticleOption { id: string; internal_ref: string; client_ref: string; name: string; client_name: string }

/** Articles sélectionnables : sans nomenclature active (sauf `keep`), client non archivé. */
export async function articleOptions(keep?: string | null): Promise<ArticleOption[]> {
  const supabase = await createClient()
  const [{ data: taken }, { data: arts }, { data: clients }] = await Promise.all([
    supabase.from('boms').select('article_id').not('article_id', 'is', null).is('archived_at', null),
    supabase.from('articles').select('id,internal_ref,client_ref,name,client_id,status').neq('status', 'discontinued').order('internal_ref').limit(2000),
    supabase.from('clients').select('id,name,archived_at').limit(2000),
  ])
  const used = new Set((taken ?? []).map((t) => t.article_id as string))
  const cl = new Map((clients ?? []).map((c) => [c.id as string, c as { name: string; archived_at: string | null }]))
  return (arts ?? [])
    .filter((a) => (!used.has(a.id as string) || a.id === keep) && (a.id === keep || !cl.get(a.client_id as string)?.archived_at))
    .map((a) => ({ id: a.id as string, internal_ref: a.internal_ref as string, client_ref: a.client_ref as string, name: a.name as string, client_name: cl.get(a.client_id as string)?.name ?? '' }))
}

/** Nomenclature rattachée à un article (fiche article). */
export async function bomOfArticle(articleId: string): Promise<{ id: string; code: string; name: string; archived: boolean; active_version_no: number | null } | null> {
  const supabase = await createClient()
  const { data } = await supabase.from('boms').select('id,code,name,archived_at,active_version_id').eq('article_id', articleId).order('archived_at', { ascending: false, nullsFirst: true }).limit(1).maybeSingle()
  if (!data) return null
  let no: number | null = null
  if (data.active_version_id) {
    const { data: v } = await supabase.from('bom_versions').select('version_no').eq('id', data.active_version_id as string).maybeSingle()
    no = (v?.version_no as number | undefined) ?? null
  }
  return { id: data.id as string, code: data.code as string, name: data.name as string, archived: Boolean(data.archived_at), active_version_no: no }
}

// ---------------------------------------------------------------------
// Composants
// ---------------------------------------------------------------------
export async function listMaterials(f: { q?: string; category?: string; state?: string; page?: number }): Promise<{ rows: MaterialRow[]; total: number }> {
  const supabase = await createClient()
  const page = Math.max(1, f.page ?? 1)
  let q = supabase.from('bom_materials').select('*', { count: 'exact' })
  if (f.category) q = q.eq('category', f.category)
  if (f.state === 'archived') q = q.not('archived_at', 'is', null)
  else if (f.state !== 'all') q = q.is('archived_at', null)
  const term = clean(f.q)
  if (term) q = q.or(['code', 'name', 'color', 'description'].map((c) => `${c}.ilike.%${term}%`).join(','))
  q = q.order('category').order('name').range((page - 1) * 30, page * 30 - 1)
  const { data, count, error } = await q
  if (error) throw new Error(error.message)
  const mats = (data ?? []) as Material[]
  const ids = mats.map((m) => m.id)

  const prices = new Map<string, number>()
  const usage = new Map<string, number>()
  const suppliers = new Map<string, string>()
  if (ids.length) {
    const [{ data: pr }, { data: ls }] = await Promise.all([
      supabase.from('bom_material_prices').select('material_id,unit_cost').in('material_id', ids),     // vide sans costs.read (RLS)
      supabase.from('bom_lines').select('material_id').in('material_id', ids).limit(10000),
    ])
    for (const p of pr ?? []) prices.set(p.material_id as string, Number(p.unit_cost))
    for (const l of ls ?? []) usage.set(l.material_id as string, (usage.get(l.material_id as string) ?? 0) + 1)
    const sids = [...new Set(mats.map((m) => m.supplier_id).filter((x): x is string => !!x))]
    if (sids.length) {
      const { data: ss } = await supabase.from('suppliers').select('id,name').in('id', sids)
      for (const s of ss ?? []) suppliers.set(s.id as string, s.name as string)
    }
  }
  return {
    total: count ?? 0,
    rows: mats.map((m) => ({ ...m, unit_cost: prices.get(m.id) ?? null, supplier_name: m.supplier_id ? (suppliers.get(m.supplier_id) ?? null) : null, usage_count: usage.get(m.id) ?? 0 })),
  }
}

export interface MaterialOption { id: string; code: string; name: string; unit: string; category: string; color: string | null; unit_cost: number | null }

/** Composants utilisables (non archivés) pour l'éditeur de lignes. */
export async function materialOptions(): Promise<MaterialOption[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('bom_materials').select('id,code,name,unit,category,color').is('archived_at', null).order('category').order('name').limit(3000)
  const ids = (data ?? []).map((m) => m.id as string)
  const prices = new Map<string, number>()
  if (ids.length) {
    const { data: pr } = await supabase.from('bom_material_prices').select('material_id,unit_cost').in('material_id', ids).limit(5000)
    for (const p of pr ?? []) prices.set(p.material_id as string, Number(p.unit_cost))
  }
  return (data ?? []).map((m) => ({ id: m.id as string, code: m.code as string, name: m.name as string, unit: m.unit as string, category: m.category as string, color: (m.color as string | null) ?? null, unit_cost: prices.get(m.id as string) ?? null }))
}

/** Nomenclatures utilisables comme sous-ensemble : non archivées, avec une version validée, hors `exclude`. */
export async function subassemblyOptions(exclude: string): Promise<{ id: string; code: string; name: string; kind: string }[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('boms').select('id,code,name,kind').is('archived_at', null).not('active_version_id', 'is', null).neq('id', exclude).order('code').limit(1000)
  return (data ?? []) as { id: string; code: string; name: string; kind: string }[]
}

export async function supplierOptions(): Promise<{ id: string; name: string }[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('suppliers').select('id,name').is('archived_at', null).order('name').limit(1000)
  return (data ?? []) as { id: string; name: string }[]
}
