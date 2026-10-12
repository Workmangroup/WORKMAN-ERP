import 'server-only'
import type { createClient } from '@/lib/supabase/server'
import { linearTrend } from '@/features/copilot/engine/forecast'
import { P } from '@/lib/rbac/permissions'
import { daysBetween, emptyFacts, type ClientFact, type ArticleFact, type Facts } from '@/lib/strategy/engine'

/**
 * Collecte les faits pour le moteur de recommandations, avec les droits de l'utilisateur (RLS + fonctions contrôlées).
 * Une source sans droit n'est pas lue : elle est signalée dans `missing`. Rien n'est inventé.
 */
type Supabase = Awaited<ReturnType<typeof createClient>>

const iso = (d: Date) => d.toISOString().slice(0, 10)
const monthStart = (base: Date, back: number) => iso(new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - back, 1)))
const monthKey = (d: string) => d.slice(0, 7)

async function safe<T>(fn: () => PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T | null> {
  try {
    const { data, error } = await fn()
    return error ? null : data
  } catch {
    return null
  }
}

/** Relation embarquée : PostgREST renvoie un objet ou un tableau selon la cardinalité. */
const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null))

interface InvoiceRow { client_id: string; total: number; issue_date: string }
interface LineRow { article_id: string; qty: number; sales_orders: { client_id: string; order_date: string } | { client_id: string; order_date: string }[] | null }

