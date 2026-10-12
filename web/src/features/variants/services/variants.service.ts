import 'server-only'
import { createClient } from '@/lib/supabase/server'
import type { CatalogColor, CatalogSize, MatrixData, OverviewRow } from '@/lib/variants/options'

export async function getMatrix(productId: string): Promise<MatrixData | null> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('variant_matrix', { p_product: productId })
  if (error || !data) return null
  const m = data as MatrixData
  return { ...m, variants: m.variants.map((v) => ({ ...v, price: v.price === null ? null : Number(v.price), on_hand: Number(v.on_hand), reserved: Number(v.reserved) })) }
}

export async function getOverview(): Promise<OverviewRow[]> {
  const supabase = await createClient()
  const { data } = await supabase.rpc('variant_overview')
  return (data ?? []) as OverviewRow[]
}

export async function listSizes(): Promise<CatalogSize[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('sizes').select('id,code,label,size_group,sort_order,active').order('sort_order').order('code')
  return (data ?? []) as CatalogSize[]
}
export async function listColors(): Promise<CatalogColor[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('colors').select('id,code,name,hex,pantone,active').order('name')
  return (data ?? []) as CatalogColor[]
}
/** Nombre de variantes qui utilisent chaque taille / couleur (suppression possible si 0). */
export async function catalogUsage(): Promise<{ sizes: Map<string, number>; colors: Map<string, number> }> {
  const supabase = await createClient()
  const { data } = await supabase.from('product_variants').select('color_id,size_id').limit(50000)
  const sizes = new Map<string, number>()
  const colors = new Map<string, number>()
  for (const v of data ?? []) {
    sizes.set(v.size_id as string, (sizes.get(v.size_id as string) ?? 0) + 1)
    colors.set(v.color_id as string, (colors.get(v.color_id as string) ?? 0) + 1)
  }
  return { sizes, colors }
}

/** Mouvements de stock récents des variantes d'un produit (avec SKU et entrepôt). */
export async function listMoves(productId: string, limit = 150): Promise<{ id: string; created_at: string; sku: string; warehouse: string; move_type: string; qty_delta: number; balance_after: number; reason: string | null; reference: string | null; by: string | null }[]> {
  const supabase = await createClient()
  const { data: vars } = await supabase.from('product_variants').select('id,sku').eq('product_id', productId)
  const ids = (vars ?? []).map((v) => v.id as string)
  if (ids.length === 0) return []
  const sku = new Map((vars ?? []).map((v) => [v.id as string, v.sku as string]))
  const { data: moves } = await supabase.from('variant_stock_moves').select('*').in('variant_id', ids).order('created_at', { ascending: false }).limit(limit)
  const whIds = [...new Set((moves ?? []).map((m) => m.warehouse_id as string))]
  const { data: whs } = whIds.length ? await supabase.from('warehouses').select('id,name').in('id', whIds) : { data: [] }
  const wn = new Map((whs ?? []).map((w) => [w.id as string, w.name as string]))
  const uids = [...new Set((moves ?? []).map((m) => m.created_by as string | null).filter(Boolean) as string[])]
  const { data: users } = uids.length ? await supabase.from('company_directory').select('id,full_name,email').in('id', uids) : { data: [] }
  const un = new Map((users ?? []).map((u) => [u.id as string, (u.full_name as string) || (u.email as string)]))
  return (moves ?? []).map((m) => ({
    id: m.id as string, created_at: m.created_at as string, sku: sku.get(m.variant_id as string) ?? '?', warehouse: wn.get(m.warehouse_id as string) ?? '—', move_type: m.move_type as string,
    qty_delta: Number(m.qty_delta), balance_after: Number(m.balance_after), reason: (m.reason as string | null) ?? null, reference: (m.reference as string | null) ?? null, by: m.created_by ? un.get(m.created_by as string) ?? null : null,
  }))
}

/** Nomenclatures produit proposables pour une variante : non archivées, du même client ou sans article. */
export async function bomChoices(clientId: string): Promise<{ id: string; code: string; name: string }[]> {
  const supabase = await createClient()
  const [{ data: boms }, { data: arts }] = await Promise.all([
    supabase.from('boms').select('id,code,name,article_id').eq('kind', 'product').is('archived_at', null).order('code').limit(500),
    supabase.from('articles').select('id').eq('client_id', clientId).limit(2000),
  ])
  const mine = new Set((arts ?? []).map((a) => a.id as string))
  return (boms ?? []).filter((b) => !b.article_id || mine.has(b.article_id as string)).map((b) => ({ id: b.id as string, code: b.code as string, name: b.name as string }))
}

/** Coût de revient actuel (matière + main-d'œuvre + frais) de la version validée de chaque nomenclature ; vide sans costs.read. */
export async function bomCosts(bomIds: string[]): Promise<Record<string, number>> {
  const ids = [...new Set(bomIds.filter(Boolean))]
  if (ids.length === 0) return {}
  const supabase = await createClient()
  const { data: boms } = await supabase.from('boms').select('id,active_version_id').in('id', ids)
  const out: Record<string, number> = {}
  for (const b of boms ?? []) {
    if (!b.active_version_id) continue
    const { data, error } = await supabase.rpc('bom_cost', { p_version: b.active_version_id as string })
    const total = (data as { live?: { total?: number } } | null)?.live?.total
    if (!error && typeof total === 'number') out[b.id as string] = total
  }
  return out
}
