import 'server-only'
import { createClient } from '@/lib/supabase/server'

export interface OrderRow {
  id: string
  code: string
  client_id: string
  client_name: string
  client_ref: string | null
  status: 'draft' | 'confirmed' | 'delivered' | 'cancelled'
  order_date: string
  notes: string | null
  created_at: string
  line_count: number
  total_qty: number
  next_due: string | null
  currency: string
  tax_rate: number
  subtotal: number
  tax_amount: number
  total: number
  invoice_status: 'none' | 'partial' | 'full'
  quote_id: string | null
  quote_code: string | null
}
export interface OrderLine {
  id: string
  article_id: string | null
  description: string | null
  unit_price: number
  discount_pct: number
  qty_invoiced: number
  article_ref: string
  article_name: string
  qty: number
  due_date: string
  note: string | null
  has_bom: boolean
}

const commercialFields = (r: Record<string, unknown>) => ({
  currency: (r.currency as string) ?? 'EUR', tax_rate: Number(r.tax_rate ?? 0), subtotal: Number(r.subtotal ?? 0), tax_amount: Number(r.tax_amount ?? 0), total: Number(r.total ?? 0),
  invoice_status: ((r.invoice_status as string) ?? 'none') as OrderRow['invoice_status'], quote_id: (r.quote_id as string | null) ?? null,
})

export async function listOrders(f: { status?: string; q?: string }): Promise<OrderRow[]> {
  const supabase = await createClient()
  let q = supabase.from('sales_orders').select('*').order('created_at', { ascending: false }).limit(300)
  if (f.status && ['draft', 'confirmed', 'delivered', 'cancelled'].includes(f.status)) q = q.eq('status', f.status)
  const term = (f.q ?? '').replace(/[%,()*\\:"{}]/g, ' ').trim().slice(0, 60)
  if (term) q = q.or(`code.ilike.%${term}%,client_ref.ilike.%${term}%`)
  const { data } = await q
  const rows = data ?? []
  const cids = [...new Set(rows.map((r) => r.client_id as string))]
  const [{ data: cl }, { data: lines }] = await Promise.all([
    cids.length ? supabase.from('clients').select('id,name').in('id', cids) : Promise.resolve({ data: [] }),
    rows.length ? supabase.from('sales_order_lines').select('order_id,qty,due_date').in('order_id', rows.map((r) => r.id as string)).limit(20000) : Promise.resolve({ data: [] }),
  ])
  const cm = new Map((cl ?? []).map((c) => [c.id as string, c.name as string]))
  const agg = new Map<string, { n: number; qty: number; due: string | null }>()
  for (const l of lines ?? []) {
    const a = agg.get(l.order_id as string) ?? { n: 0, qty: 0, due: null }
    a.n++; a.qty += Number(l.qty); if (!a.due || (l.due_date as string) < a.due) a.due = l.due_date as string
    agg.set(l.order_id as string, a)
  }
  return rows.map((r) => ({
    id: r.id as string, code: r.code as string, client_id: r.client_id as string, client_name: cm.get(r.client_id as string) ?? '—', client_ref: (r.client_ref as string | null) ?? null,
    status: r.status as OrderRow['status'], order_date: r.order_date as string, notes: (r.notes as string | null) ?? null, created_at: r.created_at as string,
    line_count: agg.get(r.id as string)?.n ?? 0, total_qty: agg.get(r.id as string)?.qty ?? 0, next_due: agg.get(r.id as string)?.due ?? null,
    ...commercialFields(r), quote_code: null,
  }))
}

export async function getOrder(id: string): Promise<{ order: OrderRow; lines: OrderLine[]; articles: { id: string; ref: string; name: string; status: string }[] } | null> {
  const supabase = await createClient()
  const { data: o } = await supabase.from('sales_orders').select('*').eq('id', id).maybeSingle()
  if (!o) return null
  const [{ data: cl }, { data: lines }, { data: arts }, { data: boms }] = await Promise.all([
    supabase.from('clients').select('name').eq('id', o.client_id as string).maybeSingle(),
    supabase.from('sales_order_lines').select('*').eq('order_id', id).order('due_date'),
    supabase.from('articles').select('id,internal_ref,name,status').eq('client_id', o.client_id as string).neq('status', 'discontinued').order('internal_ref'),
    supabase.from('boms').select('article_id').not('article_id', 'is', null).not('active_version_id', 'is', null).is('archived_at', null),
  ])
  const am = new Map((arts ?? []).map((a) => [a.id as string, a]))
  const hb = new Set((boms ?? []).map((b) => b.article_id as string))
  const ls: OrderLine[] = (lines ?? []).map((l) => ({
    id: l.id as string, article_id: (l.article_id as string | null) ?? null, description: (l.description as string | null) ?? null,
    unit_price: Number(l.unit_price ?? 0), discount_pct: Number(l.discount_pct ?? 0), qty_invoiced: Number(l.qty_invoiced ?? 0),
    article_ref: l.article_id ? ((am.get(l.article_id as string)?.internal_ref as string) ?? '?') : '', article_name: l.article_id ? ((am.get(l.article_id as string)?.name as string) ?? '—') : ((l.description as string | null) ?? '—'),
    qty: Number(l.qty), due_date: l.due_date as string, note: (l.note as string | null) ?? null, has_bom: l.article_id ? hb.has(l.article_id as string) : true,
  }))
  let quoteCode: string | null = null
  if (o.quote_id) { const { data: q } = await supabase.from('quotes').select('code').eq('id', o.quote_id as string).maybeSingle(); quoteCode = (q?.code as string | null) ?? null }
  return {
    order: { id: o.id as string, code: o.code as string, client_id: o.client_id as string, client_name: (cl?.name as string) ?? '—', client_ref: (o.client_ref as string | null) ?? null, status: o.status as OrderRow['status'],
      order_date: o.order_date as string, notes: (o.notes as string | null) ?? null, created_at: o.created_at as string, line_count: ls.length, total_qty: ls.reduce((a, l) => a + l.qty, 0), next_due: ls[0]?.due_date ?? null, ...commercialFields(o), quote_code: quoteCode },
    lines: ls,
    articles: (arts ?? []).map((a) => ({ id: a.id as string, ref: a.internal_ref as string, name: a.name as string, status: a.status as string })),
  }
}

export async function clientOptions(): Promise<{ id: string; name: string; code: string }[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('clients').select('id,name,code').is('archived_at', null).order('name').limit(2000)
  return (data ?? []) as { id: string; name: string; code: string }[]
}
