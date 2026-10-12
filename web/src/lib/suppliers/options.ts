export { COUNTRY_CODES, CURRENCIES, INCOTERMS, LANGUAGES, PAYMENT_METHODS, countryName, countryOptions, label } from '@/lib/clients/options'

export const SUPPLIER_CATEGORIES = [
  { value: 'fabric', label: 'Tissus' },
  { value: 'accessories', label: 'Fournitures et accessoires' },
  { value: 'packaging', label: 'Emballage' },
  { value: 'subcontracting', label: 'Sous-traitance' },
  { value: 'services', label: 'Services' },
  { value: 'other', label: 'Autre' },
] as const

export const QUALIFICATIONS = [
  { value: 'pending', label: 'En qualification', tone: 'warning' },
  { value: 'approved', label: 'Agréé', tone: 'success' },
  { value: 'blocked', label: 'Bloqué', tone: 'danger' },
] as const

export const SUPPLIER_DOC_TYPES = [
  { value: 'contract', label: 'Contrat' },
  { value: 'price_list', label: 'Tarifs' },
  { value: 'certificate', label: 'Certificat' },
  { value: 'quality_agreement', label: 'Accord qualité' },
  { value: 'nda', label: 'Accord de confidentialité' },
  { value: 'tax', label: 'Document fiscal' },
  { value: 'identification', label: 'Pièce d’identification' },
  { value: 'other', label: 'Autre' },
] as const

export const PO_STATUS = {
  draft: { label: 'Brouillon', tone: 'neutral' },
  sent: { label: 'Envoyée', tone: 'brand' },
  partial: { label: 'Partielle', tone: 'warning' },
  received: { label: 'Reçue', tone: 'success' },
  cancelled: { label: 'Annulée', tone: 'danger' },
} as const

export const SUPPLIER_FIELD_LABELS: Record<string, string> = {
  name: 'Raison sociale', legal_name: 'Dénomination légale', code: 'Code', category: 'Catégorie', qualification: 'Qualification',
  rating: 'Note', tax_id: 'Identifiant fiscal', registration_no: 'Registre du commerce', website: 'Site web', email: 'E-mail',
  phone: 'Téléphone', address_line1: 'Adresse', address_line2: 'Complément', postal_code: 'Code postal', city: 'Ville', region: 'Région',
  country: 'Pays', currency: 'Devise', language: 'Langue', payment_terms_id: 'Conditions de paiement', payment_method: 'Mode de règlement',
  lead_time_days: 'Délai de livraison (jours)', min_order_amount: 'Minimum de commande', incoterm: 'Incoterm', incoterm_place: 'Lieu Incoterm',
  buyer_id: 'Acheteur référent', notes: 'Notes', full_name: 'Nom', job_title: 'Fonction', mobile: 'Mobile', is_primary: 'Contact principal',
  title: 'Titre', doc_type: 'Type de document', file_name: 'Fichier', size_bytes: 'Taille', valid_until: 'Valide jusqu’au',
}
