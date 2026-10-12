interface DbError { message?: string; code?: string; details?: string | null }

const BY_CODE: [string, string][] = [
  ['CLIENT_ARCHIVED', 'Ce client est archivé : ses produits sont en lecture seule.'],
  ['PRODUCT_ARCHIVED', 'Ce produit est archivé : restaurez-le pour le modifier.'],
  ['PRODUCT_VERSION_LOCKED', 'Cette version est validée : créez une nouvelle version pour la modifier.'],
  ['PRODUCT_SPEC_INCOMPLETE', 'Validation impossible : indiquez au moins une couleur et une taille.'],
  ['PRODUCT_DRAFT_EXISTS', 'Un brouillon existe déjà : validez-le ou abandonnez-le avant d’en créer un autre.'],
  ['PRODUCT_BAD_STATUS', 'Cette action n’est pas possible dans l’état actuel.'],
  ['PRODUCT_FIRST_VERSION', 'La première version ne peut pas être abandonnée.'],
  ['PRODUCT_IN_USE', 'Suppression impossible : une version a déjà été validée. Archivez le produit à la place.'],
  ['PRODUCT_TOO_MANY_PHOTOS', 'Trente photos maximum par produit.'],
  ['PRODUCT_INVALID_PATH', 'Chemin de fichier invalide.'],
  ['PRODUCT_NOT_FOUND', 'Produit introuvable.'],
  ['PRODUCT_BAD_ARTICLE', 'L’article doit appartenir au même client que le produit.'],
  ['PRODUCT_BAD_DOCUMENT', 'Le document doit appartenir au même client que le produit (et ne pas être dans la corbeille).'],
  ['PRODUCT_COMPARE_MISMATCH', 'Les deux versions doivent appartenir au même produit.'],
  ['PRODUCT_REF_LOCKED', 'Cette donnée ne peut plus être modifiée.'],
  ['product_master_article_uq', 'Cet article est déjà lié à un autre produit.'],
  ['product_documents_product_id_ged_document_id_key', 'Ce document est déjà rattaché au produit.'],
  ['product_cert_dates_ck', 'La date de validité doit être postérieure à la date d’émission.'],
  ['product_versions_spec_ck', 'La fiche contient une valeur invalide (doublon de couleur, taille, SKU ou mesure, lavage…).'],
  ['RBAC_FORBIDDEN', 'Vous n’avez pas la permission d’effectuer cette action.'],
]

export function productErrorMessage(err: DbError | null | undefined): string {
  const text = `${err?.message ?? ''} ${err?.details ?? ''}`
  for (const [k, msg] of BY_CODE) if (text.includes(k)) return msg
  if (err?.code === '42501' || text.includes('row-level security')) return 'Vous n’avez pas la permission d’effectuer cette action.'
  if (err?.code === '23514') return 'Une valeur ne respecte pas les règles de saisie. Vérifiez le formulaire.'
  return 'Une erreur est survenue. Réessayez ou contactez un administrateur.'
}

export const isPermissionError = (err: DbError | null | undefined) =>
  Boolean(err && (err.code === '42501' || err.message?.includes('RBAC_FORBIDDEN') || err.message?.includes('row-level security')))
