/**
 * Moteur de recommandations stratégiques (pur : aucun accès base, testable sans navigateur).
 * Entrée : des faits déjà agrégés (`Facts`) par le service. Sortie : des recommandations complètes
 * (titre, description, cause, impact, priorité, action, responsable, échéance, indicateur).
 * Règle : un impact chiffré est toujours une estimation déduite des données, son calcul est écrit dans le libellé.
 */

export type Priority = 'critical' | 'high' | 'medium' | 'low'
export type Domain = 'commercial' | 'finance' | 'achats' | 'production' | 'qualite' | 'expedition' | 'ged'

export const PRIORITY_ORDER: Priority[] = ['critical', 'high', 'medium', 'low']
export const PRIORITY_LABEL: Record<Priority, string> = { critical: 'Critique', high: 'Élevé', medium: 'Moyen', low: 'Faible' }
/** Délai de traitement attendu, en jours à partir de la date d'analyse. */
const PRIORITY_DAYS: Record<Priority, number> = { critical: 7, high: 14, medium: 30, low: 60 }
export const DOMAIN_LABEL: Record<Domain, string> = {
  commercial: 'Commercial', finance: 'Finance', achats: 'Achats', production: 'Production',
  qualite: 'Qualité', expedition: 'Expédition', ged: 'GED',
}
const FAMILY_LABEL: Record<string, string> = {
  jacket: 'vestes', trousers: 'pantalons', coverall: 'combinaisons', polo: 'polos', tshirt: 'tee-shirts',
  vest: 'gilets', parka: 'parkas', shirt: 'chemises', apron: 'tabliers', accessory: 'accessoires', other: 'autres articles',
}

/** Seuils métier, regroupés pour être visibles et modifiables en un seul endroit. */
export const THRESHOLDS = {
  /** CA minimum sur 3 mois pour qu'une baisse de client soit significative. */
  minRecentCa: 1000,
  /** Baisse de CA (en %) à partir de laquelle un client est signalé en perte d'activité. */
  declinePct: 15,
  /** Jours sans commande au-delà desquels un client est dormant. */
  dormantDays: 180,
  /** Encours en retard à partir duquel une relance est proposée. */
  overdueClient: 5000,
  /** Part des clients qui doivent acheter une famille pour qu'elle soit une piste de cross-selling. */
  crossSellShare: 0.4,
  /** Marge en dessous de laquelle un article est signalé. */
  lowMarginPct: 15,
  /** Variation mensuelle (en %) qui déclenche une recommandation de prévision. */
  forecastPct: 10,
  /** Hausse ou baisse de volume d'un article (en %) pour le signaler. */
  productTrendPct: 30,
  /** Hypothèses d'estimation d'impact, affichées dans le libellé d'impact. */
  upsellRate: 0.1,
  crossSellRate: 0.25,
  highPotentialRate: 0.1,
}

export interface Recommendation {
  id: string
  domain: Domain
  title: string
  description: string
  cause: string
  impact: { amount: number | null; label: string }
  priority: Priority
  action: string
  owner: string
  dueDate: string
  kpi: string
}

export interface ClientFact {
  id: string
  name: string
  /** Chiffre d'affaires TTC facturé sur 12 mois. */
  ca12: number
  /** CA des 3 derniers mois et des 3 mois précédents. */
  ca3Recent: number
  ca3Prior: number
  invoices12: number
  /** Jours depuis la dernière commande, null si aucune sur 12 mois. */
  lastOrderDays: number | null
  /** Familles d'articles achetées sur 12 mois. */
  families: string[]
  /** Encours échu. */
  overdue: number
}

export interface ArticleFact {
  id: string
  name: string
  revenue12: number
  marginPct: number | null
  qtyRecent: number
  qtyPrior: number
}

