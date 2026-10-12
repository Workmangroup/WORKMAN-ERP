/** Valeurs métier du module Multi-entrepôts (libellés FR). Alignées avec 0017_warehouses.sql. */

export const WAREHOUSE_KINDS = [
  { value: 'fabric', label: 'Tissus' },
  { value: 'supplies', label: 'Fournitures' },
  { value: 'finished_goods', label: 'Produits finis' },
  { value: 'mixed', label: 'Mixte' },
  { value: 'other', label: 'Autre' },
] as const
export const kindLabel = (v: string) => WAREHOUSE_KINDS.find((k) => k.value === v)?.label ?? v

export const ZONE_TYPES = [
  { value: 'storage', label: 'Stockage' },
  { value: 'reception', label: 'Réception' },
  { value: 'cutting', label: 'Coupe' },
  { value: 'workshop', label: 'Atelier' },
  { value: 'quarantine', label: 'Quarantaine' },
  { value: 'shipping', label: 'Expédition' },
  { value: 'other', label: 'Autre' },
] as const
export const zoneTypeLabel = (v: string) => ZONE_TYPES.find((z) => z.value === v)?.label ?? v

export const BIN_KINDS = [
  { value: 'storage', label: 'Stockage' },
  { value: 'receiving', label: 'Réception' },
  { value: 'shipping', label: 'Expédition' },
  { value: 'quarantine', label: 'Quarantaine' },
] as const

export const ACCESS_ROLES = [
  { value: 'viewer', label: 'Lecture', hint: 'Voit l’entrepôt et son stock, sans écrire.' },
  { value: 'operator', label: 'Opérateur', hint: 'Enregistre entrées, sorties, transferts et inventaires.' },
  { value: 'manager', label: 'Responsable', hint: 'Gère l’entrepôt, ses zones, ses emplacements et ses accès.' },
] as const
export const roleLabel = (v: string) => ACCESS_ROLES.find((r) => r.value === v)?.label ?? v
export const roleTone = (v: string) => (v === 'manager' ? 'brand' : v === 'operator' ? 'success' : 'neutral') as 'brand' | 'success' | 'neutral'

export const WAREHOUSE_FIELD_LABELS: Record<string, string> = { name: 'Nom', kind: 'Type', city: 'Ville', address: 'Adresse', code: 'Code' }
