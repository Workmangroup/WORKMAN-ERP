/** Valeurs métier du module Articles (libellés FR). Alignées avec 0007_articles.sql. */

export const FAMILIES = [
  { value: 'jacket', label: 'Veste' },
  { value: 'parka', label: 'Parka / blouson' },
  { value: 'trousers', label: 'Pantalon' },
  { value: 'coverall', label: 'Combinaison' },
  { value: 'vest', label: 'Gilet' },
  { value: 'polo', label: 'Polo' },
  { value: 'tshirt', label: 'T-shirt' },
  { value: 'shirt', label: 'Chemise' },
  { value: 'apron', label: 'Tablier' },
  { value: 'accessory', label: 'Accessoire' },
  { value: 'other', label: 'Autre' },
] as const

export const ARTICLE_STATUS = {
  draft: { label: 'En préparation', tone: 'neutral' },
  active: { label: 'Actif', tone: 'success' },
  discontinued: { label: 'Arrêté', tone: 'warning' },
} as const
export type ArticleStatus = keyof typeof ARTICLE_STATUS

export const VERSION_STATUS = {
  draft: { label: 'Brouillon', tone: 'warning' },
  validated: { label: 'Validée', tone: 'success' },
  obsolete: { label: 'Obsolète', tone: 'neutral' },
} as const

export const PHOTO_VIEWS = [
  { value: 'front', label: 'Face' }, { value: 'back', label: 'Dos' }, { value: 'side', label: 'Côté' },
  { value: 'detail', label: 'Détail' }, { value: 'label', label: 'Étiquette' }, { value: 'packaging', label: 'Packaging' }, { value: 'other', label: 'Autre' },
] as const

/** Normes courantes du vêtement professionnel (suggestions ; le champ reste libre). */
export const NORM_SUGGESTIONS = [
  { code: 'EN ISO 20471', label: 'Haute visibilité' },
  { code: 'EN 343', label: 'Protection contre la pluie' },
  { code: 'EN 1149-5', label: 'Propriétés antistatiques' },
  { code: 'EN ISO 11612', label: 'Chaleur et flamme' },
  { code: 'EN ISO 11611', label: 'Soudage' },
  { code: 'EN 13034', label: 'Produits chimiques liquides (type 6)' },
  { code: 'EN 14116', label: 'Propagation de flamme limitée' },
  { code: 'EN 61482-1-2', label: 'Arc électrique' },
  { code: 'EN 342', label: 'Protection contre le froid' },
  { code: 'OEKO-TEX Standard 100', label: 'Substances nocives' },
  { code: 'REACH', label: 'Règlement européen des substances chimiques' },
] as const

export const WASH = [
  { value: '30', label: 'Lavage 30 °C' }, { value: '40', label: 'Lavage 40 °C' }, { value: '60', label: 'Lavage 60 °C' },
  { value: '95', label: 'Lavage 95 °C' }, { value: 'hand', label: 'Lavage à la main' }, { value: 'no', label: 'Ne pas laver' },
] as const
export const BLEACH = [{ value: 'none', label: 'Pas de javel' }, { value: 'allowed', label: 'Javel autorisée' }] as const
export const TUMBLE = [{ value: 'no', label: 'Pas de sèche-linge' }, { value: 'low', label: 'Sèche-linge basse température' }, { value: 'normal', label: 'Sèche-linge température normale' }] as const
export const IRON = [{ value: 'no', label: 'Ne pas repasser' }, { value: '110', label: 'Repassage 110 °C max.' }, { value: '150', label: 'Repassage 150 °C max.' }, { value: '200', label: 'Repassage 200 °C max.' }] as const
export const DRY_CLEAN = [{ value: 'no', label: 'Pas de nettoyage à sec' }, { value: 'yes', label: 'Nettoyage à sec autorisé' }] as const

export const SIZE_PRESETS = [
  { label: 'Lettres (XS → 4XL)', sizes: ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL'] },
  { label: 'Hauts (S → 3XL)', sizes: ['S', 'M', 'L', 'XL', '2XL', '3XL'] },
  { label: 'Pantalons (36 → 60)', sizes: ['36', '38', '40', '42', '44', '46', '48', '50', '52', '54', '56', '58', '60'] },
  { label: 'Chaussettes / accessoires', sizes: ['Unique'] },
] as const

export const label = (list: readonly { value: string; label: string }[], value: string | null | undefined) =>
  list.find((i) => i.value === value)?.label ?? value ?? '—'

/** Structure de la fiche d'une version (colonne JSON article_versions.spec). */
export interface ColorSpec { name: string; code?: string; hex?: string; pantone?: string; client_code?: string }
export interface SizeSpec { label: string; client_code?: string }
export interface NormSpec { code: string; label?: string; class?: string; certificate_ref?: string; valid_until?: string }
export interface PackagingSpec {
  unit?: string; units_per_carton?: number; carton_weight_kg?: number
  carton_dims_cm?: { l?: number; w?: number; h?: number }; labeling?: string; instructions?: string
}
export interface CareSpec { wash?: string; bleach?: string; tumble?: string; iron?: string; dry_clean?: string; composition?: string; instructions?: string }
export interface ArticleSpec { colors: ColorSpec[]; sizes: SizeSpec[]; norms: NormSpec[]; packaging: PackagingSpec; care: CareSpec }

export const EMPTY_SPEC: ArticleSpec = { colors: [], sizes: [], norms: [], packaging: {}, care: {} }

export const SPEC_SECTIONS: Record<string, string> = { colors: 'Couleurs', sizes: 'Tailles', norms: 'Normes', packaging: 'Packaging', care: 'Instructions de lavage' }

export const ARTICLE_FIELD_LABELS: Record<string, string> = {
  internal_ref: 'Référence interne', client_ref: 'Référence client', name: 'Désignation', family: 'Famille', description: 'Description', status: 'Statut',
}
