import 'server-only'
import { createClient } from '@/lib/supabase/server'
import { recentAuditFor } from '@/features/rbac/services/audit-query.service'

/** Données de la fiche Client 360°. Chaque lecture passe par la session : la RLS fait foi. */

export interface OrderLite { id: string; code: string; status: string; order_date: string; client_ref: string | null }
export interface InvoiceLite { id: string; code: string | null; status: string; issue_date: string | null; due_date: string | null; total: number; paid_amount: number; credited_amount: number }
export interface BomLite { id: string; code: string; name: string; article: string; version_no: number | null; version_status: string | null }
export interface ComplaintLite { id: string; number: string; subject: string; severity: string; status: string; created_at: string; resolution: string | null; order_id: string | null }
export interface ActivityLite { at: string; kind: 'order' | 'invoice' | 'complaint'; label: string }

const num = (v: unknown) => Number(v ?? 0)

export async function clientOrders(clientId: string): Promise<OrderLite[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('sales_orders').select('id,code,status,order_date,client_ref').eq('client_id', clientId).order('order_date', { ascending: false }).limit(100)
  return (data ?? []) as OrderLite[]
}

export async function clientInvoices(clientId: string): Promise<InvoiceLite[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('invoices').select('id,code,status,issue_date,due_date,total,paid_amount,credited_amount')
    .eq('client_id', clientId).order('issue_date', { ascending: false, nullsFirst: false }).limit(100)
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    id: r.id as string, code: (r.code as string | null) ?? null, status: r.status as string, issue_date: (r.issue_date as string | null) ?? null,
    due_date: (r.due_date as string | null) ?? null, total: num(r.total), paid_amount: num(r.paid_amount), credited_amount: num(r.credited_amount),
  }))
}

/** Nomenclatures des articles du client : BOM, article, dernière version et son statut. */
export async function clientBoms(clientId: string): Promise<BomLite[]> {
  const supabase = await createClient()
  const { data: arts } = await supabase.from('articles').select('id,internal_ref,name').eq('client_id', clientId)
  const articles = (arts ?? []) as { id: string; internal_ref: string; name: string }[]
  if (articles.length === 0) return []
  const { data: boms } = await supabase.from('boms').select('id,code,name,article_id,current_version_id').in('article_id', articles.map((a) => a.id))
  const list = (boms ?? []) as { id: string; code: string; name: string; article_id: string; current_version_id: string | null }[]
  const versionIds = list.map((b) => b.current_version_id).filter((x): x is string => Boolean(x))
  const { data: vers } = versionIds.length ? await supabase.from('bom_versions').select('id,version_no,status').in('id', versionIds) : { data: [] }
  const vm = new Map(((vers ?? []) as { id: string; version_no: number; status: string }[]).map((v) => [v.id, v]))
  const am = new Map(articles.map((a) => [a.id, a]))
  return list.map((b) => {
    const v = b.current_version_id ? vm.get(b.current_version_id) : undefined
    const a = am.get(b.article_id)
    return { id: b.id, code: b.code, name: b.name, article: a ? `${a.internal_ref} ${a.name}` : '—', version_no: v?.version_no ?? null, version_status: v?.status ?? null }
  })
}

export async function clientComplaints(clientId: string): Promise<ComplaintLite[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('client_complaints').select('id,number,subject,severity,status,created_at,resolution,order_id')
    .eq('client_id', clientId).order('created_at', { ascending: false }).limit(100)
  return (data ?? []) as ComplaintLite[]
}

/** Performance commerciale : 12 mois de facturation, nombre de commandes, taux de transformation des devis. */
export async function clientPerformance(clientId: string) {
  const supabase = await createClient()
  const from = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 11, 1)).toISOString().slice(0, 10)
  const [inv, orders, quotes] = await Promise.all([
    supabase.from('invoices').select('total,status,issue_date').eq('client_id', clientId).gte('issue_date', from).in('status', ['issued', 'partially_paid', 'paid']),
    supabase.from('sales_orders').select('id,order_date').eq('client_id', clientId).gte('order_date', from),
    supabase.from('quotes').select('id,status').eq('client_id', clientId),
  ])
  const invoiced = ((inv.data ?? []) as { total: number }[]).reduce((s, r) => s + num(r.total), 0)
  const orderCount = (orders.data ?? []).length
  const q = (quotes.data ?? []) as { status: string }[]
  const won = q.filter((x) => x.status === 'accepted' || x.status === 'converted').length
  const decided = q.filter((x) => ['accepted', 'converted', 'rejected'].includes(x.status)).length
  return {
    invoiced12m: invoiced,
    orders12m: orderCount,
    avgOrder: orderCount ? invoiced / orderCount : null,
    quotes: q.length,
    winRate: decided ? Math.round((100 * won) / decided) : null,
  }
}

/** Marge : même calcul que le copilote (coût standard BOM). Vide si les droits ne le permettent pas. */
export async function clientMargin(clientId: string) {
  const supabase = await createClient()
  const { data } = await supabase.rpc('copilot_client_profit', { p_months: 12 })
  const row = ((data ?? []) as Record<string, unknown>[]).find((r) => r.client_id === clientId)
  if (!row) return null
  return {
    invoiced: num(row.invoiced), credited: num(row.credited), net: num(row.net_revenue), open: num(row.open_balance), overdue: num(row.overdue_balance),
    margin: row.margin === null ? null : num(row.margin),
    marginPct: row.margin_pct === null ? null : num(row.margin_pct),
    coverage: row.cost_coverage_pct === null ? null : num(row.cost_coverage_pct),
  }
}

/** Activité récente : commandes, factures, réclamations et évènements de traçabilité, du plus récent au plus ancien. */
export async function clientActivity(clientId: string): Promise<ActivityLite[]> {
  const [orders, invoices, complaints, audit] = await Promise.all([
    clientOrders(clientId), clientInvoices(clientId), clientComplaints(clientId), recentAuditFor('client', clientId, 15),
  ])
  const items: ActivityLite[] = [
    ...orders.slice(0, 10).map((o) => ({ at: o.order_date, kind: 'order' as const, label: `Commande ${o.code} · ${o.status}` })),
    ...invoices.slice(0, 10).filter((i) => i.issue_date).map((i) => ({ at: i.issue_date as string, kind: 'invoice' as const, label: `Facture ${i.code ?? '(brouillon)'} · ${i.status}` })),
    ...complaints.slice(0, 10).map((c) => ({ at: c.created_at, kind: 'complaint' as const, label: `Réclamation ${c.number} · ${c.subject}` })),
    ...audit.map((a) => ({ at: a.created_at, kind: 'complaint' as const, label: `${a.action}${a.entity_label ? ` · ${a.entity_label}` : ''}` })),
  ]
  return items.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 25)
}
