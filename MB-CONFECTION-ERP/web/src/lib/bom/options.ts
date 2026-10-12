/** Valeurs métier du module BOM (libellés FR). Alignées avec 0008_bom.sql. */

export const MATERIAL_CATEGORIES = [
  { value: 'fabric', label: 'Tissu' },
  { value: 'lining', label: 'Doublure' },
  { value: 'zip', label: 'Fermeture (zip)' },
  { value: 'button', label: 'Bouton / pression' },
  { value: 'thread', label: 'Fil' },
  { value: 'reflective', label: 'Bande réfléchissante' },
  { value: 'label', label: 'Étiquette' },
  { value: 'trim', label: 'Mercerie' },
  { value: 'packaging', label: 'Emballage' },
  { value: 'other', label: 'Autre' },
] as const

export const UNITS = [
  { value: 'm', label: 'm', long: 'mètre' },
  { value: 'm2', label: 'm²', long: 'mètre carré' },
  { value: 'cm', label: 'cm', long: 'centimètre' },
  { value: 'kg', label: 'kg', long: 'kilogramme' },
  { value: 'pc', label: 'pièce', long: 'pièce' },
] as const

export const BOM_KINDS = [
  { value: 'product', label: 'Produit fini' },
  { value: 'subassembly', label: 'Sous-ensemble' },
] as const

export const BOM_VERSION_STATUS = {
  draft: { label: 'Brouillon', tone: 'warning' },
  validated: { label: 'Validée', tone: 'success' },
  obsolete: { label: 'Obsolète', tone: 'neutral' },
} as const
export type BomVersionStatus = keyof typeof BOM_VERSION_STATUS

export const MAX_BOM_DEPTH = 8

export const label = (list: readonly { value: string; label: string }[], value: string | null | undefined) =>
  list.find((i) => i.value === value)?.label ?? value ?? '—'

export const unitLabel = (unit: string | null | undefined) => UNITS.find((u) => u.value === unit)?.label ?? unit ?? ''

/** Devise de calcul unique de l'ERP (pas de conversion). */
export const COSTING_CURRENCY = 'EUR'

const money = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: COSTING_CURRENCY, minimumFractionDigits: 2, maximumFractionDigits: 2 })
const money4 = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: COSTING_CURRENCY, minimumFractionDigits: 2, maximumFractionDigits: 4 })
const qty = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 3 })

export const formatMoney = (v: number | string | null | undefined) => (v === null || v === undefined || v === '' ? '—' : money.format(Number(v)))
/** Prix unitaires : jusqu'à 4 décimales (ex. fil à 0,0010 €/m). */
export const formatUnitPrice = (v: number | string | null | undefined) => (v === null || v === undefined || v === '' ? '—' : money4.format(Number(v)))
export const formatQty = (v: number | string | null | undefined) => (v === null || v === undefined || v === '' ? '—' : qty.format(Number(v)))
export const formatPct = (v: number | string | null | undefined) => (v === null || v === undefined ? '—' : `${qty.format(Number(v))} %`)
export const formatMinutes = (v: number | string) => {
  const m = Number(v)
  if (m >= 60) return `${Math.floor(m / 60)} h ${String(Math.round(m % 60)).padStart(2, '0')}`
  return `${qty.format(m)} min`
}