export interface Facts {
  /** Date d'analyse, AAAA-MM-JJ. */
  asOf: string
  clients: ClientFact[]
  articles: ArticleFact[]
  /** Moyenne mensuelle des 3 derniers mois réels et des 3 mois prévus. */
  forecast: { recentAvg: number; nextAvg: number } | null
  supplierOverdue: { id: string; supplier: string; amount: number; daysLate: number }[]
  latePurchaseOrders: { id: string; ref: string; supplier: string; daysLate: number }[]
  shortages: { id: string; material: string; qty: number; kind: 'mrp' | 'safety'; severity: 'critical' | 'warning'; dueDate: string | null }[]
  productionGaps: { id: string; article: string; gap: number }[]
  lateOrders: { id: string; number: string; article: string; daysLate: number }[]
  openNc: { id: string; number: string; title: string; severity: 'minor' | 'major' | 'critical'; dueDate: string | null }[]
  expiringDocs: { id: string; title: string; client: string; validUntil: string; daysLeft: number }[]
  stuckShipments: { id: string; number: string; status: string; daysSince: number }[]
}

export const emptyFacts = (asOf: string): Facts => ({
  asOf, clients: [], articles: [], forecast: null, supplierOverdue: [], latePurchaseOrders: [], shortages: [],
  productionGaps: [], lateOrders: [], openNc: [], expiringDocs: [], stuckShipments: [],
})

/* ---------- Utilitaires de date et de montant (purs) ---------- */

