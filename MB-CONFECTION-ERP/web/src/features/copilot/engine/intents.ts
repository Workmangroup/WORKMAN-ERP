/** Moteur d'intentions du copilote : reconnaît la demande en français, sans dépendance (testable seul). */

export type Intent =
  | 'help' | 'analysis' | 'alerts' | 'forecast' | 'ca' | 'marge' | 'profit_client' | 'profit_product'
  | 'purchase' | 'fabric_purchase' | 'production' | 'production_suggest' | 'late_orders'
  | 'stock' | 'mrp' | 'finance' | 'quality' | 'shipping' | 'clients'

/** Met en minuscules et retire les accents et la ponctuation : « Rentabilité » → « rentabilite ». */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’`]/g, ' ')
    .replace(/[^a-z0-9%\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const has = (t: string, words: string[]) => words.some((w) => t.includes(w))
const hasWord = (t: string, re: RegExp) => re.test(t)

/** Ordre de priorité : demandes croisées d'abord, puis modules. */
export function detectIntent(question: string): Intent {
  const t = normalize(question)
  if (t === '' || hasWord(t, /^(aide|help|que sais tu|que peux tu|comment ca marche)\b/) || t === '?') return 'help'
  const profit = has(t, ['rentab', 'marge', 'profit'])
  if (profit && has(t, ['client'])) return 'profit_client'
  if (profit && has(t, ['produit', 'article', 'modele', 'veste', 'reference'])) return 'profit_product'
  if (hasWord(t, /\b(of|ordres?|ordre de fabrication|ordres de fabrication)\b/) && has(t, ['retard', 'en retard', 'tarde', 'depasse'])) return 'late_orders'
  if (has(t, ['produire', 'lancer', 'ordre de fabrication', 'quoi fabriquer', 'fabriquer']) && has(t, ['suggest', 'quoi', 'propos', 'faut', 'lancer', 'produire'])) return 'production_suggest'
  if (hasWord(t, /\b(tissus?|fils?|matieres?|doublure|mercerie)\b/) && has(t, ['commander', 'acheter', 'achat', 'faut', 'quoi', 'besoin', 'suggest', 'propos'])) return 'fabric_purchase'
  if (has(t, ['acheter', 'commander', 'approvisionn', 'achat', 'fournisseur']) && has(t, ['suggest', 'quoi', 'propos', 'faut', 'a commander', 'besoin', 'acheter', 'commander'])) return 'purchase'
  if (has(t, ['prevision', 'prevoir', 'projection', 'tendance', 'futur', 'prochain', 'prochaine'])) return 'forecast'
  if (has(t, ['alerte', 'risque', 'anomalie', 'urgent', 'attention', 'probleme', 'danger'])) return 'alerts'
  if (has(t, ['analyse', 'bilan', 'synthese', 'resume', 'situation', 'comment va', 'point sur', 'vue d ensemble'])) return 'analysis'
  if (profit) return 'marge'
  if (has(t, ['tresorerie', 'cash', 'creance', 'dette', 'paiement', 'encaisse', 'relance', 'banque', 'impaye', 'echu', 'finance'])) return 'finance'
  if (hasWord(t, /\b(ca|chiffre d affaires|ventes?|factur\w*)\b/)) return 'ca'
  if (has(t, ['qualite', 'defaut', 'non conform', 'rebut', 'controle', 'action corrective'])) return 'quality'
  if (has(t, ['expedition', 'livraison', 'colis', 'transport', 'livre'])) return 'shipping'
  if (hasWord(t, /\bmrp\b/) || has(t, ['besoin'])) return 'mrp'
  if (has(t, ['stock'])) return 'stock'
  if (has(t, ['production', 'atelier', 'ordre', 'rendement', 'retard', 'surcharge', 'productiv', 'poste'])) return 'production'
  if (has(t, ['client'])) return 'clients'
  return 'help'
}

/** Questions d'exemple affichées à l'accueil du copilote. */
export const SUGGESTED_QUESTIONS = [
  'Quels tissus commander ?',
  'Quels OF seront en retard ?',
  'Quels clients sont les plus rentables ?',
  'Fais une analyse de la situation',
  'Quelles sont les alertes importantes ?',
  'Quelle est la prévision de chiffre d’affaires ?',
  'Où en est la trésorerie ?',
  'Que dois-je produire ?',
]

/** Questions de suite proposées après une réponse, selon l'intention. */
export const FOLLOW_UPS: Partial<Record<Intent, string[]>> = {
  late_orders: ['Quelle est la charge des postes ?', 'Que dois-je produire ?'],
  fabric_purchase: ['Quels achats en général ?', 'Quels OF seront en retard ?'],
  purchase: ['Quels tissus commander ?', 'Où en est la trésorerie ?'],
  profit_client: ['Quels clients ont des retards de paiement ?', 'Quelle est la rentabilité des produits ?'],
  profit_product: ['Quels clients sont les plus rentables ?', 'Que dois-je produire ?'],
  production_suggest: ['Quels OF seront en retard ?', 'Que dois-je acheter ?'],
  analysis: ['Quelles sont les alertes importantes ?', 'Quelle est la prévision de chiffre d’affaires ?'],
  alerts: ['Fais une analyse de la situation', 'Quels OF seront en retard ?'],
  forecast: ['Où en est la trésorerie ?', 'Quels clients sont les plus rentables ?'],
  finance: ['Quels clients ont des retards de paiement ?', 'Quelle est la prévision de chiffre d’affaires ?'],
}
