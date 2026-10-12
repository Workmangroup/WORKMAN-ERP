/** Types métier des mouvements de stock (0018) et leur rattachement au moteur (entrée, sortie, transfert, ajustement). */
export const MOVEMENT_KINDS = [
  { value: 'entree_achat', label: 'Entrée achat', engine: 'Entrée', tone: 'success', reason: false },
  { value: 'sortie_production', label: 'Sortie production', engine: 'Sortie', tone: 'warning', reason: false },
  { value: 'retour_production', label: 'Retour production', engine: 'Entrée', tone: 'success', reason: false },
  { value: 'ajustement', label: 'Ajustement', engine: 'Entrée ou sortie', tone: 'brand', reason: true },
  { value: 'transfert', label: 'Transfert', engine: 'Transfert', tone: 'brand', reason: false },
  { value: 'retour_fournisseur', label: 'Retour fournisseur', engine: 'Sortie', tone: 'warning', reason: true },
  { value: 'rebut', label: 'Rebut', engine: 'Sortie', tone: 'danger', reason: true },
  { value: 'sous_traitance', label: 'Sous-traitance', engine: 'Sortie', tone: 'warning', reason: false },
  { value: 'annulation', label: 'Annulation', engine: 'Réversion', tone: 'neutral', reason: true },
  { value: 'inventaire', label: 'Inventaire', engine: 'Ajustement', tone: 'brand', reason: false },
] as const

/** Types saisissables par une demande (hors annulation, qui passe par l’historique du mouvement). */
export const REQUEST_KINDS = MOVEMENT_KINDS.filter((k) => k.value !== 'annulation' && k.value !== 'inventaire')

export type MovementKind = (typeof MOVEMENT_KINDS)[number]['value']
export const kindLabel = (v: string | null | undefined) => MOVEMENT_KINDS.find((k) => k.value === v)?.label ?? (v ?? '—')
export const kindTone = (v: string | null | undefined) => MOVEMENT_KINDS.find((k) => k.value === v)?.tone ?? 'neutral'

export const REQUEST_STATUS: Record<string, { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' | 'brand' }> = {
  pending: { label: 'En attente', tone: 'warning' },
  posted: { label: 'Publiée', tone: 'success' },
  rejected: { label: 'Refusée', tone: 'danger' },
  cancelled: { label: 'Annulée', tone: 'neutral' },
}
