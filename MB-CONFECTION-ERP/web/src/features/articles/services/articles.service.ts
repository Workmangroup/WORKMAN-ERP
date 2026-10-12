import 'server-only'
import { createClient } from '@/lib/supabase/server'
import type { Article, ArticleFilters, ArticleListRow, ArticlePhoto, ArticleVersion, LinkedDocument } from '../types'

export const PAGE_SIZE = 24
const clean = (v: string | undefined) => (v ?? '').replace(/[%,()*\\:"{}]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)

export async function listArticles(f: ArticleFilters): Promise<{ rows: ArticleListRow[]; total: number }> {
  const supabase = await createClient()
  const page = Math.max(1, f.page ?? 1)
  let q = supabase.from('articles').select('*', { count: 'exact' })
  if (f.client) q = q.eq('client_id', f.client)
  if (f.family) q = q.eq('family', f.family)
  if (f.status && ['draft', 'active', 'discontinued'].includes(f.status)) q = q.eq('status', f.status)
  const norm = clean(f.norm).toUpperCase()
  if (norm) q = q.contains('norm_codes', [norm])
  const term = clean(f.q)
  if (term) q = q.or(['internal_ref', 'client_ref', 'name', 'description'].map((c) => `${c}.ilike.%${term}%`).join(','))
  q = q.order('internal_ref').range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1)
  const { data, count, error } = await q
  if (error) throw new Error(error.message)
  const articles = (data ?? []) as Article[]

  const names = new Map<string, { name: string; code: string }>()
  const ids = [...new Set(articles.map((a) => a.client_id))]
  if (ids.length) {
    const { data: clients } = await supabase.from('clients').select('id,name,code').in('id', ids)
    for (const c of clients ?? []) names.set(c.id as string, { name: c.name as string, code: c.code as string })
  }
  return { rows: articles.map((a) => ({ ...a, client_name: names.get(a.client_id)?.name ?? '—', client_code: names.get(a.client_id)?.code ?? '' })), total: count ?? 0 }
}

/** Valeurs distinctes des normes présentes (filtre). */
export async function normFacets(): Promise<string[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('articles').select('norm_codes').limit(5000)
  return [...new Set((data ?? []).flatMap((r) => (r.norm_codes as string[]) ?? []))].sort()
}

export async function getArticle(id: string): Promise<Article | null> {
  const supabase = await createClient()
  const { data } = await supabase.from('articles').select('*').eq('id', id).maybeSingle()
  return (data as Article | null) ?? null
}

export async function listVersions(articleId: string): Promise<ArticleVersion[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('article_versions').select('*').eq('article_id', articleId).order('version_no', { ascending: false })
  return (data ?? []) as ArticleVersion[]
}

export async function listPhotos(articleId: string): Promise<ArticlePhoto[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('article_photos').select('*').eq('article_id', articleId).order('is_main', { ascending: false }).order('created_at')
  return (data ?? []) as ArticlePhoto[]
}

export async function getPhoto(id: string): Promise<ArticlePhoto | null> {
  const supabase = await createClient()
  const { data } = await supabase.from('article_photos').select('*').eq('id', id).maybeSingle()
  return (data as ArticlePhoto | null) ?? null
}

/** Documents de la GED rattachés à l'article (hors corbeille). */
export async function linkedDocuments(articleId: string): Promise<LinkedDocument[]> {
  const supabase = await createClient()
  const { data } = await supabase
    .from('ged_documents')
    .select('id,client_id,title,status,version_count,file_name,mime_type,size_bytes,valid_until,folder_id,updated_at')
    .eq('article_id', articleId)
    .is('deleted_at', null)
    .order('updated_at', { ascending: false })
  return (data ?? []) as LinkedDocument[]
}

/** Documents du client non rattachés à un article (pour en rattacher). */
export async function unlinkedClientDocuments(clientId: string): Promise<{ id: string; title: string; folder_id: string }[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('ged_documents').select('id,title,folder_id').eq('client_id', clientId).is('deleted_at', null).is('article_id', null).order('title').limit(300)
  return (data ?? []) as { id: string; title: string; folder_id: string }[]
}

/** Articles d'un client (rattachement GED, fiche client). */
export async function clientArticles(clientId: string): Promise<{ id: string; internal_ref: string; client_ref: string; name: string; status: string }[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('articles').select('id,internal_ref,client_ref,name,status').eq('client_id', clientId).order('internal_ref').limit(500)
  return (data ?? []) as { id: string; internal_ref: string; client_ref: string; name: string; status: string }[]
}

export async function listClientsLite(): Promise<{ id: string; name: string; code: string; archived_at: string | null }[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('clients').select('id,name,code,archived_at').order('name').limit(2000)
  return (data ?? []) as { id: string; name: string; code: string; archived_at: string | null }[]
}

export async function getClientLite(id: string): Promise<{ id: string; name: string; code: string; archived_at: string | null } | null> {
  const supabase = await createClient()
  const { data } = await supabase.from('clients').select('id,name,code,archived_at').eq('id', id).maybeSingle()
  return (data as { id: string; name: string; code: string; archived_at: string | null } | null) ?? null
}