export async function buildStrategyFacts(supabase: Supabase, perms: string[]): Promise<{ facts: Facts; missing: string[] }> {
  const asOf = iso(new Date())
  const base = new Date(`${asOf}T00:00:00Z`)
  const from12 = monthStart(base, 11)
  const from3 = monthStart(base, 2)
  const from6 = monthStart(base, 5)
  const has = (p: string) => perms.includes(p)
  const missing: string[] = []
  const facts = emptyFacts(asOf)

  /* --- Commercial, finance client, produits, prévision --- */
  if (has(P.INVOICES_READ) && has(P.CLIENTS_READ)) {
    const [clients, invoices, lines, articles, clientProfit, productProfit] = await Promise.all([
      safe(() => supabase.from('clients').select('id,name').is('archived_at', null)),
      safe(() => supabase.from('invoices').select('client_id,total,issue_date').in('status', ['issued', 'partially_paid', 'paid']).gte('issue_date', from12)),
      safe(() => supabase.from('sales_order_lines').select('article_id,qty,sales_orders!inner(client_id,order_date)').gte('sales_orders.order_date', from12)),
      safe(() => supabase.from('articles').select('id,name,family')),
      safe(() => supabase.rpc('copilot_client_profit', { p_months: 12 })),
      safe(() => supabase.rpc('copilot_product_profit', { p_months: 12 })),
    ])
    const invs = (invoices ?? []) as InvoiceRow[]
    const lns = (lines ?? []) as LineRow[]
    const familyOf = new Map(((articles ?? []) as { id: string; family: string }[]).map((a) => [a.id, a.family]))
    const overdueOf = new Map(((clientProfit ?? []) as { client_id: string; overdue_balance: number }[]).map((r) => [r.client_id, Number(r.overdue_balance)]))

    const byClient = new Map<string, ClientFact>()
    for (const c of (clients ?? []) as { id: string; name: string }[]) {
      byClient.set(c.id, { id: c.id, name: c.name, ca12: 0, ca3Recent: 0, ca3Prior: 0, invoices12: 0, lastOrderDays: null, families: [], overdue: overdueOf.get(c.id) ?? 0 })
    }
    for (const i of invs) {
      const c = byClient.get(i.client_id)
      if (!c) continue
      const amount = Number(i.total)
      c.ca12 += amount
      c.invoices12 += 1
      if (i.issue_date >= from3) c.ca3Recent += amount
      else if (i.issue_date >= from6) c.ca3Prior += amount
    }
    const famSets = new Map<string, Set<string>>()
    for (const l of lns) {
      const so = one(l.sales_orders)
      if (!so) continue
      const c = byClient.get(so.client_id)
      if (!c) continue
      const days = daysBetween(so.order_date, asOf)
      if (c.lastOrderDays === null || days < c.lastOrderDays) c.lastOrderDays = days
      const fam = familyOf.get(l.article_id)
      if (fam) {
        const set = famSets.get(c.id) ?? new Set<string>()
        set.add(fam)
        famSets.set(c.id, set)
      }
    }
    for (const [id, set] of famSets) {
      const c = byClient.get(id)
      if (c) c.families = [...set]
    }
    facts.clients = [...byClient.values()].filter((c) => c.ca12 > 0 || c.overdue > 0 || c.lastOrderDays !== null)

    const profitRows = (productProfit ?? []) as { article_id: string; article_name: string; revenue: number; margin_pct: number | null }[]
    const revenueOf = new Map(profitRows.map((r) => [r.article_id, r]))
    const qty = new Map<string, { recent: number; prior: number }>()
    for (const l of lns) {
      const so = one(l.sales_orders)
      if (!so) continue
      const q = qty.get(l.article_id) ?? { recent: 0, prior: 0 }
      if (so.order_date >= from3) q.recent += Number(l.qty)
      else if (so.order_date >= from6) q.prior += Number(l.qty)
      qty.set(l.article_id, q)
    }
    const articleIds = new Set([...revenueOf.keys(), ...qty.keys()])
    facts.articles = [...articleIds].map((id): ArticleFact => {
      const p = revenueOf.get(id)
      const q = qty.get(id) ?? { recent: 0, prior: 0 }
      return {
        id, name: p?.article_name ?? id, revenue12: Number(p?.revenue ?? 0),
        marginPct: p?.margin_pct === null || p?.margin_pct === undefined ? null : Number(p.margin_pct),
        qtyRecent: q.recent, qtyPrior: q.prior,
      }
    })

    // Prévision : CA mensuel réel sur 12 mois, tendance linéaire sur 3 mois.
    const monthly = new Map<string, number>()
    for (let k = 0; k < 12; k++) monthly.set(monthKey(monthStart(base, 11 - k)), 0)
    for (const i of invs) monthly.set(monthKey(i.issue_date), (monthly.get(monthKey(i.issue_date)) ?? 0) + Number(i.total))
    const series = [...monthly.values()]
    const trend = linearTrend(series, 3)
    const recentAvg = series.slice(-3).reduce((s, v) => s + v, 0) / 3
    const nextAvg = trend.next.reduce((s, v) => s + v, 0) / 3
    facts.forecast = series.some((v) => v > 0) ? { recentAvg, nextAvg } : null
  } else {
    missing.push('Commercial et CA : droit factures ou clients requis')
  }

  /* --- Finance : factures fournisseur échues --- */
  if (has(P.FINANCE_READ)) {
    const rows = await safe(() => supabase.from('supplier_invoices').select('id,total,paid_amount,due_date,suppliers(name)').in('status', ['open', 'partially_paid', 'disputed']).lt('due_date', asOf))
    const bySupplier = new Map<string, { id: string; supplier: string; amount: number; daysLate: number }>()
    for (const r of (rows ?? []) as { id: string; total: number; paid_amount: number; due_date: string; suppliers: { name: string } | { name: string }[] | null }[]) {
      const sup = one(r.suppliers)
      const key = sup?.name ?? r.id
      const cur = bySupplier.get(key) ?? { id: key, supplier: key, amount: 0, daysLate: 0 }
      cur.amount += Number(r.total) - Number(r.paid_amount)
      cur.daysLate = Math.max(cur.daysLate, daysBetween(r.due_date, asOf))
      bySupplier.set(key, cur)
    }
    facts.supplierOverdue = [...bySupplier.values()].filter((s) => s.amount > 0)
  } else missing.push('Dettes fournisseur : droit finance.read requis')

  /* --- Achats : commandes fournisseur en retard, besoins MRP et seuils de sécurité --- */
  if (has(P.PURCHASES_READ)) {
    const [pos, sugg] = await Promise.all([
      safe(() => supabase.from('purchase_orders').select('id,po_no,expected_date,suppliers(name)').in('status', ['sent', 'partial']).lt('expected_date', asOf)),
      safe(() => supabase.rpc('copilot_purchase_suggestions')),
    ])
    facts.latePurchaseOrders = ((pos ?? []) as { id: string; po_no: string; expected_date: string; suppliers: { name: string } | { name: string }[] | null }[]).map((p) => ({
      id: p.id, ref: p.po_no, supplier: one(p.suppliers)?.name ?? 'Fournisseur', daysLate: daysBetween(p.expected_date, asOf),
    }))
    facts.shortages = ((sugg ?? []) as { kind: string; material_id: string; material_name: string; qty: number; due_date: string | null; severity: string }[]).map((s) => ({
      id: s.material_id, material: s.material_name, qty: Number(s.qty), kind: s.kind === 'mrp' ? 'mrp' : 'safety',
      severity: s.severity === 'critical' ? 'critical' : 'warning', dueDate: s.due_date,
    }))
  } else missing.push('Achats et fournisseurs : droit purchases.read requis')

  /* --- Production : OF en retard, demande non couverte --- */
  if (has(P.PRODUCTION_READ)) {
    const [ofs, gaps] = await Promise.all([
      safe(() => supabase.from('production_orders').select('id,number,planned_end,articles(name)').in('status', ['planned', 'launched', 'in_progress', 'suspended']).lt('planned_end', asOf)),
      safe(() => supabase.rpc('copilot_production_suggestions')),
    ])
    facts.lateOrders = ((ofs ?? []) as { id: string; number: string; planned_end: string; articles: { name: string } | { name: string }[] | null }[]).map((o) => ({
      id: o.id, number: o.number, article: one(o.articles)?.name ?? 'Article', daysLate: daysBetween(o.planned_end, asOf),
    }))
    facts.productionGaps = ((gaps ?? []) as { article_id: string; article_name: string; gap: number }[])
      .filter((g) => Number(g.gap) > 0)
      .map((g) => ({ id: g.article_id, article: g.article_name, gap: Math.round(Number(g.gap)) }))
  } else missing.push('Production : droit production.read requis')

  /* --- Qualité : non-conformités ouvertes --- */
  if (has(P.QUALITY_READ)) {
    const rows = await safe(() => supabase.from('quality_nonconformities').select('id,number,title,severity,due_date').in('status', ['open', 'contained']))
    facts.openNc = ((rows ?? []) as { id: string; number: string; title: string; severity: 'minor' | 'major' | 'critical'; due_date: string | null }[]).map((n) => ({
      id: n.id, number: n.number, title: n.title, severity: n.severity, dueDate: n.due_date,
    }))
  } else missing.push('Qualité : droit quality.read requis')

  /* --- GED : certificats expirés ou qui expirent dans 30 jours --- */
  if (has(P.DOCUMENTS_READ)) {
    const limit = iso(new Date(base.getTime() + 30 * 86_400_000))
    const rows = await safe(() => supabase.from('ged_documents').select('id,title,valid_until,clients(name)').eq('status', 'validated').not('valid_until', 'is', null).lte('valid_until', limit))
    facts.expiringDocs = ((rows ?? []) as { id: string; title: string; valid_until: string; clients: { name: string } | { name: string }[] | null }[]).map((d) => ({
      id: d.id, title: d.title, client: one(d.clients)?.name ?? 'Client', validUntil: d.valid_until, daysLeft: daysBetween(asOf, d.valid_until),
    }))
  } else missing.push('GED : droit documents.read requis')

  /* --- Expédition : préparations bloquées depuis plus de 7 jours --- */
  if (has(P.SHIPMENTS_READ)) {
    const cutoff = new Date(base.getTime() - 7 * 86_400_000).toISOString()
    const rows = await safe(() => supabase.from('shipments').select('id,number,status,created_at').in('status', ['preparing', 'picking', 'packed']).lt('created_at', cutoff))
    facts.stuckShipments = ((rows ?? []) as { id: string; number: string; status: string; created_at: string }[]).map((s) => ({
      id: s.id, number: s.number, status: s.status, daysSince: daysBetween(s.created_at.slice(0, 10), asOf),
    }))
  } else missing.push('Expédition : droit shipments.read requis')

  return { facts, missing }
}
