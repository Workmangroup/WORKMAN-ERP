import 'server-only'
import { createClient } from '@/lib/supabase/server'
import { directoryByIds, listSalesReps } from '@/features/clients/services/clients.service'

const num = (v: unknown) => Number(v ?? 0)
const clean = (v: string | undefined) => (v ?? '').replace(/[%,()*\\:"{}]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)
const day = (v: unknown) => (v ? String(v).slice(0, 10) : null)

export { listSalesReps }

async function clientNames(ids: (string | null)[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const uniq = [...new Set(ids.filter((x): x is string => !!x))]
  if (!uniq.length) return out
  const supabase = await createClient()
  const { data } = await supabase.from('clients').select('id,name').in('id', uniq)
  for (const c of data ?? []) out.set(c.id as string, c.name as string)
  return out
}

// ---------------------------------------------------------------------
// Prospects et pipeline
// ---------------------------------------------------------------------
export type Stage = 'new' | 'contacted' | 'qualified' | 'proposal' | 'negotiation' | 'won' | 'lost'
export const STAGES: Stage[] = ['new', 'contacted', 'qualified', 'proposal', 'negotiation', 'won', 'lost']
export interface ProspectRow {
  id: string; code: string; company_name: string; contact_name: string | null; email: string | null; phone: string | null; country: string | null; city: string | null
  source: string; stage: Stage; est_value: number; expected_close: string | null; owner_id: string | null; owner: string | null
  next_action: string | null; next_action_date: string | null; notes: string | null; lost_reason: string | null; converted_client_id: string | null; stage_changed_at: string; created_at: string
}

async function withOwners(rows: Record<string, unknown>[]): Promise<ProspectRow[]> {
  const owners = await directoryByIds(rows.map((r) => r.owner_id as string | null))
  return rows.map((r) => ({
    id: r.id as string, code: r.code as string, company_name: r.company_name as string, contact_name: (r.contact_name as string | null) ?? null, email: (r.email as string | null) ?? null,
    phone: (r.phone as string | null) ?? null, country: (r.country as string | null) ?? null, city: (r.city as string | null) ?? null, source: r.source as string, stage: r.stage as Stage,
    est_value: num(r.est_value), expected_close: day(r.expected_close), owner_id: (r.owner_id as string | null) ?? null, owner: r.owner_id ? (owners.get(r.owner_id as string)?.full_name ?? null) : null,
    next_action: (r.next_action as string | null) ?? null, next_action_date: day(r.next_action_date), notes: (r.notes as string | null) ?? null, lost_reason: (r.lost_reason as string | null) ?? null,
    converted_client_id: (r.converted_client_id as string | null) ?? null, stage_changed_at: r.stage_changed_at as string, created_at: r.created_at as string,
  }))
}

export async function listProspects(f: { q?: string; stage?: string; open?: boolean }): Promise<ProspectRow[]> {
  const supabase = await createClient()
  let q = supabase.from('prospects').select('*').order('created_at', { ascending: false }).limit(500)
  if (f.stage && (STAGES as string[]).includes(f.stage)) q = q.eq('stage', f.stage)
  if (f.open) q = q.not('stage', 'in', '(won,lost)')
  const term = clean(f.q)
  if (term) q = q.or(`company_name.ilike.%${term}%,contact_name.ilike.%${term}%,code.ilike.%${term}%,email.ilike.%${term}%`)
  const { data } = await q
  return withOwners(data ?? [])
}

export async function getProspect(id: string) {
  const supabase = await createClient()
  const { data: p } = await supabase.from('prospects').select('*').eq('id', id).maybeSingle()
  if (!p) return null
  const [{ data: acts }, { data: quotes }] = await Promise.all([
    supabase.from('prospect_activities').select('*').eq('prospect_id', id).order('happened_at', { ascending: false }).limit(100),
    supabase.from('quotes').select('id,code,status,total,currency,quote_date').or(`prospect_id.eq.${id}${p.converted_client_id ? `,client_id.eq.${p.converted_client_id}` : ''}`).order('quote_date', { ascending: false }).limit(50),
  ])
  const users = await directoryByIds((acts ?? []).map((a) => a.created_by as string | null))
  const [row] = await withOwners([p])
  return {
    prospect: row,
    activities: (acts ?? []).map((a) => ({ id: a.id as string, kind: a.kind as string, summary: a.summary as string, happened_at: a.happened_at as string, by: a.created_by ? (users.get(a.created_by as string)?.full_name ?? null) : null })),
    quotes: (quotes ?? []).map((x) => ({ id: x.id as string, code: x.code as string, status: x.status as string, total: num(x.total), currency: x.currency as string, quote_date: day(x.quote_date) })),
  }
}

// ---------------------------------------------------------------------
// Devis
// ---------------------------------------------------------------------
export type QuoteStatus = 'draft' | 'sent' | 'accepted' | 'rejected' | 'converted' | 'cancelled'
export interface QuoteRow {
  id: string; code: string; status: QuoteStatus; party: string; party_href: string | null; is_prospect: boolean; quote_date: string; valid_until: string
  currency: string; subtotal: number; total: number; order_id: string | null; expired: boolean
}
export async function listQuotes(f: { q?: string; status?: string }): Promise<QuoteRow[]> {
  const supabase = await createClient()
  let q = supabase.from('quotes').select('*').order('created_at', { ascending: false }).limit(300)
  if (f.status && ['draft', 'sent', 'accepted', 'rejected', 'converted', 'cancelled'].includes(f.status)) q = q.eq('status', f.status)
  const term = clean(f.q)
  if (term) q = q.or(`code.ilike.%${term}%,notes.ilike.%${term}%`)
  const { data } = await q
  const rows = data ?? []
  const [names, { data: pros }] = await Promise.all([
    clientNames(rows.map((r) => r.client_id as string | null)),
    supabase.from('prospects').select('id,company_name').in('id', rows.map((r) => r.prospect_id as string | null).filter((x): x is string => !!x).concat('00000000-0000-0000-0000-000000000000')),
  ])
  const pm = new Map((pros ?? []).map((p) => [p.id as string, p.company_name as string]))
  const today = new Date().toISOString().slice(0, 10)
  return rows.map((r) => ({
    id: r.id as string, code: r.code as string, status: r.status as QuoteStatus,
    party: r.client_id ? (names.get(r.client_id as string) ?? '—') : (pm.get(r.prospect_id as string) ?? '—'), is_prospect: Boolean(r.prospect_id),
    party_href: r.client_id ? `/clients/${r.client_id}` : r.prospect_id ? `/commercial/prospects/${r.prospect_id}` : null,
    quote_date: day(r.quote_date)!, valid_until: day(r.valid_until)!, currency: r.currency as string, subtotal: num(r.subtotal), total: num(r.total), order_id: (r.order_id as string | null) ?? null,
    expired: r.status === 'sent' && day(r.valid_until)! < today,
  }))
}

export interface DocLine { id: string; description: string; qty: number; unit_price: number; discount_pct: number; article_id?: string | null; extra?: string }
export async function getQuote(id: string) {
  const supabase = await createClient()
  const { data: q } = await supabase.from('quotes').select('*').eq('id', id).maybeSingle()
  if (!q) return null
  const [{ data: ls }, names, { data: pro }, { data: ord }] = await Promise.all([
    supabase.from('quote_lines').select('*').eq('quote_id', id).order('pos'),
    clientNames([q.client_id as string | null]),
    q.prospect_id ? supabase.from('prospects').select('id,company_name,code').eq('id', q.prospect_id as string).maybeSingle() : Promise.resolve({ data: null }),
    q.order_id ? supabase.from('sales_orders').select('id,code').eq('id', q.order_id as string).maybeSingle() : Promise.resolve({ data: null }),
  ])
  let articles: { id: string; ref: string; name: string }[] = []
  if (q.client_id && q.status === 'draft') {
    const { data } = await supabase.from('articles').select('id,internal_ref,name').eq('client_id', q.client_id as string).neq('status', 'discontinued').order('internal_ref')
    articles = (data ?? []).map((a) => ({ id: a.id as string, ref: a.internal_ref as string, name: a.name as string }))
  }
  return {
    quote: {
      id: q.id as string, code: q.code as string, status: q.status as QuoteStatus, client_id: (q.client_id as string | null) ?? null, prospect_id: (q.prospect_id as string | null) ?? null,
      quote_date: day(q.quote_date)!, valid_until: day(q.valid_until)!, currency: q.currency as string, tax_rate: num(q.tax_rate), payment_terms: (q.payment_terms as string | null) ?? null, lead_days: num(q.lead_days),
      notes: (q.notes as string | null) ?? null, subtotal: num(q.subtotal), tax_amount: num(q.tax_amount), total: num(q.total), sent_at: (q.sent_at as string | null) ?? null,
      decided_at: (q.decided_at as string | null) ?? null, decision_reason: (q.decision_reason as string | null) ?? null,
    },
    party: q.client_id ? { name: names.get(q.client_id as string) ?? '—', href: `/clients/${q.client_id}`, prospect: false } : { name: (pro?.company_name as string) ?? '—', href: `/commercial/prospects/${q.prospect_id}`, prospect: true },
    order: ord ? { id: ord.id as string, code: ord.code as string } : null,
    lines: (ls ?? []).map((l) => ({ id: l.id as string, description: l.description as string, qty: num(l.qty), unit_price: num(l.unit_price), discount_pct: num(l.discount_pct), article_id: (l.article_id as string | null) ?? null }) satisfies DocLine),
    articles,
  }
}

/** Historique immuable des versions envoyées ou acceptées (lecture seule, sous RLS). */
export async function listQuoteVersions(id: string): Promise<{ seq: number; label: string; recorded_at: string; content_hash: string }[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('quote_versions').select('seq,label,recorded_at,content_hash').eq('quote_id', id).order('seq')
  return (data ?? []) as { seq: number; label: string; recorded_at: string; content_hash: string }[]
}
export async function partyOptions(): Promise<{ clients: { id: string; name: string }[]; prospects: { id: string; name: string; code: string }[] }> {
  const supabase = await createClient()
  const [{ data: c }, { data: p }] = await Promise.all([
    supabase.from('clients').select('id,name').is('archived_at', null).order('name').limit(2000),
    supabase.from('prospects').select('id,company_name,code').not('stage', 'in', '(won,lost)').order('company_name').limit(2000),
  ])
  return { clients: (c ?? []) as { id: string; name: string }[], prospects: (p ?? []).map((x) => ({ id: x.id as string, name: x.company_name as string, code: x.code as string })) }
}

// ---------------------------------------------------------------------
// Factures, avoirs
// ---------------------------------------------------------------------
export type InvoiceStatus = 'draft' | 'issued' | 'partially_paid' | 'paid' | 'credited' | 'cancelled'
export interface InvoiceRow {
  id: string; code: string | null; status: InvoiceStatus; client_id: string; client_name: string; issue_date: string | null; due_date: string | null; currency: string
  subtotal: number; total: number; paid_amount: number; credited_amount: number; balance: number; overdue: boolean; order_id: string | null
}
export async function listInvoices(f: { q?: string; status?: string; client?: string; overdue?: boolean }): Promise<InvoiceRow[]> {
  const supabase = await createClient()
  let q = supabase.from('invoices').select('*').order('created_at', { ascending: false }).limit(300)
  if (f.status && ['draft', 'issued', 'partially_paid', 'paid', 'credited', 'cancelled'].includes(f.status)) q = q.eq('status', f.status)
  if (f.client && /^[0-9a-f-]{36}$/i.test(f.client)) q = q.eq('client_id', f.client)
  if (f.overdue) q = q.in('status', ['issued', 'partially_paid']).lt('due_date', new Date().toISOString().slice(0, 10))
  const term = clean(f.q)
  if (term) q = q.ilike('code', `%${term}%`)
  const { data } = await q
  const rows = data ?? []
  const names = await clientNames(rows.map((r) => r.client_id as string))
  const today = new Date().toISOString().slice(0, 10)
  return rows.map((r) => {
    const total = num(r.total), paid = num(r.paid_amount), cred = num(r.credited_amount)
    return { id: r.id as string, code: (r.code as string | null) ?? null, status: r.status as InvoiceStatus, client_id: r.client_id as string, client_name: names.get(r.client_id as string) ?? '—',
      issue_date: day(r.issue_date), due_date: day(r.due_date), currency: r.currency as string, subtotal: num(r.subtotal), total, paid_amount: paid, credited_amount: cred, balance: total - paid - cred,
      overdue: ['issued', 'partially_paid'].includes(r.status as string) && !!r.due_date && day(r.due_date)! < today, order_id: (r.order_id as string | null) ?? null }
  })
}

export async function getInvoice(id: string) {
  const supabase = await createClient()
  const { data: i } = await supabase.from('invoices').select('*').eq('id', id).maybeSingle()
  if (!i) return null
  const [{ data: ls }, { data: pays }, { data: cns }, names, { data: ord }] = await Promise.all([
    supabase.from('invoice_lines').select('*').eq('invoice_id', id).order('pos'),
    supabase.from('invoice_payments').select('*').eq('invoice_id', id).order('paid_on'),
    supabase.from('credit_notes').select('id,code,status,total,issue_date,reason').eq('invoice_id', id).order('created_at'),
    clientNames([i.client_id as string]),
    i.order_id ? supabase.from('sales_orders').select('id,code').eq('id', i.order_id as string).maybeSingle() : Promise.resolve({ data: null }),
  ])
  const total = num(i.total), paid = num(i.paid_amount), cred = num(i.credited_amount)
  return {
    invoice: { id: i.id as string, code: (i.code as string | null) ?? null, status: i.status as InvoiceStatus, client_id: i.client_id as string, client_name: names.get(i.client_id as string) ?? '—',
      issue_date: day(i.issue_date), due_date: day(i.due_date), currency: i.currency as string, tax_rate: num(i.tax_rate), payment_terms: (i.payment_terms as string | null) ?? null, notes: (i.notes as string | null) ?? null,
      subtotal: num(i.subtotal), tax_amount: num(i.tax_amount), total, paid_amount: paid, credited_amount: cred, balance: total - paid - cred, order_id: (i.order_id as string | null) ?? null },
    order: ord ? { id: ord.id as string, code: ord.code as string } : null,
    lines: (ls ?? []).map((l) => ({ id: l.id as string, description: l.description as string, qty: num(l.qty), unit_price: num(l.unit_price), discount_pct: num(l.discount_pct), extra: num(l.qty_credited) > 0 ? `${num(l.qty_credited)} crédité(s)` : undefined }) satisfies DocLine),
    payments: (pays ?? []).map((p) => ({ id: p.id as string, amount: num(p.amount), paid_on: day(p.paid_on)!, method: p.method as string, reference: (p.reference as string | null) ?? null })),
    credit_notes: (cns ?? []).map((c) => ({ id: c.id as string, code: (c.code as string | null) ?? null, status: c.status as string, total: num(c.total), issue_date: day(c.issue_date), reason: c.reason as string })),
  }
}

export interface CreditRow { id: string; code: string | null; status: 'draft' | 'issued' | 'cancelled'; invoice_id: string; invoice_code: string | null; client_name: string; issue_date: string | null; total: number; reason: string; currency: string }
export async function listCreditNotes(): Promise<CreditRow[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('credit_notes').select('*').order('created_at', { ascending: false }).limit(300)
  const rows = data ?? []
  const [names, { data: invs }] = await Promise.all([
    clientNames(rows.map((r) => r.client_id as string)),
    rows.length ? supabase.from('invoices').select('id,code').in('id', [...new Set(rows.map((r) => r.invoice_id as string))]) : Promise.resolve({ data: [] }),
  ])
  const im = new Map((invs ?? []).map((x) => [x.id as string, (x.code as string | null) ?? null]))
  return rows.map((r) => ({ id: r.id as string, code: (r.code as string | null) ?? null, status: r.status as CreditRow['status'], invoice_id: r.invoice_id as string, invoice_code: im.get(r.invoice_id as string) ?? null,
    client_name: names.get(r.client_id as string) ?? '—', issue_date: day(r.issue_date), total: num(r.total), reason: r.reason as string, currency: r.currency as string }))
}

export async function getCreditNote(id: string) {
  const supabase = await createClient()
  const { data: n } = await supabase.from('credit_notes').select('*').eq('id', id).maybeSingle()
  if (!n) return null
  const [{ data: ls }, { data: inv }, names] = await Promise.all([
    supabase.from('credit_note_lines').select('*').eq('credit_note_id', id).order('pos'),
    supabase.from('invoices').select('id,code,order_id').eq('id', n.invoice_id as string).maybeSingle(),
    clientNames([n.client_id as string]),
  ])
  return {
    note: { id: n.id as string, code: (n.code as string | null) ?? null, status: n.status as 'draft' | 'issued' | 'cancelled', reason: n.reason as string, issue_date: day(n.issue_date), currency: n.currency as string,
      tax_rate: num(n.tax_rate), subtotal: num(n.subtotal), tax_amount: num(n.tax_amount), total: num(n.total), reopen_order: Boolean(n.reopen_order), client_name: names.get(n.client_id as string) ?? '—' },
    invoice: inv ? { id: inv.id as string, code: (inv.code as string | null) ?? null, has_order: Boolean(inv.order_id) } : null,
    lines: (ls ?? []).map((l) => ({ id: l.id as string, description: l.description as string, qty: num(l.qty), unit_price: num(l.unit_price), discount_pct: num(l.discount_pct) }) satisfies DocLine),
  }
}

export async function clientOptions(): Promise<{ id: string; name: string }[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('clients').select('id,name').is('archived_at', null).order('name').limit(2000)
  return (data ?? []) as { id: string; name: string }[]
}

// ---------------------------------------------------------------------
// Tableau de bord
// ---------------------------------------------------------------------
export interface Dashboard {
  prospects?: { open_count: number; open_value: number; weighted_value: number; overdue_actions: number; won_90d: number; lost_90d: number; by_stage: { stage: Stage; count: number; value: number }[] }
  quotes?: { draft_count: number; sent_count: number; sent_value: number; expiring_7d: number; expired: number; won_90d_value: number; conversion_rate: number | null }
  orders?: { to_confirm: number; open_count: number; to_invoice_count: number; to_invoice_value: number }
  invoices?: { invoiced_month: number; invoiced_year: number; collected_month: number; outstanding: number; overdue_count: number; overdue_amount: number; drafts: number; credit_notes_year: number
    by_month: { month: string; amount: number }[]; top_clients: { client_id: string; name: string; amount: number }[] }
}
export async function getDashboard(): Promise<Dashboard | null> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('commercial_dashboard')
  if (error) return null
  return data as Dashboard
}
