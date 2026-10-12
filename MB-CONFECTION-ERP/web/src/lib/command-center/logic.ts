/**
 * Logique du Command Center (pure, testable) : quels widgets un utilisateur voit, ordre et masquage,
 * urgence, fenêtre de l'agenda et briefing textuel. Aucun accès base ici.
 */

export const WIDGETS = [
  { id: 'briefing', label: 'Briefing IA', requires: ['copilot.use'] },
  { id: 'tasks', label: 'Mes tâches', requires: ['quality.read'] },
  { id: 'validations', label: 'Mes validations', requires: ['purchases.approve', 'stock.approve', 'documents.validate', 'bom.validate', 'production.plan'] },
  { id: 'alerts', label: 'Mes alertes', requires: ['stock.read', 'purchases.read', 'production.read', 'quality.read', 'finance.read', 'documents.read'] },
  { id: 'orders', label: 'Mes commandes', requires: ['quotes.read', 'purchases.read', 'orders.read', 'dashboard.executive'] },
  { id: 'ofs', label: 'Mes OF', requires: ['production.read'] },
  { id: 'stocks', label: 'Stocks critiques', requires: ['purchases.read'] },
  { id: 'agenda', label: 'Mon agenda', requires: ['purchases.read', 'production.read', 'orders.read'] },
  { id: 'kpi', label: 'Mes KPI', requires: [] },
  { id: 'actions', label: 'Actions rapides', requires: [] },
] as const

export type WidgetId = (typeof WIDGETS)[number]['id']

/** Widgets visibles selon les permissions (un widget sans exigence est toujours visible). */
export function visibleWidgets(granted: readonly string[]): WidgetId[] {
  return WIDGETS.filter((w) => w.requires.length === 0 || w.requires.some((p) => granted.includes(p))).map((w) => w.id)
}

/**
 * Ordre d'affichage : l'ordre enregistré est gardé, les widgets inconnus ou non autorisés sont retirés,
 * les nouveaux widgets autorisés sont ajoutés à la fin.
 */
export function mergeOrder(stored: readonly string[] | null | undefined, available: readonly WidgetId[]): WidgetId[] {
  const allowed = new Set<string>(available)
  const kept = (stored ?? []).filter((id, i, arr) => allowed.has(id) && arr.indexOf(id) === i) as WidgetId[]
  const missing = available.filter((id) => !kept.includes(id))
  return [...kept, ...missing]
}

/** Urgence d'un élément selon son âge ou le nombre de jours restants. */
export type Urgency = 'high' | 'medium' | 'low'
export const URGENCY_LABEL: Record<Urgency, string> = { high: 'Élevée', medium: 'Moyenne', low: 'Faible' }

/** `daysOpen` : jours écoulés depuis la demande (positif) ou jusqu'à l'échéance (négatif = dépassée). */
export function urgencyFromAge(daysOpen: number): Urgency {
  if (daysOpen >= 7) return 'high'
  if (daysOpen >= 3) return 'medium'
  return 'low'
}

export function urgencyFromDue(daysLeft: number): Urgency {
  if (daysLeft < 0) return 'high'
  if (daysLeft <= 3) return 'medium'
  return 'low'
}

/** Ton d'une alerte : rouge = critique, orange = élevé, bleu = information (le vert « résolu » suppose un suivi d'alertes, non modélisé). */
export type AlertTone = 'danger' | 'warning' | 'info'
export function alertTone(priority: 'critical' | 'high' | 'medium' | 'low'): AlertTone {
  if (priority === 'critical') return 'danger'
  if (priority === 'high') return 'warning'
  return 'info'
}

export type AgendaView = 'jour' | 'semaine' | 'mois'
export const AGENDA_VIEWS: AgendaView[] = ['jour', 'semaine', 'mois']
const SPAN_DAYS: Record<AgendaView, number> = { jour: 0, semaine: 6, mois: 29 }

/** Fenêtre de dates (AAAA-MM-JJ) couverte par une vue de l'agenda, à partir de la date d'analyse. */
export function agendaWindow(view: AgendaView, asOf: string): { from: string; to: string } {
  const d = new Date(`${asOf}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + SPAN_DAYS[view])
  return { from: asOf, to: d.toISOString().slice(0, 10) }
}

export interface BriefingInput {
  validations: number
  validationsOld: number
  criticalAlerts: number
  highAlerts: number
  topAlerts: string[]
  lateOfs: number
  blockedOfs: number
  shortages: number
  quotesToChase: number
  eventsToday: number
}

/** Briefing déterministe : chaque phrase reprend un chiffre des données, aucune supposition. */
export function briefing(input: BriefingInput): string[] {
  const lines: string[] = []
  const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`
  if (input.validations > 0) {
    lines.push(`${plural(input.validations, 'validation est en attente', 'validations sont en attente')}${input.validationsOld > 0 ? `, dont ${input.validationsOld} depuis plus de 7 jours.` : '.'}`)
  }
  if (input.criticalAlerts + input.highAlerts > 0) {
    lines.push(`${input.criticalAlerts} alerte(s) critique(s) et ${input.highAlerts} alerte(s) élevée(s).`)
  }
  if (input.topAlerts.length > 0) lines.push(`À traiter en priorité : ${input.topAlerts.join(' ; ')}.`)
  if (input.lateOfs + input.blockedOfs > 0) lines.push(`${input.lateOfs} OF en retard et ${input.blockedOfs} OF bloqué(s).`)
  if (input.shortages > 0) lines.push(`${plural(input.shortages, 'article est en risque', 'articles sont en risque')} de rupture.`)
  if (input.quotesToChase > 0) lines.push(`${plural(input.quotesToChase, 'devis est à relancer', 'devis sont à relancer')} cette semaine.`)
  if (input.eventsToday > 0) lines.push(`${plural(input.eventsToday, 'événement est prévu', 'événements sont prévus')} aujourd’hui.`)
  return lines.length > 0 ? lines : ['Rien d’urgent aujourd’hui : aucune validation, alerte ni échéance critique avec vos droits.']
}
