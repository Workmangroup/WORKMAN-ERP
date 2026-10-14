/** Valeurs métier du module PDM (libellés FR). Alignées avec 0013_pdm.sql. */
import { FAMILIES, PHOTO_VIEWS, WASH, BLEACH, TUMBLE, IRON, DRY_CLEAN, NORM_SUGGESTIONS, SIZE_PRESETS, label } from '@/lib/articles/options'

export { FAMILIES, PHOTO_VIEWS, WASH, BLEACH, TUMBLE, IRON, DRY_CLEAN, NORM_SUGGESTIONS, SIZE_PRESETS, label }

/** Statuts du dossier technique (0068) : brouillon, prototype, revue, approuvé, obsolète. */
export const VERSION_STATUS = {
  draft: { label: 'Brouillon', tone: 'warning' },
  prototype: { label: 'Prototype', tone: 'neutral' },
  review: { label: 'En revue', tone: 'warning' },
  validated: { label: 'Approuvée', tone: 'success' },
  obsolete: { label: 'Obsolète', tone: 'neutral' },
} as const

export const PRODUCT_STATUS = {
  draft: { label: 'En préparation', tone: 'neutral' },
  active: { label: 'Actif', tone: 'success' },
  archived: { label: 'Archivé', tone: 'warning' },
} as const
export type ProductStatus = keyof typeof PRODUCT_STATUS

export const DOC_KINDS = [
  { value: 'tech_sheet', label: 'Fiche technique' },
  { value: 'pattern', label: 'Patronage' },
  { value: 'marker', label: 'Plan de coupe / marqueur' },
  { value: 'grading', label: 'Gradation' },
  { value: 'sample_approval', label: 'Validation d’échantillon' },
  { value: 'test_report', label: 'Rapport d’essai' },
  { value: 'label', label: 'Étiquetage' },
  { value: 'packaging', label: 'Packaging' },
  { value: 'other', label: 'Autre' },
] as const
export const PATTERN_KINDS: readonly string[] = ['pattern', 'marker', 'grading']

export const CERT_TYPES = [
  { value: 'product', label: 'Produit fini' }, { value: 'material', label: 'Matière' },
  { value: 'process', label: 'Procédé / site' }, { value: 'other', label: 'Autre' },
] as const
export const CERT_STATUS = [
  { value: 'valid', label: 'Valide' }, { value: 'suspended', label: 'Suspendue' }, { value: 'revoked', label: 'Retirée' },
] as const

export type CertState = 'valid' | 'no_expiry' | 'expiring' | 'expired' | 'suspended' | 'revoked'
export const CERT_STATE_INFO: Record<CertState, { label: string; tone: 'success' | 'neutral' | 'warning' | 'danger' }> = {
  valid: { label: 'Valide', tone: 'success' },
  no_expiry: { label: 'Valide (sans échéance)', tone: 'success' },
  expiring: { label: 'Expire bientôt', tone: 'warning' },
  expired: { label: 'Expirée', tone: 'danger' },
  suspended: { label: 'Suspendue', tone: 'warning' },
  revoked: { label: 'Retirée', tone: 'danger' },
}
export const EXPIRY_WARN_DAYS = 60
export function certState(c: { status: string; valid_until: string | null }, today = new Date()): CertState {
  if (c.status === 'revoked') return 'revoked'
  if (c.status === 'suspended') return 'suspended'
  if (!c.valid_until) return 'no_expiry'
  const days = Math.ceil((new Date(`${c.valid_until.slice(0, 10)}T23:59:59`).getTime() - today.getTime()) / 86_400_000)
  return days < 0 ? 'expired' : days <= EXPIRY_WARN_DAYS ? 'expiring' : 'valid'
}

// ---------------------------------------------------------------------
// Fiche technique d'une version (colonne JSON product_versions.spec)
// ---------------------------------------------------------------------
export interface TechSpec { composition?: string; fabric?: string; weight_gsm?: number; season?: string; gender?: string; construction?: string; finishing?: string; notes?: string }
export interface ColorSpec { name: string; hex?: string; pantone?: string; client_code?: string }
export interface SizeSpec { label: string; client_code?: string }
export interface VariantSpec { sku: string; color?: string; size?: string; barcode?: string; active?: boolean }
export interface MeasureSpec { point: string; tolerance?: number; values: Record<string, number> }
export interface PackagingSpec { unit?: string; units_per_carton?: number; carton_weight_kg?: number; carton_dims_cm?: { l?: number; w?: number; h?: number }; labeling?: string; instructions?: string }
export interface CareSpec { wash?: string; bleach?: string; tumble?: string; iron?: string; dry_clean?: string; instructions?: string }
export interface ProductSpec { tech: TechSpec; colors: ColorSpec[]; sizes: SizeSpec[]; variants: VariantSpec[]; measurements: MeasureSpec[]; care: CareSpec; packaging: PackagingSpec }
export const EMPTY_SPEC: ProductSpec = { tech: {}, colors: [], sizes: [], variants: [], measurements: [], care: {}, packaging: {} }
export const withSpec = (s: Partial<ProductSpec> | null | undefined): ProductSpec => ({ ...EMPTY_SPEC, ...(s ?? {}) })

