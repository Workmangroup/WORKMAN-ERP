/** Valeurs métier du module Stock (libellés FR). Alignées avec 0009_stock.sql. */

export const MOVEMENT_TYPES = {
  in: { label: 'Entrée', tone: 'success' },
  out: { label: 'Sortie', tone: 'danger' },
  transfer: { label: 'Transfert', tone: 'brand' },
  adjustment: { label: 'Ajustement', tone: 'warning' },
  inventory: { label: 'Inventaire', tone: 'neutral' },
} as const
export type MovementType = keyof typeof MOVEMENT_TYPES

export const LOCATION_KINDS = [
  { value: 'storage', label: 'Stockage' },
  { value: 'receiving', label: 'Réception' },
  { value: 'shipping', label: 'Expédition' },
  { value: 'quarantine', label: 'Quarantaine' },
] as const

export const RESERVATION_STATUS = {
  active: { label: 'Active', tone: 'brand' },
  consumed: { label: 'Consommée', tone: 'success' },
  released: { label: 'Libérée', tone: 'neutral' },
} as const

export const INVENTORY_STATUS = {
  draft: { label: 'En cours', tone: 'warning' },
  validated: { label: 'Validé', tone: 'success' },
  cancelled: { label: 'Annulé', tone: 'neutral' },
} as const
