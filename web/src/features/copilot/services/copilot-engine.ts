import 'server-only'
import type { createClient } from '@/lib/supabase/server'
import { formatMoney } from '@/lib/bom/options'
import { P } from '@/lib/rbac/permissions'
import { addMonths, linearTrend } from '../engine/forecast'
import { detectIntent, FOLLOW_UPS, SUGGESTED_QUESTIONS, type Intent } from '../engine/intents'
import type { CopilotAnswer, CopilotCard, CopilotTable } from '../engine/answer'

/**
 * Copilote : répond à partir des données de la société, avec les droits de l'utilisateur.
 * Les tables sont lues via la session (RLS) ; les analyses passent par les fonctions SQL déjà contrôlées.
 * Une source sans droit est omise et signalée. Aucune donnée n'est inventée.
 */
type Supabase = Awaited<ReturnType<typeof createClient>>
type Alert = NonNullable<CopilotAnswer['alerts']>[number]
type Partial_ = Partial<CopilotAnswer> & { alerts?: Alert[]; cards?: CopilotCard[] }

const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Number(v).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %`)
const num = (v: number | null | undefined, u = '') => (v === null || v === undefined ? '—' : `${Number(v).toLocaleString('fr-FR', { maximumFractionDigits: 1 })}${u ? ` ${u}` : ''}`)
const monthLabel = (m: string) => { const [y, mm] = m.split('-'); return `${mm}/${y.slice(2)}` }

async function safe<T>(fn: () => PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T | null> {
  try {
    const { data, error } = await fn()
    return error ? null : data
  } catch {
    return null
  }
}

/** Chiffre d'affaires mensuel sur 12 mois (factures émises, partiellement réglées ou réglées). */
async function monthlySales(supabase: Supabase, months = 12): Promise<{ month: string; amount: number }[] | null> {
  const now = new Date()
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1)).toISOString().slice(0, 10)
  const rows = await safe(() => supabase.from('invoices').select('total,issue_date').in('status', ['issued', 'partially_paid', 'paid']).gte('issue_date', from))
  if (!rows) return null
  const series = new Map<string, number>()
  for (let k = 0; k < months; k++) series.set(addMonths(`${from.slice(0, 7)}`, k), 0)
  for (const r of rows as { total: number; issue_date: string }[]) {
    const key = r.issue_date.slice(0, 7)
    series.set(key, (series.get(key) ?? 0) + Number(r.total))
  }
  return [...series.entries()].map(([month, amount]) => ({ month, amount })).sort((a, b) => a.month.localeCompare(b.month))
}

async function caAnswer(supabase: Supabase): Promise<Partial_> {
  const s = await monthlySales(supabase)
  if (!s) return { text: ['Je n’ai pas accès aux factures : le chiffre d’affaires ne peut pas être calculé avec vos droits.'], sources: [] }
  const cur = s[s.length - 1]?.amount ?? 0
  const prev = s[s.length - 2]?.amount ?? 0
  const ytdYear = String(new Date().getUTCFullYear())
  const ytd = s.filter((x) => x.month.startsWith(ytdYear)).reduce((a, x) => a + x.amount, 0)
  const delta = prev > 0 ? ((cur - prev) / prev) * 100 : null
  return {
    title: 'Chiffre d’affaires',
    text: [`Ce mois-ci : ${formatMoney(cur)}${delta === null ? '' : ` (${delta >= 0 ? '+' : ''}${delta.toFixed(1)} % par rapport au mois précédent)`}.`,
      `Cumul de l’année : ${formatMoney(ytd)}.`],
    cards: [{ label: 'Ce mois', value: formatMoney(cur), tone: delta !== null && delta < 0 ? 'warning' : 'neutral' }, { label: 'Mois précédent', value: formatMoney(prev) }, { label: 'Cumul année', value: formatMoney(ytd) }],
    chart: { kind: 'bar', title: 'CA mensuel (12 mois)', points: s.map((x) => ({ label: monthLabel(x.month), value: Math.round(x.amount) })) },
    sources: ['Factures clients (CA TTC)'],
  }
}

async function forecastAnswer(supabase: Supabase, perms: string[]): Promise<Partial_> {
  const s = await monthlySales(supabase, 12)
  if (!s) return { text: ['Je n’ai pas accès aux factures : aucune prévision de chiffre d’affaires.'], sources: [] }
  const values = s.map((x) => x.amount)
  const tr = linearTrend(values, 3)
  const last = s[s.length - 1].month
  const future = tr.next.map((v, k) => ({ month: addMonths(last, k + 1), amount: v }))
  const slope = tr.slope
  const sources = ['Factures clients (CA TTC, 12 derniers mois)']
  const text = [
    `Tendance sur 12 mois : ${slope >= 0 ? '+' : ''}${formatMoney(slope)} par mois (confiance R² ${(tr.r2 * 100).toFixed(0)} %).`,
    `Prévision CA : ${future.map((f) => `${monthLabel(f.month)} ${formatMoney(f.amount)}`).join(', ')}.`,
    'Estimation statistique simple : elle ne tient compte ni des commandes en portefeuille ni de la saisonnalité.',
  ]
  if (perms.includes(P.FINANCE_READ)) {
    const fc = await safe(() => supabase.rpc('treasury_forecast', { p_from: new Date().toISOString().slice(0, 10), p_weeks: 13, p_collection_pct: 100 }))
    const rows = (fc ?? []) as { projected_balance: number }[]
    if (rows.length) {
      sources.push('Prévision de trésorerie (13 semaines)')
      text.push(`Trésorerie prévue dans 13 semaines : ${formatMoney(rows[rows.length - 1].projected_balance)}.`)
    }
  }
  return {
    title: 'Prévision de chiffre d’affaires',
    text,
    chart: { kind: 'line', title: 'CA réel puis prévu', points: [...s.map((x) => ({ label: monthLabel(x.month), value: Math.round(x.amount) })), ...future.map((f) => ({ label: `${monthLabel(f.month)} (prév.)`, value: Math.round(f.amount) }))] },
    sources,
  }
}

async function profitClientAnswer(supabase: Supabase, perms: string[]): Promise<Partial_> {
  if (!perms.includes(P.INVOICES_READ)) return { text: ['Votre droit ne donne pas accès à la facturation : rentabilité client indisponible.'], sources: [] }
  const rows = await safe(() => supabase.rpc('copilot_client_profit', { p_months: 12 }))
  const list = (rows ?? []) as Record<string, number | string | null>[]
  if (!list.length) return { title: 'Rentabilité clients', text: ['Aucune facture sur les 12 derniers mois.'], sources: ['Factures clients'] }
  const costsKnown = perms.includes(P.COSTS_READ)
  const top = list.slice(0, 10)
  const byNet = [...list].sort((a, b) => Number(b.net_revenue) - Number(a.net_revenue))[0]
  const worstRisk = [...list].sort((a, b) => Number(b.overdue_balance) - Number(a.overdue_balance))[0]
  const alerts: Alert[] = []
  if (Number(worstRisk.overdue_balance) > 0) alerts.push({ severity: 'warning', text: `${worstRisk.client_name} : ${formatMoney(Number(worstRisk.overdue_balance))} en retard de paiement.`, href: '/finance/balances' })
  return {
    title: 'Rentabilité par client (12 mois)',
    text: [
      `Client qui rapporte le plus : ${byNet.client_name} (${formatMoney(Number(byNet.net_revenue))} net).`,
      costsKnown ? 'La marge est estimée à partir du coût standard BOM des articles figés ; sans coût figé, elle n’est pas calculée.' : 'La marge n’est pas affichée : votre droit ne couvre pas les coûts.',
    ],
    table: {
      columns: ['Client', 'CA TTC', 'Avoirs', 'Net', 'Encours', 'En retard', ...(costsKnown ? ['Marge %', 'Couverture coûts'] : [])],
      rows: top.map((r) => [String(r.client_name), formatMoney(Number(r.invoiced)), formatMoney(Number(r.credited)), formatMoney(Number(r.net_revenue)),
        formatMoney(Number(r.open_balance)), formatMoney(Number(r.overdue_balance)), ...(costsKnown ? [pct(r.margin_pct as number | null), pct(r.cost_coverage_pct as number | null)] : [])]),
    } as CopilotTable,
    alerts,
    recommendations: [
      ...top.filter((r) => Number(r.overdue_balance) > 0).slice(0, 2).map((r) => `Relancer ${r.client_name} : ${formatMoney(Number(r.overdue_balance))} en retard`),
      `Prioriser le suivi de ${byNet.client_name}, premier client par chiffre d’affaires net`,
    ],
    links: [{ label: 'Balances âgées clients', href: '/finance/balances' }],
    sources: ['Fonction copilot_client_profit (factures, avoirs, encours, coûts standard BOM)'],
  }
}

async function profitProductAnswer(supabase: Supabase, perms: string[]): Promise<Partial_> {
  if (!perms.includes(P.INVOICES_READ)) return { text: ['Votre droit ne donne pas accès à la facturation : rentabilité produit indisponible.'], sources: [] }
  const rows = await safe(() => supabase.rpc('copilot_product_profit', { p_months: 12 }))
  const list = (rows ?? []) as Record<string, number | string | null>[]
  if (!list.length) return { title: 'Rentabilité par article (12 mois)', text: ['Aucune vente facturée sur les 12 derniers mois.'], sources: ['Factures clients'] }
  const costsKnown = perms.includes(P.COSTS_READ)
  const noCost = list.filter((r) => r.unit_cost === null).length
  const best = list.find((r) => r.margin_pct !== null && r.margin_pct !== undefined)
  return {
    title: 'Rentabilité par article (12 mois)',
    text: [
      best ? `Meilleure marge estimée : ${best.article_name} (${pct(best.margin_pct as number)}).` : 'Aucune marge calculable : les coûts standard ne sont pas figés.',
      noCost > 0 ? `${noCost} article(s) sans coût standard figé : leur marge n’est pas calculée. Figez les nomenclatures validées pour les inclure.` : 'Tous les articles vendus ont un coût standard figé.',
    ],
    table: {
      columns: ['Article', 'Quantité', 'CA HT', ...(costsKnown ? ['Coût unitaire', 'Marge %', 'Couverture coûts'] : [])],
      rows: list.slice(0, 10).map((r) => [`${r.article_ref} ${r.article_name}`, num(Number(r.qty_sold)), formatMoney(Number(r.revenue)),
        ...(costsKnown ? [r.unit_cost === null ? '—' : formatMoney(Number(r.unit_cost)), pct(r.margin_pct as number | null), pct(r.cost_coverage_pct as number | null)] : [])]),
    } as CopilotTable,
    links: [{ label: 'Nomenclatures', href: '/bom' }],
    sources: ['Fonction copilot_product_profit (lignes de facture, coûts standard BOM)'],
  }
}

async function purchaseAnswer(supabase: Supabase, perms: string[]): Promise<Partial_> {
  if (!perms.includes(P.PURCHASES_READ)) return { text: ['Votre droit ne donne pas accès aux achats : suggestions indisponibles.'], sources: [] }
  const rows = await safe(() => supabase.rpc('copilot_purchase_suggestions'))
  const list = (rows ?? []) as Record<string, string | number | null>[]
  const late = list.filter((r) => r.severity === 'critical').length
  const alerts: Alert[] = list.filter((r) => r.severity === 'critical').slice(0, 5).map((r) => ({ severity: 'critical' as const, text: `${r.material_name} : ${r.reason}`, href: '/mrp' }))
  if (!list.length) return { title: 'Suggestions d’achat', text: ['Aucun achat à lancer : besoins couverts et stocks au-dessus des seuils.'], sources: ['MRP (dernier calcul)', 'Seuils de stock'] }
  return {
    title: 'Suggestions d’achat',
    text: [`${list.length} achat(s) à lancer${late ? `, dont ${late} dont la date de commande est dépassée` : ''}.`],
    table: { columns: ['Composant', 'Quantité', 'À commander avant', 'Motif'], rows: list.slice(0, 15).map((r) => [`${r.material_code} ${r.material_name}`, num(Number(r.qty)), r.due_date ? String(r.due_date) : '—', String(r.reason)]) },
    alerts,
    recommendations: list.slice(0, 5).map((r) => `Commander ${num(Number(r.qty))} de ${r.material_name}${r.due_date ? ` avant le ${r.due_date}` : ''}`),
    links: [{ label: 'MRP', href: '/mrp' }, { label: 'Achats', href: '/purchases' }],
    sources: ['Fonction copilot_purchase_suggestions (besoins MRP, seuils de stock)'],
  }
}

async function productionSuggestAnswer(supabase: Supabase, perms: string[]): Promise<Partial_> {
  if (!perms.includes(P.PRODUCTION_READ)) return { text: ['Votre droit ne donne pas accès à la production : suggestions indisponibles.'], sources: [] }
  const rows = await safe(() => supabase.rpc('copilot_production_suggestions'))
  const list = (rows ?? []) as Record<string, string | number | null>[]
  if (!list.length) return { title: 'Suggestions de production', text: ['Aucune commande confirmée sans couverture : rien à lancer.'], sources: ['Commandes confirmées', 'Ordres de fabrication', 'Stock de produits finis'] }
  const total = list.reduce((s, r) => s + Number(r.gap), 0)
  return {
    title: 'Suggestions de production',
    text: [`${list.length} article(s) à fabriquer, soit ${num(total, 'pièces')} : demande client confirmée non couverte par les ordres ni par le stock fini.`],
    table: { columns: ['Article', 'Demande', 'Déjà planifié', 'Stock fini', 'À lancer', 'Échéance client'], rows: list.slice(0, 15).map((r) => [`${r.article_ref} ${r.article_name}`, num(Number(r.demand)), num(Number(r.planned)), num(Number(r.finished_stock)), num(Number(r.gap)), r.earliest_due ? String(r.earliest_due) : '—']) },
    recommendations: list.slice(0, 5).map((r) => `Lancer un OF de ${num(Number(r.gap))} pièces pour ${r.article_name}${r.earliest_due ? ` (échéance ${r.earliest_due})` : ''}`),
    links: [{ label: 'Ordres de fabrication', href: '/production/ordres' }],
    sources: ['Commandes confirmées', 'Ordres de fabrication', 'Stock de produits finis'],
  }
}

async function productionAnswer(supabase: Supabase, perms: string[]): Promise<Partial_> {
  if (!perms.includes(P.PRODUCTION_READ)) return { text: ['Votre droit ne donne pas accès à la production.'], sources: [] }
  const d = await safe(() => supabase.rpc('production_dashboard'))
  const dash = d as Record<string, unknown> | null
  if (!dash) return { text: ['Indicateurs de production indisponibles.'], sources: [] }
  const workload = (dash.workload ?? []) as { code: string; name: string; load_days: number | null; overloaded: boolean }[]
  const over = workload.filter((w) => w.overloaded)
  const alerts: Alert[] = []
  if (Number(dash.late) > 0) alerts.push({ severity: 'warning', text: `${dash.late} ordre(s) en retard.`, href: '/production/ordres' })
  for (const w of over) alerts.push({ severity: 'warning', text: `Poste ${w.code} surchargé (${num(w.load_days, 'jours')}).`, href: '/production/postes' })
  return {
    title: 'Production',
    text: [`${dash.open} ordre(s) ouvert(s), ${dash.late} en retard. Rendement global ${pct(dash.yield_pct as number | null)}, productivité ${num(dash.productivity as number | null, 'pièces/h')}.`],
    cards: [{ label: 'Ordres ouverts', value: String(dash.open) }, { label: 'En retard', value: String(dash.late), tone: Number(dash.late) > 0 ? 'danger' : 'neutral' },
      { label: 'Rendement', value: pct(dash.yield_pct as number | null) }, { label: 'Productivité', value: num(dash.productivity as number | null, 'pc/h') }],
    alerts,
    table: workload.length ? { columns: ['Poste', 'Charge (jours)', 'État'], rows: workload.map((w) => [`${w.code} ${w.name}`, num(w.load_days), w.overloaded ? 'Surchargé' : 'Normal']) } : undefined,
    links: [{ label: 'Ordres de fabrication', href: '/production/ordres' }],
    sources: ['Fonction production_dashboard'],
  }
}

async function stockAnswer(supabase: Supabase, perms: string[]): Promise<Partial_> {
  if (!perms.includes(P.STOCK_READ) && !perms.includes(P.VARIANTS_STOCK)) return { text: ['Votre droit ne donne pas accès au stock.'], sources: [] }
  const vs = await safe(() => supabase.from('variant_stock').select('qty_on_hand,qty_reserved,variant_id'))
  const rows = (vs ?? []) as { qty_on_hand: number; qty_reserved: number }[]
  const onHand = rows.reduce((s, r) => s + Number(r.qty_on_hand), 0)
  const reserved = rows.reduce((s, r) => s + Number(r.qty_reserved), 0)
  const lots = await safe(() => supabase.from('stock_lots').select('material_id,qty_remaining').gt('qty_remaining', 0))
  const mats = new Set(((lots ?? []) as { material_id: string }[]).map((l) => l.material_id)).size
  const alerts: Alert[] = []
  if (perms.includes(P.PURCHASES_READ)) {
    const sugg = (await safe(() => supabase.rpc('copilot_purchase_suggestions'))) as { kind: string; material_name: string }[] | null
    for (const s of (sugg ?? []).filter((x) => x.kind === 'safety').slice(0, 5)) alerts.push({ severity: 'warning', text: `${s.material_name} sous le seuil de sécurité.`, href: '/stock' })
  }
  return {
    title: 'Stock',
    text: [`Produits finis : ${num(onHand, 'pièces')} en stock dont ${num(reserved, 'réservées')}.`, `${mats} composant(s) avec du stock disponible.`],
    cards: [{ label: 'Produits finis', value: num(onHand, 'pcs') }, { label: 'Réservés', value: num(reserved, 'pcs') }, { label: 'Composants en stock', value: String(mats) }],
    alerts,
    links: [{ label: 'Stock', href: '/stock' }],
    sources: ['Stock de produits finis (variantes)', 'Lots de matières', 'Seuils de stock'],
  }
}

async function mrpAnswer(supabase: Supabase, perms: string[]): Promise<Partial_> {
  if (!perms.includes(P.MRP_READ)) return { text: ['Votre droit ne donne pas accès au MRP.'], sources: [] }
  const runs = await safe(() => supabase.from('mrp_runs').select('id,name,as_of').order('created_at', { ascending: false }).limit(1))
  const run = (runs as { id: string; name: string; as_of: string }[] | null)?.[0]
  if (!run) return { title: 'MRP', text: ['Aucun calcul MRP : lancez un calcul depuis le module MRP.'], links: [{ label: 'MRP', href: '/mrp/runs' }], sources: ['MRP'] }
  const sugg = await safe(() => supabase.from('mrp_run_suggestions').select('status,late').eq('run_id', run.id))
  const list = (sugg ?? []) as { status: string; late: boolean }[]
  const proposed = list.filter((s) => s.status === 'proposed').length
  const late = list.filter((s) => s.status === 'proposed' && s.late).length
  return {
    title: 'MRP',
    text: [`Dernier calcul « ${run.name} » au ${run.as_of} : ${proposed} besoin(s) à commander${late ? `, dont ${late} trop tard` : ''}.`],
    cards: [{ label: 'Besoins à commander', value: String(proposed) }, { label: 'En retard', value: String(late), tone: late ? 'danger' : 'neutral' }],
    alerts: late ? [{ severity: 'critical', text: `${late} besoin(s) MRP arrivent trop tard.`, href: '/mrp/runs' }] : [],
    links: [{ label: 'MRP', href: '/mrp/runs' }],
    sources: ['MRP (dernier calcul)'],
  }
}

async function financeAnswer(supabase: Supabase, perms: string[]): Promise<Partial_> {
  if (!perms.includes(P.FINANCE_READ)) return { text: ['Votre droit ne donne pas accès à la finance.'], sources: [] }
  const d = (await safe(() => supabase.rpc('finance_dashboard'))) as Record<string, unknown> | null
  if (!d) return { text: ['Indicateurs financiers indisponibles.'], sources: [] }
  const treasury = (d.treasury as { balance: number } | undefined)?.balance ?? 0
  const recv = Number(d.receivables ?? 0)
  const over = Number(d.receivables_overdue ?? 0)
  const alerts: Alert[] = []
  if (treasury < 0) alerts.push({ severity: 'critical', text: 'Trésorerie négative.', href: '/finance/tresorerie' })
  if (recv > 0 && over / recv > 0.3) alerts.push({ severity: 'warning', text: `${pct((100 * over) / recv)} des créances sont échues.`, href: '/finance/balances' })
  return {
    title: 'Finance',
    text: [`Trésorerie : ${formatMoney(treasury)}. Créances : ${formatMoney(recv)}, dont ${formatMoney(over)} échues. Dettes fournisseurs : ${formatMoney(Number(d.payables ?? 0))}.`,
      `DSO : ${num(d.dso_days as number | null, 'jours')}. Prévision 4 semaines (net) : ${formatMoney(Number(d.forecast_4w_net ?? 0))}.`],
    cards: [{ label: 'Trésorerie', value: formatMoney(treasury), tone: treasury < 0 ? 'danger' : 'neutral' }, { label: 'Créances échues', value: formatMoney(over), tone: over > 0 ? 'warning' : 'neutral' },
      { label: 'Dettes', value: formatMoney(Number(d.payables ?? 0)) }, { label: 'DSO', value: num(d.dso_days as number | null, 'j') }],
    alerts,
    links: [{ label: 'Tableau de bord finance', href: '/finance' }],
    sources: ['Fonction finance_dashboard (trésorerie, balances, prévision)'],
  }
}

async function qualityAnswer(supabase: Supabase, perms: string[]): Promise<Partial_> {
  if (!perms.includes(P.QUALITY_READ)) return { text: ['Votre droit ne donne pas accès à la qualité.'], sources: [] }
  const d = (await safe(() => supabase.rpc('quality_dashboard'))) as Record<string, unknown> | null
  if (!d) return { text: ['Indicateurs qualité indisponibles.'], sources: [] }
  const pareto = (d.pareto ?? []) as { code: string; label: string | null; qty: number }[]
  const sev = (d.nc_by_severity ?? {}) as Record<string, number>
  const alerts: Alert[] = []
  if ((sev.critical ?? 0) > 0) alerts.push({ severity: 'critical', text: `${sev.critical} non-conformité(s) critique(s) ouverte(s).`, href: '/quality/non-conformites' })
  if (Number(d.actions_overdue ?? 0) > 0) alerts.push({ severity: 'warning', text: `${d.actions_overdue} action(s) corrective(s) en retard.`, href: '/quality/plans' })
  return {
    title: 'Qualité',
    text: [`${d.nc_open} non-conformité(s) ouverte(s). Efficacité des actions : ${pct(d.action_effectiveness_pct as number | null)}.`,
      pareto[0] ? `Défaut le plus fréquent : ${pareto[0].code} ${pareto[0].label ?? ''} (${num(Number(pareto[0].qty))}).` : 'Aucun défaut constaté.'],
    cards: [{ label: 'NC ouvertes', value: String(d.nc_open) }, { label: 'Actions en retard', value: String(d.actions_overdue) }, { label: 'Efficacité', value: pct(d.action_effectiveness_pct as number | null) }],
    table: pareto.length ? { columns: ['Défaut', 'Famille', 'Nombre'], rows: pareto.slice(0, 5).map((p) => [`${p.code} ${p.label ?? ''}`, '', num(Number(p.qty))]) } : undefined,
    alerts, links: [{ label: 'Qualité', href: '/quality' }],
    sources: ['Fonction quality_dashboard (contrôles, défauts, non-conformités, actions)'],
  }
}

async function shippingAnswer(supabase: Supabase, perms: string[]): Promise<Partial_> {
  if (!perms.includes(P.SHIPMENTS_READ)) return { text: ['Votre droit ne donne pas accès aux expéditions.'], sources: [] }
  const d = (await safe(() => supabase.rpc('shipping_dashboard'))) as Record<string, unknown> | null
  if (!d) return { text: ['Indicateurs d’expédition indisponibles.'], sources: [] }
  const alerts: Alert[] = []
  if (Number(d.late_open ?? 0) > 0) alerts.push({ severity: 'critical', text: `${d.late_open} expédition(s) en retard.`, href: '/shipments' })
  if (Number(d.exceptions_open ?? 0) > 0) alerts.push({ severity: 'warning', text: `${d.exceptions_open} incident(s) de transport non résolu(s).`, href: '/shipments' })
  return {
    title: 'Expéditions',
    text: [`${d.open} expédition(s) ouverte(s), ${d.late_open} en retard. Livraisons à temps : ${pct(d.on_time_pct as number | null)}. Remplissage : ${pct(d.fill_rate_pct as number | null)}.`],
    cards: [{ label: 'Ouvertes', value: String(d.open) }, { label: 'En retard', value: String(d.late_open), tone: Number(d.late_open) > 0 ? 'danger' : 'neutral' },
      { label: 'À temps', value: pct(d.on_time_pct as number | null) }, { label: 'Remplissage', value: pct(d.fill_rate_pct as number | null) }],
    alerts, links: [{ label: 'Expéditions', href: '/shipments' }],
    sources: ['Fonction shipping_dashboard'],
  }
}

async function clientsAnswer(supabase: Supabase, perms: string[]): Promise<Partial_> {
  if (perms.includes(P.FINANCE_READ)) {
    const aging = (await safe(() => supabase.rpc('finance_aging_clients', { p_as_of: new Date().toISOString().slice(0, 10) }))) as { cli_name: string; total: number; d90_plus: number }[] | null
    if (aging?.length) return {
      title: 'Clients avec encours',
      text: [`${aging.length} client(s) ont un solde ouvert. Le plus gros encours : ${aging[0].cli_name} (${formatMoney(Number(aging[0].total))}).`],
      table: { columns: ['Client', 'Encours', 'Plus de 90 jours'], rows: aging.slice(0, 10).map((r) => [r.cli_name, formatMoney(Number(r.total)), formatMoney(Number(r.d90_plus))]) },
      links: [{ label: 'Balances âgées', href: '/finance/balances' }], sources: ['Balances âgées clients'],
    }
  }
  return profitClientAnswer(supabase, perms)
}

/** Analyse automatique : synthèse des modules accessibles et alertes triées par gravité. */
async function alertsAnswer(supabase: Supabase, perms: string[]): Promise<Partial_> {
  const parts = await Promise.all([
    perms.includes(P.FINANCE_READ) ? financeAnswer(supabase, perms) : null,
    perms.includes(P.PRODUCTION_READ) ? productionAnswer(supabase, perms) : null,
    perms.includes(P.QUALITY_READ) ? qualityAnswer(supabase, perms) : null,
    perms.includes(P.SHIPMENTS_READ) ? shippingAnswer(supabase, perms) : null,
    perms.includes(P.PURCHASES_READ) ? purchaseAnswer(supabase, perms) : null,
    perms.includes(P.MRP_READ) ? mrpAnswer(supabase, perms) : null,
  ])
  const alerts = parts.flatMap((p) => p?.alerts ?? [])
  const order = { critical: 0, warning: 1, info: 2 } as const
  alerts.sort((a, b) => order[a.severity] - order[b.severity])
  return {
    title: 'Alertes intelligentes',
    text: alerts.length ? [`${alerts.length} point(s) d’attention, ${alerts.filter((a) => a.severity === 'critical').length} critique(s).`] : ['Aucune alerte pour vos modules : tout est dans les seuils.'],
    alerts,
    sources: ['Tableaux de bord des modules accessibles (finance, production, qualité, expéditions, achats, MRP)'],
  }
}

async function analysisAnswer(supabase: Supabase, perms: string[]): Promise<Partial_> {
  const [sales, alerts, profit] = await Promise.all([
    perms.includes(P.INVOICES_READ) ? caAnswer(supabase) : null,
    alertsAnswer(supabase, perms),
    perms.includes(P.INVOICES_READ) ? profitClientAnswer(supabase, perms) : null,
  ])
  const cards = [...(sales?.cards ?? [])]
  const lines = [...(sales?.text ?? []), ...(alerts.text ?? [])]
  const sources = [...(sales?.sources ?? []), ...(alerts.sources ?? [])]
  if (profit?.table) lines.push(`Client le plus rentable sur 12 mois : ${String(profit.table.rows[0]?.[0] ?? '—')}.`)
  return {
    title: 'Analyse de la situation',
    text: lines,
    cards,
    chart: sales?.chart,
    alerts: alerts.alerts,
    table: profit?.table,
    sources,
  }
}

async function helpAnswer(): Promise<Partial_> {
  return {
    title: 'Que puis-je faire ?',
    text: [
      'Je réponds à partir des données de votre société, dans la limite de vos droits. Exemples de questions :',
      ...SUGGESTED_QUESTIONS.map((q) => `• ${q}`),
      'Je ne fais pas d’estimation hors données : si une source vous est fermée, je le signale.',
    ],
    sources: [],
  }
}


/** « Quels tissus commander ? » : suggestions d'achat restreintes aux tissus et fils. */
async function fabricPurchaseAnswer(supabase: Supabase, perms: string[]): Promise<Partial_> {
  if (!perms.includes(P.PURCHASES_READ)) return { text: ['Votre droit ne donne pas accès aux achats : suggestions indisponibles.'], sources: [] }
  const mats = await safe(() => supabase.from('bom_materials').select('id,code,name,unit,category').in('category', ['fabric', 'thread']))
  const fabric = new Map(((mats ?? []) as { id: string; code: string; name: string; unit: string; category: string }[]).map((m) => [m.id, m]))
  const rows = await safe(() => supabase.rpc('copilot_purchase_suggestions'))
  const list = ((rows ?? []) as Record<string, string | number | null>[]).filter((r) => fabric.has(String(r.material_id)))
  if (list.length === 0) return { title: 'Tissus et fils à commander', text: ['Aucun tissu ni fil à commander : les besoins sont couverts et les stocks au-dessus des seuils.'], sources: ['MRP (dernier calcul)', 'Seuils de stock'] }
  const late = list.filter((r) => r.severity === 'critical').length
  const mat = (r: Record<string, string | number | null>) => fabric.get(String(r.material_id))!
  return {
    title: 'Tissus et fils à commander',
    text: [`${list.length} référence(s) à commander${late ? `, dont ${late} trop tard` : ''}.`],
    table: { columns: ['Matière', 'Quantité', 'Commander avant', 'Motif'], rows: list.map((r) => [`${mat(r).code} ${mat(r).name}`, `${num(Number(r.qty))} ${mat(r).unit}`, r.due_date ? String(r.due_date) : '—', String(r.reason)]) },
    chart: { kind: 'bar', title: 'Quantité à commander', points: list.slice(0, 8).map((r) => ({ label: mat(r).code, value: Math.round(Number(r.qty)) })) },
    alerts: list.filter((r) => r.severity === 'critical').slice(0, 3).map((r) => ({ severity: 'critical' as const, text: mat(r).name, href: '/mrp' })),
    recommendations: list.slice(0, 5).map((r) => `Commander ${num(Number(r.qty))} ${mat(r).unit} de ${mat(r).name}${r.due_date ? ` avant le ${r.due_date}` : ''}`),
    links: [{ label: 'MRP', href: '/mrp' }, { label: 'Achats', href: '/purchases' }],
    sources: ['Fonction copilot_purchase_suggestions (filtrée sur tissus et fils)'],
  }
}

/** « Quels OF seront en retard ? » : ordres ouverts dont la date de fin est dépassée. */
async function lateOrdersAnswer(supabase: Supabase, perms: string[]): Promise<Partial_> {
  if (!perms.includes(P.PRODUCTION_READ)) return { text: ['Votre droit ne donne pas accès à la production.'], sources: [] }
  const rows = await safe(() => supabase.from('production_order_metrics').select('number,article_name,work_center_code,planned_end,late_days,status').is('closed_at', null).gt('late_days', 0).order('late_days', { ascending: false }).limit(50))
  const list = (rows ?? []) as { number: string; article_name: string; work_center_code: string | null; planned_end: string; late_days: number; status: string }[]
  if (list.length === 0) return { title: 'OF en retard', text: ['Aucun OF en retard : toutes les fins prévues sont tenues.'], sources: ['Ordres de fabrication'] }
  const top = list[0]
  return {
    title: 'OF en retard',
    text: [`${list.length} OF dépassent leur date de fin. Le plus en retard : ${top.number} (${top.late_days} j).`],
    table: { columns: ['OF', 'Article', 'Poste', 'Fin prévue', 'Retard', 'Statut'], rows: list.slice(0, 15).map((r) => [r.number, r.article_name, r.work_center_code ?? 'À affecter', r.planned_end, `${r.late_days} j`, r.status]) },
    chart: { kind: 'bar', title: 'Jours de retard par OF', points: list.slice(0, 10).map((r) => ({ label: r.number.slice(-6), value: r.late_days })) },
    alerts: [{ severity: 'critical', text: `${list.length} OF en retard`, href: '/production/ordres' }],
    recommendations: list.slice(0, 3).map((r) => (r.work_center_code ? `Replanifier ${r.number} (${r.article_name}) ou renforcer le poste ${r.work_center_code}` : `Affecter un poste à ${r.number} pour le replanifier`)),
    links: [{ label: 'Ordres de fabrication', href: '/production/ordres' }, { label: 'Postes de travail', href: '/production/postes' }],
    sources: ['Métriques des ordres de fabrication (retard calculé sur la date de fin prévue)'],
  }
}

const HANDLERS: Record<Intent, (s: Supabase, p: string[]) => Promise<Partial_>> = {
  help: async () => helpAnswer(),
  analysis: analysisAnswer,
  alerts: alertsAnswer,
  forecast: forecastAnswer,
  ca: async (s, p) => (p.includes(P.INVOICES_READ) ? caAnswer(s) : { text: ['Votre droit ne donne pas accès à la facturation.'], sources: [] }),
  marge: async (s, p) => profitClientAnswer(s, p),
  profit_client: profitClientAnswer,
  profit_product: profitProductAnswer,
  purchase: purchaseAnswer,
  fabric_purchase: fabricPurchaseAnswer,
  late_orders: lateOrdersAnswer,
  production_suggest: productionSuggestAnswer,
  production: productionAnswer,
  stock: stockAnswer,
  mrp: mrpAnswer,
  finance: financeAnswer,
  quality: qualityAnswer,
  shipping: shippingAnswer,
  clients: clientsAnswer,
}

/** Point d'entrée : détecte l'intention, interroge les données autorisées et produit la réponse. */
export async function answerQuestion(question: string, supabase: Supabase, permissions: string[]): Promise<{ intent: Intent; answer: CopilotAnswer }> {
  const intent = detectIntent(question)
  const part = await HANDLERS[intent](supabase, permissions)
  const answer: CopilotAnswer = {
    title: part.title ?? 'Réponse',
    text: part.text?.length ? part.text : ['Je n’ai pas de donnée à vous proposer pour cette question.'],
    cards: part.cards,
    table: part.table,
    chart: part.chart,
    alerts: part.alerts,
    recommendations: part.recommendations ?? [],
    followUps: FOLLOW_UPS[intent] ?? [],
    links: part.links,
    sources: part.sources ?? [],
  }
  return { intent, answer }
}