/** Nombre de jours entre deux dates AAAA-MM-JJ (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)
}

/** Échéance : date d'analyse + délai attendu pour la priorité. */
export function dueDate(priority: Priority, asOf: string): string {
  const d = new Date(`${asOf}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + PRIORITY_DAYS[priority])
  return d.toISOString().slice(0, 10)
}

/** Affichage JJ/MM/AAAA d'une date AAAA-MM-JJ. */
export function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-')
  return `${d}/${m}/${y}`
}

export const formatEuro = (n: number): string => `${Math.round(n).toLocaleString('fr-FR')} €`

/** Priorité déduite d'un montant d'impact (€). */
export function priorityFromAmount(amount: number): Priority {
  if (amount >= 50_000) return 'critical'
  if (amount >= 10_000) return 'high'
  if (amount >= 2_000) return 'medium'
  return 'low'
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

const pctChange = (from: number, to: number): number => ((to - from) / from) * 100

/* ---------- Règles commerciales ---------- */

function clientDecline(f: Facts): Recommendation[] {
  return f.clients.flatMap((c) => {
    if (c.ca3Prior < THRESHOLDS.minRecentCa) return []
    const drop = -pctChange(c.ca3Prior, c.ca3Recent)
    if (drop < THRESHOLDS.declinePct) return []
    const impact = Math.round(c.ca12 * (drop / 100))
    const priority = priorityFromAmount(impact)
    const due = dueDate(priority, f.asOf)
    return [{
      id: `commercial:decline:${c.id}`, domain: 'commercial',
      title: `Client en perte d’activité : ${c.name}`,
      description: `${c.name} a réduit son chiffre d’affaires de ${drop.toFixed(0)} % sur les 3 derniers mois.`,
      cause: `CA de ${formatEuro(c.ca3Recent)} sur les 3 derniers mois, contre ${formatEuro(c.ca3Prior)} sur les 3 précédents.`,
      impact: { amount: impact, label: `Risque de perte d’environ ${formatEuro(impact)} de CA annuel (CA 12 mois × baisse)` },
      priority,
      action: `Planifier une visite commerciale avant le ${formatDate(due)}.`,
      owner: 'Responsable commercial', dueDate: due,
      kpi: 'CA mensuel du client (moyenne 3 mois glissants)',
    }]
  })
}

function clientDormant(f: Facts): Recommendation[] {
  return f.clients.flatMap((c) => {
    if (c.ca12 <= 0 || c.lastOrderDays === null || c.lastOrderDays < THRESHOLDS.dormantDays) return []
    const priority = priorityFromAmount(c.ca12)
    const due = dueDate(priority, f.asOf)
    return [{
      id: `commercial:dormant:${c.id}`, domain: 'commercial',
      title: `Client dormant : ${c.name}`,
      description: `Aucune commande depuis ${c.lastOrderDays} jours, alors que le client a acheté ${formatEuro(c.ca12)} sur 12 mois.`,
      cause: 'Absence de commande au-delà du seuil d’activité.',
      impact: { amount: Math.round(c.ca12), label: `CA annuel à reconquérir : ${formatEuro(c.ca12)}` },
      priority,
      action: `Relancer le client et proposer une nouvelle collection avant le ${formatDate(due)}.`,
      owner: 'Responsable commercial', dueDate: due,
      kpi: 'Date de la dernière commande client',
    }]
  })
}

function clientHighPotential(f: Facts): Recommendation[] {
  const active = f.clients.filter((c) => c.ca12 > 0)
  if (active.length < 4) return []
  const sorted = active.map((c) => c.ca12).sort((a, b) => a - b)
  const top = sorted[Math.floor(sorted.length * 0.75)]
  return active.flatMap((c) => {
    if (c.ca12 < top || c.ca3Recent <= c.ca3Prior || c.overdue > 0) return []
    const impact = Math.round(c.ca12 * THRESHOLDS.highPotentialRate)
    const priority = priorityFromAmount(impact)
    const due = dueDate(priority, f.asOf)
    return [{
      id: `commercial:potential:${c.id}`, domain: 'commercial',
      title: `Client à fort potentiel : ${c.name}`,
      description: `Parmi les 25 % de clients les plus importants, en hausse et sans encours en retard.`,
      cause: `CA de ${formatEuro(c.ca12)} sur 12 mois, en croissance sur les 3 derniers mois.`,
      impact: { amount: impact, label: `Hypothèse : +${THRESHOLDS.highPotentialRate * 100} % de CA annuel, soit ${formatEuro(impact)}` },
      priority,
      action: `Proposer un plan de développement (nouvelles références, volumes) avant le ${formatDate(due)}.`,
      owner: 'Responsable commercial', dueDate: due,
      kpi: 'CA annuel du client',
    }]
  })
}

function crossSelling(f: Facts): Recommendation[] {
  const buyers = f.clients.filter((c) => c.families.length > 0)
  if (buyers.length < 3) return []
  const count = new Map<string, number>()
  for (const c of buyers) for (const fam of new Set(c.families)) count.set(fam, (count.get(fam) ?? 0) + 1)
  const avgCa = (fam: string) => {
    const group = buyers.filter((c) => c.families.includes(fam))
    return group.reduce((s, c) => s + c.ca12, 0) / group.length
  }
  return buyers.flatMap((c) => {
    const candidates = [...count.entries()]
      .filter(([fam, n]) => n / buyers.length >= THRESHOLDS.crossSellShare && !c.families.includes(fam))
      .sort((a, b) => b[1] - a[1])
    if (candidates.length === 0) return []
    const [fam, n] = candidates[0]
    const impact = Math.round(avgCa(fam) * THRESHOLDS.crossSellRate)
    const priority = priorityFromAmount(impact)
    const due = dueDate(priority, f.asOf)
    return [{
      id: `commercial:cross:${c.id}:${fam}`, domain: 'commercial',
      title: `Cross-selling : ${c.name} → ${FAMILY_LABEL[fam] ?? fam}`,
      description: `${c.name} achète déjà d’autres familles mais jamais ${FAMILY_LABEL[fam] ?? fam}, acheté par ${Math.round((n / buyers.length) * 100)} % des clients.`,
      cause: 'Famille d’articles absente du portefeuille du client, alors que ses pairs l’achètent.',
      impact: { amount: impact, label: `Hypothèse : ${THRESHOLDS.crossSellRate * 100} % du CA annuel moyen des clients acheteurs, soit ${formatEuro(impact)}` },
      priority,
      action: `Présenter la gamme ${FAMILY_LABEL[fam] ?? fam} lors du prochain contact, avant le ${formatDate(due)}.`,
      owner: 'Responsable commercial', dueDate: due,
      kpi: 'Nombre de familles achetées par client',
    }]
  })
}

function upselling(f: Facts): Recommendation[] {
  const baskets = f.clients.filter((c) => c.invoices12 > 0).map((c) => c.ca12 / c.invoices12)
  if (baskets.length < 4) return []
  const medianBasket = median(baskets)
  return f.clients.flatMap((c) => {
    if (c.invoices12 === 0 || c.ca3Prior <= 0) return []
    const basket = c.ca12 / c.invoices12
    if (basket >= medianBasket || pctChange(c.ca3Prior, c.ca3Recent) < 10) return []
    const impact = Math.round(c.ca12 * THRESHOLDS.upsellRate)
    const priority = priorityFromAmount(impact)
    const due = dueDate(priority, f.asOf)
    return [{
      id: `commercial:upsell:${c.id}`, domain: 'commercial',
      title: `Upselling : ${c.name}`,
      description: `Le client progresse en volume, mais son panier moyen (${formatEuro(basket)}) est sous la médiane du portefeuille (${formatEuro(medianBasket)}).`,
      cause: 'Volume en hausse avec des articles d’entrée de gamme.',
      impact: { amount: impact, label: `Hypothèse : +${THRESHOLDS.upsellRate * 100} % de CA annuel, soit ${formatEuro(impact)}` },
      priority,
      action: `Proposer des références à plus forte valeur ajoutée avant le ${formatDate(due)}.`,
      owner: 'Responsable commercial', dueDate: due,
      kpi: 'Panier moyen par facture',
    }]
  })
}

function productGrowth(f: Facts): Recommendation[] {
  return f.articles.flatMap((a) => {
    if (a.qtyPrior < 10 || pctChange(a.qtyPrior, a.qtyRecent) < THRESHOLDS.productTrendPct) return []
    const priority = priorityFromAmount(a.revenue12)
    const due = dueDate(priority, f.asOf)
    return [{
      id: `commercial:growth:${a.id}`, domain: 'production',
      title: `Produit à forte croissance : ${a.name}`,
      description: `Volume en hausse de ${pctChange(a.qtyPrior, a.qtyRecent).toFixed(0)} % sur les 3 derniers mois.`,
      cause: `${a.qtyRecent} pièces commandées sur 3 mois, contre ${a.qtyPrior} sur les 3 précédents.`,
      impact: { amount: Math.round(a.revenue12), label: `CA 12 mois exposé à une rupture : ${formatEuro(a.revenue12)}` },
      priority,
      action: `Sécuriser les matières et la capacité de production avant le ${formatDate(due)}.`,
      owner: 'Responsable production', dueDate: due,
      kpi: 'Taux de couverture de la demande',
    }]
  })
}

function productPerformance(f: Facts): Recommendation[] {
  return f.articles.flatMap((a) => {
    const out: Recommendation[] = []
    if (a.marginPct !== null && a.revenue12 > 0 && a.marginPct < THRESHOLDS.lowMarginPct) {
      const impact = Math.round(a.revenue12 * ((THRESHOLDS.lowMarginPct - a.marginPct) / 100))
      const priority = priorityFromAmount(impact)
      const due = dueDate(priority, f.asOf)
      out.push({
        id: `commercial:margin:${a.id}`, domain: 'commercial',
        title: `Produit à faible marge : ${a.name}`,
        description: `Marge estimée de ${a.marginPct.toFixed(1)} %, sous le seuil de ${THRESHOLDS.lowMarginPct} %.`,
        cause: 'Coût standard élevé ou prix de vente trop bas (coût standard BOM figé).',
        impact: { amount: impact, label: `Marge manquante estimée : ${formatEuro(impact)} sur 12 mois` },
        priority,
        action: `Revoir le prix de vente ou la nomenclature avant le ${formatDate(due)}.`,
        owner: 'Responsable commercial et achats', dueDate: due,
        kpi: 'Marge sur coût standard (%)',
      })
    }
    if (a.qtyPrior >= 10 && pctChange(a.qtyPrior, a.qtyRecent) <= -THRESHOLDS.productTrendPct) {
      const drop = -pctChange(a.qtyPrior, a.qtyRecent)
      const impact = Math.round(a.revenue12 * (drop / 100))
      const priority = priorityFromAmount(impact)
      const due = dueDate(priority, f.asOf)
      out.push({
        id: `commercial:weak:${a.id}`, domain: 'commercial',
        title: `Produit à faible performance : ${a.name}`,
        description: `Volume en baisse de ${drop.toFixed(0)} % sur les 3 derniers mois.`,
        cause: `${a.qtyRecent} pièces sur 3 mois, contre ${a.qtyPrior} sur les 3 précédents.`,
        impact: { amount: impact, label: `CA annuel menacé : ${formatEuro(impact)}` },
        priority,
        action: `Analyser la baisse auprès des clients concernés et décider du maintien avant le ${formatDate(due)}.`,
        owner: 'Responsable commercial', dueDate: due,
        kpi: 'Quantités vendues par mois',
      })
    }
    return out
  })
}

function forecastTrend(f: Facts): Recommendation[] {
  if (!f.forecast || f.forecast.recentAvg <= 0) return []
  const { recentAvg, nextAvg } = f.forecast
  const change = pctChange(recentAvg, nextAvg)
  if (Math.abs(change) < THRESHOLDS.forecastPct) return []
  const gap = Math.round(Math.abs(nextAvg - recentAvg) * 3)
  if (change < 0) {
    const priority: Priority = change <= -20 ? 'high' : 'medium'
    const due = dueDate(priority, f.asOf)
    return [{
      id: 'commercial:forecast:down', domain: 'commercial',
      title: 'Prévision de baisse du chiffre d’affaires',
      description: `La tendance projette ${formatEuro(nextAvg)} par mois sur les 3 prochains mois, contre ${formatEuro(recentAvg)} réels en moyenne.`,
      cause: 'Tendance linéaire sur 12 mois négative (sans commandes en portefeuille).',
      impact: { amount: gap, label: `Manque à gagner projeté sur 3 mois : ${formatEuro(gap)}` },
      priority,
      action: `Lancer un plan d’action commercial pour sécuriser les 3 prochains mois, avant le ${formatDate(due)}.`,
      owner: 'Direction commerciale', dueDate: due,
      kpi: 'CA mensuel réel comparé à la prévision',
    }]
  }
  const due = dueDate('low', f.asOf)
  return [{
    id: 'commercial:forecast:up', domain: 'commercial',
    title: 'Prévision de hausse du chiffre d’affaires',
    description: `La tendance projette ${formatEuro(nextAvg)} par mois sur les 3 prochains mois, contre ${formatEuro(recentAvg)} réels en moyenne.`,
    cause: 'Tendance linéaire sur 12 mois positive.',
    impact: { amount: gap, label: `Hausse projetée sur 3 mois : ${formatEuro(gap)}` },
    priority: 'low',
    action: `Anticiper la capacité de production et les achats de matières avant le ${formatDate(due)}.`,
    owner: 'Direction des opérations', dueDate: due,
    kpi: 'Taux de charge des postes de travail',
  }]
}

/* ---------- Règles finance, achats, production, qualité, GED, expédition ---------- */

function receivables(f: Facts): Recommendation[] {
  return f.clients.flatMap((c) => {
    if (c.overdue < THRESHOLDS.overdueClient) return []
    const priority = priorityFromAmount(c.overdue)
    const due = dueDate(priority, f.asOf)
    return [{
      id: `finance:overdue:${c.id}`, domain: 'finance',
      title: `Encours en retard : ${c.name}`,
      description: `${formatEuro(c.overdue)} de factures échues non réglées.`,
      cause: 'Factures dépassant l’échéance de paiement.',
      impact: { amount: Math.round(c.overdue), label: `Trésorerie immobilisée : ${formatEuro(c.overdue)}` },
      priority,
      action: `Relancer ${c.name} et obtenir un échéancier de paiement avant le ${formatDate(due)}.`,
      owner: 'Responsable recouvrement', dueDate: due,
      kpi: 'Encours échu client',
    }]
  })
}

function payables(f: Facts): Recommendation[] {
  return f.supplierOverdue.map((s) => {
    const priority = priorityFromAmount(s.amount)
    const due = dueDate(priority, f.asOf)
    return {
      id: `finance:supplier:${s.id}`, domain: 'finance',
      title: `Factures fournisseur échues : ${s.supplier}`,
      description: `${formatEuro(s.amount)} échus, dont le plus ancien depuis ${s.daysLate} jours.`,
      cause: 'Factures fournisseur non réglées après l’échéance.',
      impact: { amount: Math.round(s.amount), label: `Dette échue : ${formatEuro(s.amount)}` },
      priority,
      action: `Planifier le règlement ou négocier un échelonnement avant le ${formatDate(due)}.`,
      owner: 'Responsable finance', dueDate: due,
      kpi: 'Montant des dettes fournisseur échues',
    }
  })
}

function shortagesRule(f: Facts): Recommendation[] {
  return f.shortages.map((s) => {
    const priority: Priority = s.kind === 'mrp' ? (s.severity === 'critical' ? 'critical' : 'high') : 'medium'
    const due = dueDate(priority, f.asOf)
    const when = s.dueDate ? formatDate(s.dueDate) : formatDate(due)
    return {
      id: `achats:shortage:${s.kind}:${s.id}`, domain: 'achats',
      title: s.kind === 'mrp' ? `Rupture prévisible : ${s.material}` : `Stock sous le seuil de sécurité : ${s.material}`,
      description: s.kind === 'mrp'
        ? `Le besoin MRP de ${s.qty} n’est pas couvert par le stock disponible.`
        : `Il manque ${s.qty} pour atteindre le stock de sécurité.`,
      cause: s.kind === 'mrp' ? 'Besoin de production supérieur au stock et aux commandes en cours.' : 'Consommation supérieure aux réapprovisionnements.',
      impact: { amount: null, label: 'Risque d’arrêt de production (montant non chiffré)' },
      priority,
      action: `Commander ${s.qty} avant le ${when}.`,
      owner: 'Responsable achats', dueDate: due,
      kpi: 'Taux de couverture des besoins MRP',
    }
  })
}

function lateSupplierDeliveries(f: Facts): Recommendation[] {
  return f.latePurchaseOrders.map((p) => {
    const priority: Priority = p.daysLate > 14 ? 'high' : 'medium'
    const due = dueDate(priority, f.asOf)
    return {
      id: `achats:late-po:${p.id}`, domain: 'achats',
      title: `Livraison fournisseur en retard : ${p.ref}`,
      description: `${p.supplier} n’a pas livré la commande ${p.ref}, en retard de ${p.daysLate} jours.`,
      cause: 'Date de livraison prévue dépassée, commande non réceptionnée.',
      impact: { amount: null, label: 'Risque de retard de production (montant non chiffré)' },
      priority,
      action: `Relancer ${p.supplier} et confirmer une nouvelle date avant le ${formatDate(due)}.`,
      owner: 'Responsable achats', dueDate: due,
      kpi: 'Taux de livraison fournisseur à l’heure',
    }
  })
}

function lateProduction(f: Facts): Recommendation[] {
  return f.lateOrders.map((o) => {
    const priority: Priority = o.daysLate > 7 ? 'high' : 'medium'
    const due = dueDate(priority, f.asOf)
    return {
      id: `production:late:${o.id}`, domain: 'production',
      title: `OF en retard : ${o.number}`,
      description: `${o.article} : ordre de fabrication ${o.number} en retard de ${o.daysLate} jours.`,
      cause: 'Date de fin planifiée dépassée, OF non clôturé.',
      impact: { amount: null, label: 'Risque de retard de livraison client (montant non chiffré)' },
      priority,
      action: `Replanifier l’OF ${o.number} et réaffecter la capacité avant le ${formatDate(due)}.`,
      owner: 'Responsable production', dueDate: due,
      kpi: 'Taux d’OF terminés à temps',
    }
  })
}

function productionGaps(f: Facts): Recommendation[] {
  return f.productionGaps.map((g) => {
    const priority: Priority = g.gap >= 100 ? 'high' : 'medium'
    const due = dueDate(priority, f.asOf)
    return {
      id: `production:gap:${g.id}`, domain: 'production',
      title: `Demande non couverte : ${g.article}`,
      description: `La demande dépasse la production planifiée et le stock de produits finis de ${g.gap} pièces.`,
      cause: 'Besoin client supérieur à la capacité planifiée.',
      impact: { amount: null, label: `${g.gap} pièces non couvertes` },
      priority,
      action: `Lancer un OF de ${g.gap} pièces avant le ${formatDate(due)}.`,
      owner: 'Planificateur production', dueDate: due,
      kpi: 'Couverture de la demande (%)',
    }
  })
}

function openNonconformities(f: Facts): Recommendation[] {
  return f.openNc.map((n) => {
    const overdue = n.dueDate !== null && n.dueDate < f.asOf
    const priority: Priority = n.severity === 'critical' ? 'critical' : n.severity === 'major' ? (overdue ? 'high' : 'medium') : 'low'
    const due = dueDate(priority, f.asOf)
    return {
      id: `qualite:nc:${n.id}`, domain: 'qualite',
      title: `Non-conformité ouverte : ${n.number}`,
      description: `${n.title} (gravité ${n.severity === 'critical' ? 'critique' : n.severity === 'major' ? 'majeure' : 'mineure'}${overdue ? ', échéance dépassée' : ''}).`,
      cause: 'Non-conformité non clôturée : cause racine ou action corrective en attente.',
      impact: { amount: null, label: 'Risque de réclamation client (montant non chiffré)' },
      priority,
      action: `Traiter ${n.number} : cause racine et action corrective avant le ${formatDate(due)}.`,
      owner: 'Responsable qualité', dueDate: due,
      kpi: 'Nombre de non-conformités ouvertes',
    }
  })
}

function expiringDocuments(f: Facts): Recommendation[] {
  return f.expiringDocs.map((d) => {
    const priority: Priority = d.daysLeft < 0 ? 'high' : 'medium'
    const due = dueDate(priority, f.asOf)
    const state = d.daysLeft < 0 ? `expiré depuis ${-d.daysLeft} jours` : `expire dans ${d.daysLeft} jours`
    return {
      id: `ged:expiry:${d.id}`, domain: 'ged',
      title: `Document à renouveler : ${d.title}`,
      description: `${d.title} (${d.client}) ${state}.`,
      cause: 'Date de validité atteinte ou proche sans version renouvelée.',
      impact: { amount: null, label: 'Risque de refus de livraison ou de non-conformité d’audit' },
      priority,
      action: `Demander le renouvellement à ${d.client} avant le ${formatDate(due)}.`,
      owner: 'Responsable qualité', dueDate: due,
      kpi: 'Documents valides sur documents exigés',
    }
  })
}

function stuckShipments(f: Facts): Recommendation[] {
  return f.stuckShipments.map((s) => {
    const priority: Priority = s.daysSince >= 14 ? 'high' : 'medium'
    const due = dueDate(priority, f.asOf)
    return {
      id: `expedition:stuck:${s.id}`, domain: 'expedition',
      title: `Expédition bloquée : ${s.number}`,
      description: `Expédition en statut « ${s.status} » depuis ${s.daysSince} jours.`,
      cause: 'Préparation ou départ non finalisé.',
      impact: { amount: null, label: 'Risque de retard de livraison client (montant non chiffré)' },
      priority,
      action: `Débloquer la préparation et confirmer la date de départ avant le ${formatDate(due)}.`,
      owner: 'Responsable expédition', dueDate: due,
      kpi: 'Délai moyen de préparation',
    }
  })
}

/* ---------- Assemblage ---------- */

const RULES: ((f: Facts) => Recommendation[])[] = [
  clientDecline, clientDormant, clientHighPotential, crossSelling, upselling, productGrowth, productPerformance, forecastTrend,
  receivables, payables, shortagesRule, lateSupplierDeliveries, lateProduction, productionGaps,
  openNonconformities, expiringDocuments, stuckShipments,
]

/** Toutes les recommandations, triées par priorité puis par impact décroissant (sans impact chiffré en dernier). */
export function buildRecommendations(facts: Facts): Recommendation[] {
  const all = RULES.flatMap((rule) => rule(facts))
  return all.sort((a, b) => {
    const p = PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority)
    if (p !== 0) return p
    return (b.impact.amount ?? -1) - (a.impact.amount ?? -1)
  })
}

export interface Summary {
  total: number
  byPriority: Record<Priority, number>
  byDomain: Partial<Record<Domain, number>>
  /** Somme des impacts chiffrés (estimation, toutes priorités confondues). */
  estimatedImpact: number
}

export function summarize(recs: Recommendation[]): Summary {
  const byPriority: Record<Priority, number> = { critical: 0, high: 0, medium: 0, low: 0 }
  const byDomain: Partial<Record<Domain, number>> = {}
  let estimatedImpact = 0
  for (const r of recs) {
    byPriority[r.priority] += 1
    byDomain[r.domain] = (byDomain[r.domain] ?? 0) + 1
    estimatedImpact += r.impact.amount ?? 0
  }
  return { total: recs.length, byPriority, byDomain, estimatedImpact: Math.round(estimatedImpact) }
}
