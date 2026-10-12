import 'server-only'
import type { createClient } from '@/lib/supabase/server'
import { buildRecommendations, daysBetween, formatEuro, type Facts } from '@/lib/strategy/engine'
import { buildStrategyFacts } from '@/features/strategy/services/strategy.service'
import { agendaWindow, urgencyFromAge, urgencyFromDue, type AgendaView, type Urgency } from '@/lib/command-center/logic'
import { P } from '@/lib/rbac/permissions'

/**
 * Données du Command Center. Chaque bloc n'est lu que si l'utilisateur a le droit correspondant.
 * Les blocs réutilisent le moteur stratégique (alertes, stocks) pour rester cohérents avec la page Recommandations.
 */
type Supabase = Awaited<ReturnType<typeof createClient>>

const iso = (d: Date) => d.toISOString().slice(0, 10)
const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null))

async function safe<T>(fn: () => PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T | null> {
  try {
    const { data, error } = await fn()
    return error ? null : data
  } catch {
    return null
  }
}

export interface TaskRow { id: string; ref: string; title: string; due: string; status: 'todo' | 'in_progress'; urgency: Urgency }
export interface ValidationRow { id: string; type: string; ref: string; since: string; days: number; urgency: Urgency; href: string }
export interface AlertRow { id: string; type: string; title: string; description: string; tone: 'danger' | 'warning' | 'info'; href: string }
export interface OfRow { id: string; number: string; client: string; product: string; progress: number | null; due: string; urgency: Urgency; group: 'a_lancer' | 'en_cours' | 'bloque' | 'en_retard' | 'termine'; status: string }
export interface StockRow { id: string; article: string; missing: number; kind: 'mrp' | 'safety'; severity: 'critical' | 'warning'; daysLeft: number | null }
export interface AgendaEvent { date: string; kind: string; label: string }
export interface Kpi { label: string; value: string; hint?: string }

export interface CommandCenterData {
  asOf: string
  roles: string[]
  tasks: TaskRow[] | null
  validations: ValidationRow[] | null
  validationsOld: number
  alerts: AlertRow[] | null
  criticalAlerts: number
  highAlerts: number
  quotes: { toChase: { id: string; code: string; client: string; validUntil: string }[]; pending: number } | null
  salesOrders: { open: number; atRisk: { id: string; code: string; client: string }[] } | null
  purchases: { waiting: number; receipts: { id: string; ref: string; supplier: string; date: string }[] } | null
  ofs: OfRow[] | null
  stocks: StockRow[] | null
  agenda: { view: AgendaView; events: AgendaEvent[] } | null
  kpis: Kpi[]
  missing: string[]
}

const ROLE_RULES: [string, string[]][] = [
  ['Direction', [P.DASHBOARD_EXECUTIVE]],
  ['Commercial', [P.QUOTES_READ, P.ORDERS_READ]],
  ['Achat', [P.PURCHASES_APPROVE, P.PURCHASES_RECEIVE]],
  ['Production', [P.PRODUCTION_READ]],
  ['Magasin', [P.STOCK_WRITE]],
  ['Qualité', [P.QUALITY_READ]],
  ['Finance', [P.FINANCE_READ]],
]

export function rolesOf(perms: string[]): string[] {
  const roles = ROLE_RULES.filter(([, need]) => need.some((p) => perms.includes(p))).map(([label]) => label)
  return roles.length ? roles : ['Utilisateur']
}

export async function buildCommandCenter(supabase: Supabase, perms: string[], userId: string, view: AgendaView): Promise<CommandCenterData> {
  const now = new Date()
  const asOf = iso(now)
  const monthStart = `${asOf.slice(0, 8)}01`
  const weekAhead = iso(new Date(now.getTime() + 7 * 86_400_000))
  const window = agendaWindow(view, asOf)
  const has = (p: string) => perms.includes(p)
  const anyHas = (ps: string[]) => ps.some((p) => perms.includes(p))
  const missing: string[] = []

  /* --- Mes tâches : actions correctives qui me sont assignées (Qualité) --- */
  let tasks: TaskRow[] | null = null
  if (has(P.QUALITY_READ)) {
    const rows = await safe(() => supabase.from('quality_corrective_actions').select('id,number,action,due_date,status').eq('owner_id', userId).in('status', ['todo', 'in_progress']).order('due_date').limit(50))
    tasks = ((rows ?? []) as { id: string; number: string; action: string; due_date: string; status: 'todo' | 'in_progress' }[]).map((t) => ({
      id: t.id, ref: t.number, title: t.action, due: t.due_date, status: t.status, urgency: urgencyFromDue(daysBetween(asOf, t.due_date)),
    }))
  }

  /* --- Mes validations : éléments en attente de décision, selon les droits de validation --- */
  let validations: ValidationRow[] | null = null
  if (anyHas([P.PURCHASES_APPROVE, P.STOCK_APPROVE, P.DOCUMENTS_VALIDATE, P.BOM_VALIDATE, P.PRODUCTION_PLAN])) {
    const items: ValidationRow[] = []
    const age = (d: string) => daysBetween(d.slice(0, 10), asOf)
    const push = (type: string, id: string, ref: string, since: string, href: string) => {
      const days = age(since)
      items.push({ id, type, ref, since: since.slice(0, 10), days, urgency: urgencyFromAge(days), href })
    }
    if (has(P.PURCHASES_APPROVE)) {
      const da = await safe(() => supabase.from('purchase_requests').select('id,code,created_at').eq('status', 'submitted').limit(50))
      for (const r of (da ?? []) as { id: string; code: string; created_at: string }[]) push('Demande achat', r.id, r.code, r.created_at, `/purchases/requests/${r.id}`)
      const bc = await safe(() => supabase.from('purchase_orders').select('id,po_no,created_at').eq('status', 'draft').limit(50))
      for (const r of (bc ?? []) as { id: string; po_no: string; created_at: string }[]) push('Bon de commande', r.id, r.po_no, r.created_at, `/purchases/orders/${r.id}`)
    }
    if (has(P.STOCK_APPROVE)) {
      const mv = await safe(() => supabase.from('stock_movement_requests').select('id,number,kind,requested_at').eq('status', 'pending').limit(50))
      for (const r of (mv ?? []) as { id: string; number: string; kind: string; requested_at: string }[]) push('Mouvement stock', r.id, r.number, r.requested_at, '/stock/requests')
    }
    if (has(P.DOCUMENTS_VALIDATE)) {
      const docs = await safe(() => supabase.from('ged_documents').select('id,title,created_at').eq('status', 'pending_review').limit(50))
      for (const r of (docs ?? []) as { id: string; title: string; created_at: string }[]) push('Document GED', r.id, r.title, r.created_at, '/ged')
    }
    if (has(P.BOM_VALIDATE)) {
      const boms = await safe(() => supabase.from('boms').select('id,code,name,created_at').eq('status', 'draft').is('archived_at', null).limit(50))
      for (const r of (boms ?? []) as { id: string; code: string; name: string; created_at: string }[]) push('Nomenclature', r.id, `${r.code} ${r.name}`, r.created_at, `/bom/${r.id}`)
    }
    if (has(P.PRODUCTION_PLAN)) {
      const ofs = await safe(() => supabase.from('production_orders').select('id,number,created_at').eq('status', 'planned').limit(50))
      for (const r of (ofs ?? []) as { id: string; number: string; created_at: string }[]) push('Ordre de fabrication', r.id, r.number, r.created_at, `/production/ordres/${r.id}`)
    }
    validations = items.sort((a, b) => b.days - a.days)
    missing.push('Validations : inventaire et BAT client non modélisés dans l’ERP actuel')
  }

  /* --- Moteur stratégique : alertes et stocks (même source que la page Recommandations) --- */
  let facts: Facts | null = null
  if (anyHas([P.STOCK_READ, P.PURCHASES_READ, P.PRODUCTION_READ, P.QUALITY_READ, P.FINANCE_READ, P.DOCUMENTS_READ, P.INVOICES_READ, P.CLIENTS_READ])) {
    const built = await buildStrategyFacts(supabase, perms)
    facts = built.facts
  }
  let alerts: AlertRow[] | null = null
  let criticalAlerts = 0
  let highAlerts = 0
  if (facts) {
    const recs = buildRecommendations(facts).filter((r) => r.priority !== 'low')
    criticalAlerts = recs.filter((r) => r.priority === 'critical').length
    highAlerts = recs.filter((r) => r.priority === 'high').length
    const typeOf = (id: string) => {
      if (id.startsWith('achats:shortage')) return 'Rupture stock'
      if (id.startsWith('achats:late-po')) return 'Retard fournisseur'
      if (id.startsWith('production:late')) return 'Retard OF'
      if (id.startsWith('production:gap')) return 'Demande non couverte'
      if (id.startsWith('qualite:')) return 'Non-conformité'
      if (id.startsWith('finance:overdue')) return 'Facture impayée'
      if (id.startsWith('finance:supplier')) return 'Facture fournisseur échue'
      if (id.startsWith('ged:')) return 'Certification expirée'
      if (id.startsWith('expedition:')) return 'Expédition bloquée'
      return 'Commercial'
    }
    const toneOf = (p: string) => (p === 'critical' ? 'danger' : p === 'high' ? 'warning' : 'info') as AlertRow['tone']
    alerts = recs.slice(0, 12).map((r) => ({ id: r.id, type: typeOf(r.id), title: r.title, description: r.description, tone: toneOf(r.priority), href: '/strategie' }))
  }

  /* --- Mes commandes : devis (commercial), commandes ouvertes, BC et réceptions (achat), commandes à risque (direction) --- */
  let quotes: CommandCenterData['quotes'] = null
  let salesOrders: CommandCenterData['salesOrders'] = null
  let purchases: CommandCenterData['purchases'] = null
  if (has(P.QUOTES_READ)) {
    const rows = await safe(() => supabase.from('quotes').select('id,code,status,valid_until,clients(name)').eq('status', 'sent').order('valid_until').limit(100))
    const list = (rows ?? []) as { id: string; code: string; valid_until: string; clients: { name: string } | { name: string }[] | null }[]
    quotes = {
      pending: list.length,
      toChase: list.filter((q) => q.valid_until <= weekAhead).slice(0, 8).map((q) => ({ id: q.id, code: q.code, client: one(q.clients)?.name ?? 'Client', validUntil: q.valid_until })),
    }
  }
  if (has(P.ORDERS_READ)) {
    const [open, risk] = await Promise.all([
      safe(() => supabase.from('sales_orders').select('id').eq('status', 'confirmed').limit(500)),
      safe(() => supabase.from('sales_order_lines').select('due_date,order_id,sales_orders!inner(id,code,status,clients(name))').eq('sales_orders.status', 'confirmed').lt('due_date', asOf).limit(200)),
    ])
    const seen = new Map<string, { id: string; code: string; client: string }>()
    for (const r of (risk ?? []) as { order_id: string; sales_orders: { id: string; code: string; clients: { name: string } | { name: string }[] | null } | { id: string; code: string; clients: { name: string } | { name: string }[] | null }[] | null }[]) {
      const so = one(r.sales_orders)
      if (so && !seen.has(so.id)) seen.set(so.id, { id: so.id, code: so.code, client: one(so.clients)?.name ?? 'Client' })
    }
    salesOrders = { open: (open ?? []).length, atRisk: [...seen.values()].slice(0, 8) }
  }
  if (has(P.PURCHASES_READ)) {
    const rows = await safe(() => supabase.from('purchase_orders').select('id,po_no,expected_date,status,suppliers(name)').in('status', ['sent', 'partial']).limit(200))
    const list = (rows ?? []) as { id: string; po_no: string; expected_date: string | null; suppliers: { name: string } | { name: string }[] | null }[]
    purchases = {
      waiting: list.length,
      receipts: list.filter((p) => p.expected_date && p.expected_date >= asOf && p.expected_date <= weekAhead)
        .sort((a, b) => (a.expected_date ?? '').localeCompare(b.expected_date ?? ''))
        .slice(0, 8)
        .map((p) => ({ id: p.id, ref: p.po_no, supplier: one(p.suppliers)?.name ?? 'Fournisseur', date: p.expected_date ?? asOf })),
    }
  }

  /* --- Mes OF : à lancer, en cours, bloqués, en retard, terminés (30 derniers jours) --- */
  let ofs: OfRow[] | null = null
  if (has(P.PRODUCTION_READ)) {
    const [active, done] = await Promise.all([
      safe(() => supabase.from('production_orders').select('id,number,status,qty_planned,planned_end,articles(name),sales_orders(clients(name))').in('status', ['planned', 'launched', 'in_progress', 'suspended']).order('planned_end').limit(100)),
      safe(() => supabase.from('production_orders').select('id,number,status,qty_planned,planned_end,articles(name),sales_orders(clients(name))').eq('status', 'done').gte('finished_at', `${iso(new Date(now.getTime() - 30 * 86_400_000))}T00:00:00Z`).limit(50)),
    ])
    const all = [...((active ?? []) as OfRaw[]), ...((done ?? []) as OfRaw[])]
    const ids = all.map((o) => o.id)
    const logs = ids.length ? (await safe(() => supabase.from('production_logs').select('order_id,qty_good').in('order_id', ids))) ?? [] : []
    const good = new Map<string, number>()
    for (const l of logs as { order_id: string; qty_good: number }[]) good.set(l.order_id, (good.get(l.order_id) ?? 0) + Number(l.qty_good))
    ofs = all.map((o) => {
      const planned = Number(o.qty_planned)
      const progress = planned > 0 ? Math.min(100, Math.round(((good.get(o.id) ?? 0) / planned) * 100)) : null
      const late = o.status !== 'done' && o.planned_end < asOf
      const group: OfRow['group'] = o.status === 'done' ? 'termine' : late ? 'en_retard' : o.status === 'suspended' ? 'bloque' : o.status === 'planned' ? 'a_lancer' : 'en_cours'
      const days = daysBetween(asOf, o.planned_end)
      return {
        id: o.id, number: o.number, client: one(one(o.sales_orders)?.clients)?.name ?? 'Stock', product: one(o.articles)?.name ?? 'Article',
        progress, due: o.planned_end, urgency: o.status === 'done' ? 'low' : urgencyFromDue(days), group, status: o.status,
      }
    })
  }

  /* --- Stocks critiques : mêmes lignes que le moteur (MRP et seuils de sécurité) --- */
  let stocks: StockRow[] | null = null
  if (has(P.PURCHASES_READ) && facts) {
    stocks = facts.shortages.map((s) => ({
      id: s.id, article: s.material, missing: s.qty, kind: s.kind, severity: s.severity,
      daysLeft: s.dueDate ? daysBetween(asOf, s.dueDate) : null,
    }))
  }

  /* --- Mon agenda : réceptions, jalons OF, livraisons clients (fenêtre selon la vue) --- */
  let agenda: CommandCenterData['agenda'] = null
  if (anyHas([P.PURCHASES_READ, P.PRODUCTION_READ, P.ORDERS_READ])) {
    const events: AgendaEvent[] = []
    if (has(P.PURCHASES_READ)) {
      const rows = await safe(() => supabase.from('purchase_orders').select('po_no,expected_date,suppliers(name)').eq('status', 'sent').gte('expected_date', window.from).lte('expected_date', window.to))
      for (const p of (rows ?? []) as { po_no: string; expected_date: string; suppliers: { name: string } | { name: string }[] | null }[]) {
        events.push({ date: p.expected_date, kind: 'Réception fournisseur', label: `${p.po_no} · ${one(p.suppliers)?.name ?? 'Fournisseur'}` })
      }
    }
    if (has(P.PRODUCTION_READ)) {
      const rows = await safe(() => supabase.from('production_orders').select('number,planned_start,planned_end,status').neq('status', 'done').gte('planned_end', window.from).lte('planned_start', window.to).limit(100))
      for (const o of (rows ?? []) as { number: string; planned_start: string; planned_end: string }[]) {
        if (o.planned_start >= window.from && o.planned_start <= window.to) events.push({ date: o.planned_start, kind: 'Début OF', label: o.number })
        if (o.planned_end >= window.from && o.planned_end <= window.to) events.push({ date: o.planned_end, kind: 'Fin OF', label: o.number })
      }
    }
    if (has(P.ORDERS_READ)) {
      const rows = await safe(() => supabase.from('sales_order_lines').select('due_date,sales_orders!inner(code,status,clients(name))').eq('sales_orders.status', 'confirmed').gte('due_date', window.from).lte('due_date', window.to).limit(200))
      for (const l of (rows ?? []) as { due_date: string; sales_orders: { code: string; clients: { name: string } | { name: string }[] | null } | { code: string; clients: { name: string } | { name: string }[] | null }[] | null }[]) {
        const so = one(l.sales_orders)
        if (so) events.push({ date: l.due_date, kind: 'Livraison client', label: `${so.code} · ${one(so.clients)?.name ?? 'Client'}` })
      }
    }
    agenda = { view, events: events.sort((a, b) => a.date.localeCompare(b.date)) }
    missing.push('Agenda : réunions, visites clients et contrôles qualité non modélisés')
  }

  /* --- Mes KPI : chaque indicateur n'est calculé que si le droit correspondant existe --- */
  const kpis: Kpi[] = []
  if (has(P.INVOICES_READ)) {
    const inv = await safe(() => supabase.from('invoices').select('total').in('status', ['issued', 'partially_paid', 'paid']).gte('issue_date', monthStart))
    kpis.push({ label: 'CA du mois', value: formatEuro(((inv ?? []) as { total: number }[]).reduce((s, r) => s + Number(r.total), 0)), hint: 'Factures émises (TTC)' })
    const prof = await safe(() => supabase.rpc('copilot_product_profit', { p_months: 12 }))
    const withMargin = ((prof ?? []) as { revenue: number; margin_pct: number | null }[]).filter((r) => r.margin_pct !== null)
    const rev = withMargin.reduce((s, r) => s + Number(r.revenue), 0)
    if (rev > 0 && has(P.COSTS_READ)) {
      const m = withMargin.reduce((s, r) => s + Number(r.revenue) * Number(r.margin_pct), 0) / rev
      kpis.push({ label: 'Marge (12 mois)', value: `${m.toFixed(1)} %`, hint: 'Coût standard BOM' })
    }
  }
  if (has(P.QUOTES_READ)) {
    const qs = await safe(() => supabase.from('quotes').select('status').gte('quote_date', iso(new Date(now.getTime() - 90 * 86_400_000))))
    const list = (qs ?? []) as { status: string }[]
    const sentLike = list.filter((q) => ['sent', 'accepted', 'converted', 'rejected'].includes(q.status)).length
    const won = list.filter((q) => ['accepted', 'converted'].includes(q.status)).length
    kpis.push({ label: 'Devis envoyés (90 j)', value: String(list.filter((q) => q.status === 'sent').length), hint: 'En attente de réponse' })
    kpis.push({ label: 'Transformation', value: sentLike ? `${Math.round((won / sentLike) * 100)} %` : '—', hint: 'Devis acceptés ou convertis / devis décidés' })
  }
  if (has(P.PURCHASES_READ)) {
    const po = await safe(() => supabase.from('purchase_orders').select('total_amount').gte('order_date', monthStart).neq('status', 'cancelled'))
    kpis.push({ label: 'Achats du mois', value: formatEuro(((po ?? []) as { total_amount: number }[]).reduce((s, r) => s + Number(r.total_amount), 0)), hint: 'Commandes fournisseur' })
    kpis.push({ label: 'Retards fournisseurs', value: String(facts?.latePurchaseOrders.length ?? 0), hint: 'Livraisons dépassées' })
  }
  if (has(P.PRODUCTION_READ) && ofs) {
    const logs30 = await safe(() => supabase.from('production_logs').select('qty_good,qty_scrap').gte('log_date', iso(new Date(now.getTime() - 30 * 86_400_000))))
    const rows = (logs30 ?? []) as { qty_good: number; qty_scrap: number }[]
    const good = rows.reduce((s, r) => s + Number(r.qty_good), 0)
    const total = rows.reduce((s, r) => s + Number(r.qty_good) + Number(r.qty_scrap), 0)
    kpis.push({ label: 'OF en cours', value: String(ofs.filter((o) => o.group === 'en_cours').length) })
    kpis.push({ label: 'OF en retard', value: String(ofs.filter((o) => o.group === 'en_retard').length) })
    kpis.push({ label: 'Rendement (30 j)', value: total > 0 ? `${Math.round((good / total) * 100)} %` : '—', hint: 'Pièces bonnes / pièces produites' })
  }
  if (has(P.STOCK_READ)) {
    const { count } = await supabase.from('stock_movement_requests').select('id', { count: 'exact', head: true }).gte('requested_at', iso(new Date(now.getTime() - 7 * 86_400_000)))
    kpis.push({ label: 'Mouvements (7 j)', value: String(count ?? '—'), hint: 'Demandes de mouvement' })
  }
  if (facts) kpis.push({ label: 'Ruptures et seuils', value: String(facts.shortages.length), hint: 'Besoins MRP et seuils de sécurité' })
  if (has(P.QUALITY_READ) && facts) kpis.push({ label: 'Non-conformités ouvertes', value: String(facts.openNc.length) })
  if (has(P.FINANCE_READ)) {
    const fc = await safe(() => supabase.rpc('treasury_forecast', { p_from: asOf, p_weeks: 13, p_collection_pct: 100 }))
    const rows = (fc ?? []) as { projected_balance: number }[]
    if (rows.length) kpis.push({ label: 'Trésorerie prévue (13 sem.)', value: formatEuro(Number(rows[rows.length - 1].projected_balance)) })
  }
  if (has(P.DASHBOARD_EXECUTIVE) && facts) kpis.push({ label: 'Stocks à risque', value: String(facts.shortages.length), hint: 'Voir Recommandations' })

  return {
    asOf, roles: rolesOf(perms), tasks, validations, validationsOld: (validations ?? []).filter((v) => v.days >= 7).length,
    alerts, criticalAlerts, highAlerts, quotes, salesOrders, purchases, ofs, stocks, agenda, kpis, missing,
  }
}

interface OfRaw {
  id: string; number: string; status: string; qty_planned: number; planned_end: string
  articles: { name: string } | { name: string }[] | null
  sales_orders: { clients: { name: string } | { name: string }[] | null } | { clients: { name: string } | { name: string }[] | null }[] | null
}
