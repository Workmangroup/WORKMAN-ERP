import 'server-only'
import { createClient } from '@/lib/supabase/server'
import { certState, EXPIRY_WARN_DAYS, withSpec, type ChangeRow } from '@/lib/products/options'
import type { Product, ProductCert, ProductDocument, ProductFilters, ProductListRow, ProductPhoto, ProductVersion } from '../types'

export const PAGE_SIZE = 24
const clean = (v: string | undefined) => (v ?? '').replace(/[%,()*\\:"{}]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)

export async function listProducts(f: ProductFilters): Promise<{ rows: ProductListRow[]; total: number }> {
  const supabase = await createClient()
  const page = Math.max(1, f.page ?? 1)
  let q = supabase.from('product_master').select('*', { count: 'exact' })
  if (f.client) q = q.eq('client_id', f.client)
  if (f.family) q = q.eq('family', f.family)
  if (f.status && ['draft', 'active', 'archived'].includes(f.status)) q = q.eq('status', f.status)
  else if (f.status !== 'all') q = q.neq('status', 'archived')
  const term = clean(f.q)
  if (term) q = q.or(['code', 'name', 'description'].map((c) => `${c}.ilike.%${term}%`).join(','))
  q = q.order('code').range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1)
  const { data, count, error } = await q
  if (error) throw new Error(error.message)
  const products = (data ?? []) as Product[]
  const ids = products.map((p) => p.id)
  const clientIds = [...new Set(products.map((p) => p.client_id))]
  const verIds = products.map((p) => p.active_version_id ?? p.current_version_id).filter(Boolean) as string[]
  const [{ data: clients }, { data: vers }, { data: certs }] = await Promise.all([
    clientIds.length ? supabase.from('clients').select('id,name,code').in('id', clientIds) : Promise.resolve({ data: [] }),
    verIds.length ? supabase.from('product_versions').select('id,version_no,spec').in('id', verIds) : Promise.resolve({ data: [] }),
    ids.length ? supabase.from('product_certifications').select('product_id,status,valid_until').in('product_id', ids).limit(5000) : Promise.resolve({ data: [] }),
  ])
  const cm = new Map((clients ?? []).map((c) => [c.id as string, c as { name: string; code: string }]))
  const vm = new Map((vers ?? []).map((v) => [v.id as string, v as { version_no: number; spec: { variants?: unknown[] } }]))
  const alerts = new Map<string, number>()
  for (const c of certs ?? []) {
    const st = certState({ status: c.status as string, valid_until: (c.valid_until as string | null) ?? null })
    if (st === 'expired' || st === 'expiring' || st === 'suspended' || st === 'revoked') alerts.set(c.product_id as string, (alerts.get(c.product_id as string) ?? 0) + 1)
  }
  return {
    rows: products.map((p) => {
      const v = vm.get((p.active_version_id ?? p.current_version_id) as string)
      return { ...p, client_name: cm.get(p.client_id)?.name ?? '—', client_code: cm.get(p.client_id)?.code ?? '', version_no: v?.version_no ?? null, variant_count: v?.spec?.variants?.length ?? 0, cert_alerts: alerts.get(p.id) ?? 0 }
    }),
    total: count ?? 0,
  }
}

/** Indicateurs globaux du référentiel (liste des produits). */
export async function productStats(): Promise<{ total: number; active: number; draft: number; archived: number; certAlerts: number; expired: number; pendingDrafts: number }> {
  const supabase = await createClient()
  const [{ data: ps }, { data: certs }, { data: drafts }] = await Promise.all([
    supabase.from('product_master').select('status').limit(20000),
    supabase.from('product_certifications').select('product_id,status,valid_until').limit(20000),
    supabase.from('product_versions').select('id').eq('status', 'draft').gt('version_no', 1).limit(20000),
  ])
  const count = (s: string) => (ps ?? []).filter((p) => p.status === s).length
  let certAlerts = 0
  let expired = 0
  for (const c of certs ?? []) {
    const st = certState({ status: c.status as string, valid_until: (c.valid_until as string | null) ?? null })
    if (st === 'expired') { expired++; certAlerts++ } else if (st === 'expiring') certAlerts++
  }
  return { total: (ps ?? []).length, active: count('active'), draft: count('draft'), archived: count('archived'), certAlerts, expired, pendingDrafts: (drafts ?? []).length }
}

export async function getProduct(id: string): Promise<Product | null> {
  const supabase = await createClient()
  const { data } = await supabase.from('product_master').select('*').eq('id', id).maybeSingle()
  return (data as Product | null) ?? null
}

export async function listVersions(productId: string): Promise<ProductVersion[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('product_versions').select('*').eq('product_id', productId).order('version_no', { ascending: false })
  return ((data ?? []) as ProductVersion[]).map((v) => ({ ...v, spec: withSpec(v.spec) }))
}

export async function listPhotos(productId: string): Promise<ProductPhoto[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('product_photos').select('*').eq('product_id', productId).order('is_main', { ascending: false }).order('created_at')
  return (data ?? []) as ProductPhoto[]
}

export async function getPhoto(id: string): Promise<ProductPhoto | null> {
  const supabase = await createClient()
  const { data } = await supabase.from('product_photos').select('*').eq('id', id).maybeSingle()
  return (data as ProductPhoto | null) ?? null
}

/** Documents rattachés au produit (lien + informations GED ; visibles selon documents.read). */
export async function listProductDocuments(productId: string): Promise<ProductDocument[]> {
  const supabase = await createClient()
  const { data: links } = await supabase.from('product_documents').select('*').eq('product_id', productId).order('created_at', { ascending: false })
  const ids = (links ?? []).map((l) => l.ged_document_id as string)
  if (ids.length === 0) return []
  const { data: docs } = await supabase.from('ged_documents').select('id,client_id,title,status,version_count,file_name,mime_type,size_bytes,valid_until,deleted_at').in('id', ids)
  const dm = new Map((docs ?? []).map((d) => [d.id as string, d]))
  return (links ?? []).flatMap((l) => {
    const d = dm.get(l.ged_document_id as string)
    if (!d) return []        // document non visible (documents.read) : lien masqué
    return [{
      id: l.id as string, product_id: productId, ged_document_id: l.ged_document_id as string, kind: l.kind as string, revision: (l.revision as string | null) ?? null, note: (l.note as string | null) ?? null,
      created_at: l.created_at as string, title: d.title as string, file_name: (d.file_name as string | null) ?? null, mime_type: (d.mime_type as string | null) ?? null,
      size_bytes: d.size_bytes === null ? null : Number(d.size_bytes), status: d.status as string, valid_until: (d.valid_until as string | null) ?? null,
      version_count: Number(d.version_count), client_id: d.client_id as string,
    }]
  })
}

/** Documents du client pas encore rattachés à ce produit (pour en rattacher). */
export async function linkableDocuments(clientId: string, productId: string): Promise<{ id: string; title: string; folder_id: string }[]> {
  const supabase = await createClient()
  const [{ data: docs }, { data: linked }] = await Promise.all([
    supabase.from('ged_documents').select('id,title,folder_id').eq('client_id', clientId).is('deleted_at', null).order('title').limit(400),
    supabase.from('product_documents').select('ged_document_id').eq('product_id', productId),
  ])
  const done = new Set((linked ?? []).map((l) => l.ged_document_id as string))
  return ((docs ?? []) as { id: string; title: string; folder_id: string }[]).filter((d) => !done.has(d.id))
}

/** Documents du client (hors corbeille) proposés comme justificatif d'une certification. */
export async function clientDocOptions(clientId: string): Promise<{ id: string; title: string }[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('ged_documents').select('id,title').eq('client_id', clientId).is('deleted_at', null).order('title').limit(400)
  return (data ?? []) as { id: string; title: string }[]
}

export async function listCerts(productId: string): Promise<ProductCert[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('product_certifications').select('*').eq('product_id', productId).order('standard_code').order('valid_until')
  return (data ?? []) as ProductCert[]
}

/** Articles du client non liés à un autre produit. */
export async function articleChoices(clientId: string, productId: string): Promise<{ id: string; label: string }[]> {
  const supabase = await createClient()
  const [{ data: arts }, { data: taken }] = await Promise.all([
    supabase.from('articles').select('id,internal_ref,client_ref,name').eq('client_id', clientId).order('internal_ref').limit(500),
    supabase.from('product_master').select('article_id').not('article_id', 'is', null).neq('id', productId),
  ])
  const used = new Set((taken ?? []).map((t) => t.article_id as string))
  return (arts ?? []).filter((a) => !used.has(a.id as string)).map((a) => ({ id: a.id as string, label: `${a.internal_ref} — ${a.name} (${a.client_ref})` }))
}

export async function articleRef(articleId: string | null): Promise<{ id: string; internal_ref: string; name: string } | null> {
  if (!articleId) return null
  const supabase = await createClient()
  const { data } = await supabase.from('articles').select('id,internal_ref,name').eq('id', articleId).maybeSingle()
  return (data as { id: string; internal_ref: string; name: string } | null) ?? null
}

/** Nomenclature (BOM) de l'article lié : code, version active, identifiant pour l'arbre. */
export async function productBom(articleId: string | null): Promise<{ id: string; code: string; name: string; archived: boolean; active_version_id: string | null; active_version_no: number | null } | null> {
  if (!articleId) return null
  const supabase = await createClient()
  const { data } = await supabase.from('boms').select('id,code,name,archived_at,active_version_id').eq('article_id', articleId).order('archived_at', { ascending: false, nullsFirst: true }).limit(1).maybeSingle()
  if (!data) return null
  let no: number | null = null
  if (data.active_version_id) {
    const { data: v } = await supabase.from('bom_versions').select('version_no').eq('id', data.active_version_id as string).maybeSingle()
    no = (v?.version_no as number | undefined) ?? null
  }
  return { id: data.id as string, code: data.code as string, name: data.name as string, archived: Boolean(data.archived_at), active_version_id: (data.active_version_id as string | null) ?? null, active_version_no: no }
}

export interface Comparison {
  a: { id: string; version_no: number; status: string; validated_at: string | null; change_note: string | null }
  b: { id: string; version_no: number; status: string; validated_at: string | null; change_note: string | null }
  changes: ChangeRow[]
  summary: { added: number; removed: number; changed: number }
}
export async function compareVersions(a: string, b: string): Promise<Comparison | null> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('product_compare_versions', { p_a: a, p_b: b })
  if (error || !data) return null
  return data as Comparison
}

export { EXPIRY_WARN_DAYS }
