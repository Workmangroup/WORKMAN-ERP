/** Listes de valeurs du module Clients (libellés FR). Les codes doivent rester alignés avec les CHECK de 0004_clients.sql. */

export const COUNTRY_CODES = [
  'TN', 'FR', 'DE', 'BE', 'NL', 'LU', 'IT', 'ES', 'PT', 'GB', 'IE', 'CH', 'AT', 'SE', 'DK', 'NO', 'FI', 'IS',
  'PL', 'CZ', 'SK', 'HU', 'RO', 'BG', 'GR', 'HR', 'SI', 'EE', 'LV', 'LT', 'MT', 'CY',
  'MA', 'DZ', 'LY', 'EG', 'TR', 'AE', 'SA', 'QA', 'US', 'CA', 'CN', 'JP',
] as const

let regionNames: Intl.DisplayNames | null = null
export function countryName(code: string | null | undefined): string {
  if (!code) return '—'
  try {
    regionNames ??= new Intl.DisplayNames(['fr'], { type: 'region' })
    return regionNames.of(code) ?? code
  } catch {
    return code
  }
}

/** Émoji drapeau à partir du code ISO (aucune image à charger). */
export function flag(code: string | null | undefined): string {
  if (!code || code.length !== 2) return ''
  return String.fromCodePoint(...[...code.toUpperCase()].map((c) => 127397 + c.charCodeAt(0)))
}

export const countryOptions = () =>
  [...COUNTRY_CODES].map((c) => ({ value: c as string, label: countryName(c) })).sort((a, b) => a.label.localeCompare(b.label, 'fr'))

export const CURRENCIES = ['EUR', 'TND', 'USD', 'GBP', 'CHF', 'SEK', 'DKK', 'NOK', 'PLN', 'CZK', 'MAD'] as const

export const LANGUAGES = [
  { value: 'fr', label: 'Français' },
  { value: 'en', label: 'Anglais' },
  { value: 'de', label: 'Allemand' },
  { value: 'es', label: 'Espagnol' },
  { value: 'it', label: 'Italien' },
  { value: 'nl', label: 'Néerlandais' },
] as const

export const PAYMENT_METHODS = [
  { value: 'transfer', label: 'Virement' },
  { value: 'cheque', label: 'Chèque' },
  { value: 'lc', label: 'Lettre de crédit' },
  { value: 'cash', label: 'Espèces' },
  { value: 'other', label: 'Autre' },
] as const

export const INCOTERMS = ['EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP'] as const

export const ADDRESS_TYPES = [
  { value: 'head_office', label: 'Siège social' },
  { value: 'billing', label: 'Facturation' },
  { value: 'delivery', label: 'Livraison' },
  { value: 'other', label: 'Autre' },
] as const

export const DOCUMENT_TYPES = [
  { value: 'contract', label: 'Contrat' },
  { value: 'nda', label: 'Accord de confidentialité' },
  { value: 'quality_agreement', label: 'Accord qualité' },
  { value: 'certificate', label: 'Certificat' },
  { value: 'specification', label: 'Cahier des charges' },
  { value: 'tax', label: 'Document fiscal' },
  { value: 'identification', label: 'Pièce d’identification' },
  { value: 'other', label: 'Autre' },
] as const

export const label = (list: readonly { value: string; label: string }[], value: string | null | undefined) =>
  list.find((i) => i.value === value)?.label ?? value ?? '—'

/** Libellés des champs pour l'historique des modifications. */
export const FIELD_LABELS: Record<string, string> = {
  name: 'Raison sociale', legal_name: 'Dénomination légale', code: 'Code', tax_id: 'Identifiant fiscal',
  registration_no: 'Registre du commerce', website: 'Site web', email: 'E-mail', phone: 'Téléphone', mobile: 'Mobile',
  country: 'Pays', currency: 'Devise', language: 'Langue', payment_terms_id: 'Conditions de paiement',
  payment_method: 'Mode de règlement', credit_limit: 'Plafond de crédit', incoterm: 'Incoterm', vat_exempt: 'Exonéré de TVA',
  delivery_tolerance_pct: 'Tolérance de livraison (%)', aql_level: 'Niveau AQL', sales_rep_id: 'Commercial affecté',
  notes: 'Notes', full_name: 'Nom', job_title: 'Fonction', is_primary: 'Contact principal', type: 'Type',
  label: 'Libellé', line1: 'Adresse', line2: 'Complément', postal_code: 'Code postal', city: 'Ville', region: 'Région',
  is_default: 'Adresse par défaut', title: 'Titre', doc_type: 'Type de document', file_name: 'Fichier',
  mime_type: 'Format', size_bytes: 'Taille', valid_until: 'Valide jusqu’au', client_id: 'Client', id: 'Identifiant',
}
