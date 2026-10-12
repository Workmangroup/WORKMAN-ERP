/** Valeurs métier de la sous-traitance (libellés FR). Alignées avec 0016_subcontracting.sql. */

export const SERVICES = [
  { value: 'embroidery', label: 'Broderie' },
  { value: 'screen_printing', label: 'Sérigraphie' },
  { value: 'printing', label: 'Impression' },
  { value: 'washing', label: 'Lavage' },
  { value: 'finishing', label: 'Finition' },
  { value: 'other', label: 'Autre' },
] as const
export const serviceLabel = (v: string) => SERVICES.find((s) => s.value === v)?.label ?? v

export const COUNTRIES = [{ value: 'TN', label: 'Tunisie' }, { value: 'FR', label: 'France' }, { value: 'IT', label: 'Italie' }, { value: 'MA', label: 'Maroc' }, { value: 'PT', label: 'Portugal' }, { value: 'TR', label: 'Turquie' }] as const

export const ORDER_STATUS = {
  draft: { label: 'Brouillon', tone: 'neutral' },
  sent: { label: 'Envoyée', tone: 'brand' },
  partially_received: { label: 'Partiellement reçue', tone: 'warning' },
  received: { label: 'Reçue (à contrôler)', tone: 'warning' },
  closed: { label: 'Clôturée', tone: 'success' },
  cancelled: { label: 'Annulée', tone: 'neutral' },
} as const
export type OrderStatus = keyof typeof ORDER_STATUS

export const QC_STATUS = {
  pending: { label: 'À contrôler', tone: 'warning' },
  accepted: { label: 'Accepté', tone: 'success' },
  partial: { label: 'Partiellement accepté', tone: 'warning' },
  rejected: { label: 'Rejeté', tone: 'danger' },
} as const

export const COST_KINDS = [
  { value: 'service', label: 'Prestation' }, { value: 'shipping', label: 'Transport' }, { value: 'other', label: 'Autre' },
] as const

/** Étapes du workflow affichées sur la fiche commande. */
export const WORKFLOW = [
  { id: 'production', label: 'Production' },
  { id: 'shipping', label: 'Envoi sous-traitant' },
  { id: 'receiving', label: 'Réception' },
  { id: 'qc', label: 'Contrôle qualité' },
  { id: 'stock', label: 'Stock' },
] as const

/** Étape courante d'une commande (0 = production … 4 = stock, 5 = clôturée). */
export function workflowStep(o: { status: string; qty_shipped: number; qty_received: number; pending_qc: number; unposted: number }): number {
  if (o.status === 'closed') return 5
  if (o.status === 'draft' || o.status === 'cancelled') return 0
  if (o.qty_received === 0) return 1
  if (o.pending_qc > 0) return 3
  if (o.unposted > 0) return 4
  return o.status === 'received' ? 4 : 2
}

export const MONTHS_FR = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.']

export const daysBetween = (a: string | null | undefined, b: string | null | undefined) => {
  if (!a || !b) return null
  return Math.round((new Date(`${b.slice(0, 10)}T00:00:00`).getTime() - new Date(`${a.slice(0, 10)}T00:00:00`).getTime()) / 86_400_000)
}
export const today = () => new Date().toISOString().slice(0, 10)