export const SEASONS = ['Permanent', 'Printemps / Été', 'Automne / Hiver'] as const
export const GENDERS = [{ value: 'unisex', label: 'Mixte' }, { value: 'men', label: 'Homme' }, { value: 'women', label: 'Femme' }] as const
export const MEASURE_PRESETS = ['Tour de poitrine', 'Tour de taille', 'Tour de hanches', 'Longueur dos', 'Longueur de manche', 'Carrure dos', 'Entrejambe', 'Longueur extérieure'] as const

const abbr = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 3) || 'X'
const clean = (s: string) => s.replace(/[^A-Za-z0-9]/g, '').toUpperCase() || 'X'

/** Matrice couleurs × tailles : conserve code-barres / actif des variantes existantes, SKU unique garanti. */
export function buildVariants(code: string, colors: ColorSpec[], sizes: SizeSpec[], existing: VariantSpec[]): VariantSpec[] {
  const byKey = new Map(existing.map((v) => [`${v.color ?? ''}|${v.size ?? ''}`, v]))
  const used = new Set<string>()
  const out: VariantSpec[] = []
  for (const c of colors) {
    for (const s of sizes) {
      const old = byKey.get(`${c.name}|${s.label}`)
      const base = old?.sku ?? `${code}-${abbr(c.name)}-${clean(s.label)}`
      let sku = base
      let n = 2
      while (used.has(sku.toUpperCase())) sku = `${base}-${n++}`
      used.add(sku.toUpperCase())
      out.push({ sku, color: c.name, size: s.label, barcode: old?.barcode, active: old?.active ?? true })
    }
  }
  return out
}

// ---------------------------------------------------------------------
// Comparaison de versions : libellés
// ---------------------------------------------------------------------
export const SECTION_LABELS: Record<string, string> = {
  header: 'Entête du produit', tech: 'Fiche technique', colors: 'Couleurs', sizes: 'Tailles', variants: 'Variantes', measurements: 'Tableau de mesures',
  care: 'Entretien', packaging: 'Packaging', certifications: 'Certifications', documents: 'Documents',
}
export const FIELD_LABELS: Record<string, string> = {
  name: 'Désignation', family: 'Famille', article: 'Article client', bom: 'Nomenclature', photos: 'Photos',
  composition: 'Composition', fabric: 'Tissu', weight_gsm: 'Grammage (g/m²)', season: 'Saison', gender: 'Genre', construction: 'Construction', finishing: 'Finitions', notes: 'Notes',
  hex: 'Couleur', pantone: 'Pantone', client_code: 'Code client', color: 'Couleur', size: 'Taille', barcode: 'Code-barres', active: 'Actif', sku: 'SKU', tolerance: 'Tolérance (cm)',
  wash: 'Lavage', bleach: 'Javel', tumble: 'Sèche-linge', iron: 'Repassage', dry_clean: 'Nettoyage à sec', instructions: 'Consignes',
  unit: 'Unité de vente', units_per_carton: 'Pièces par carton', carton_weight_kg: 'Poids du carton (kg)', labeling: 'Étiquetage', carton_dims_cm: 'Dimensions du carton',
  class_level: 'Classe', issuer: 'Organisme', valid_until: 'Valide jusqu’au', status: 'Statut', revision: 'Révision',
}
export interface ChangeRow { section: string; path: string; a: unknown; b: unknown; change: 'added' | 'removed' | 'changed' }

/** `colors[Jaune HV].hex` → { item: 'Jaune HV', field: 'Couleur' } ; `tech.weight_gsm` → { field: 'Grammage (g/m²)' }. */
export function describePath(path: string): { item?: string; field?: string } {
  const m = path.match(/^[a-z_]+\[(.*?)\](?:\.(.+))?$/s)
  if (m) {
    const [, item, rest] = m
    if (!rest) return { item }
    const parts = rest.split('.')
    return { item, field: parts[0] === 'values' ? `Mesure ${parts.slice(1).join('.')}` : parts.map((p) => FIELD_LABELS[p] ?? p).join(' › ') }
  }
  const [, ...rest] = path.split('.')
  return { field: rest.map((p) => FIELD_LABELS[p] ?? p).join(' › ') }
}
export function showValue(path: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—'
  if (typeof v === 'boolean') return v ? 'Oui' : 'Non'
  const s = String(v)
  const last = path.split('.').pop() ?? ''
  if (last === 'family') return label(FAMILIES, s)
  if (last === 'wash') return label(WASH, s)
  if (last === 'bleach') return label(BLEACH, s)
  if (last === 'tumble') return label(TUMBLE, s)
  if (last === 'iron') return label(IRON, s)
  if (last === 'dry_clean') return label(DRY_CLEAN, s)
  if (last === 'gender') return label(GENDERS, s)
  if (last === 'status') return [...CERT_STATUS].find((c) => c.value === s)?.label ?? s
  return s.length > 140 ? `${s.slice(0, 137)}…` : s
}

export const PRODUCT_FIELD_LABELS: Record<string, string> = { name: 'Désignation', family: 'Famille', description: 'Description', article_id: 'Article client', status: 'Statut' }
