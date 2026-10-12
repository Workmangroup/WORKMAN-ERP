/** Valeurs métier du module Variantes Textile (libellés FR). Alignées avec 0015_variants.sql. */

export const MOVE_TYPES = [
  { value: 'receipt', label: 'Entrée (production, retour)', hint: 'Ajoute des pièces au stock.' },
  { value: 'issue', label: 'Sortie (expédition)', hint: 'Retire des pièces disponibles (hors réservées).' },
  { value: 'adjustment', label: 'Ajustement (± pièces)', hint: 'Corrige le stock, motif obligatoire (valeur négative pour retirer).' },
  { value: 'inventory', label: 'Inventaire (quantité comptée)', hint: 'Saisissez la quantité réellement comptée : l’écart est calculé.' },
  { value: 'transfer', label: 'Transfert entre entrepôts', hint: 'Déplace des pièces disponibles vers un autre entrepôt.' },
] as const
export const MOVE_LABELS: Record<string, string> = {
  receipt: 'Entrée', issue: 'Sortie', adjustment: 'Ajustement', inventory: 'Inventaire', transfer_in: 'Transfert (entrée)', transfer_out: 'Transfert (sortie)',
}

export const VIEW_MODES = [
  { id: 'stock', label: 'Stock' },
  { id: 'price', label: 'Prix' },
  { id: 'barcode', label: 'Codes-barres' },
  { id: 'bom', label: 'Nomenclature' },
] as const
export type ViewMode = (typeof VIEW_MODES)[number]['id']

export const SIZE_GROUPS = [{ value: 'letters', label: 'Lettres (S, M, L…)' }, { value: 'numeric', label: 'Numériques (36, 38…)' }, { value: 'other', label: 'Autre' }] as const

export interface CatalogSize { id: string; code: string; label: string; size_group: string; sort_order: number; active: boolean }
export interface CatalogColor { id: string; code: string; name: string; hex: string | null; pantone: string | null; active: boolean }
export interface WarehouseLite { id: string; code: string; name: string }
export interface VariantStockRow { warehouse_id: string; on_hand: number; reserved: number; safety: number }
export interface VariantRow {
  id: string; color_id: string; size_id: string; sku: string; barcode: string | null; price: number | null; currency: string; bom_id: string | null; bom_code: string | null; active: boolean
  on_hand: number; reserved: number; low: boolean; stock: VariantStockRow[]
}
export interface MatrixData {
  product: { id: string; code: string; name: string; status: string; client_id: string; article_id: string | null }
  product_bom: { id: string; code: string; name: string; active_version_id: string | null } | null
  warehouses: WarehouseLite[]
  variants: VariantRow[]
}
export interface OverviewRow {
  product_id: string; code: string; name: string; status: string; client_name: string; variants: number; active: number; colors: number; sizes: number
  on_hand: number; reserved: number; out_of_stock: number; low: number; missing_barcode: number; missing_price: number
}

/** Somme de contrôle GTIN (EAN-8, UPC-A, EAN-13, GTIN-14) — identique à private.gtin_valid. */
export function gtinValid(g: string | null | undefined): boolean {
  if (!g || !/^\d+$/.test(g) || ![8, 12, 13, 14].includes(g.length)) return false
  const n = g.length
  let s = 0
  for (let i = 1; i < n; i++) s += Number(g[n - 1 - i]) * (i % 2 === 1 ? 3 : 1)
  return (10 - (s % 10)) % 10 === Number(g[n - 1])
}

const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011']
const G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111']
const R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100']
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL']
/** Modules (0/1) d'un EAN-13 : 95 modules, ou null si le code n'est pas un EAN-13 valide. */
export function ean13Modules(code: string): string | null {
  if (!/^\d{13}$/.test(code) || !gtinValid(code)) return null
  const d = [...code].map(Number)
  const par = PARITY[d[0]]
  let out = '101'
  for (let i = 0; i < 6; i++) out += (par[i] === 'L' ? L : G)[d[i + 1]]
  out += '01010'
  for (let i = 7; i < 13; i++) out += R[d[i]]
  return `${out}101`
}

/** Niveau de stock d'une variante pour la coloration de la matrice. */
export function stockLevel(v: { on_hand: number; reserved: number; low: boolean; active: boolean }): 'off' | 'out' | 'low' | 'ok' {
  if (!v.active) return 'off'
  if (v.on_hand === 0) return 'out'
  return v.low ? 'low' : 'ok'
}

export const VARIANT_FIELD_LABELS: Record<string, string> = { price: 'Prix', barcode: 'Code-barres', active: 'Actif', bom_id: 'Nomenclature', currency: 'Devise' }

export const formatPrice = (v: number | null | undefined, currency = 'EUR') =>
  v === null || v === undefined ? '—' : new Intl.NumberFormat('fr-FR', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v)
