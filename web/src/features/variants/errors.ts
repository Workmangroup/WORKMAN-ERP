interface DbError { message?: string; code?: string; details?: string | null }

const BY_CODE: [string, string][] = [
  ['VARIANT_PRODUCT_ARCHIVED', 'Ce produit est archivé : ses variantes sont en lecture seule (le stock reste gérable).'],
  ['VARIANT_PRODUCT_NOT_FOUND', 'Produit introuvable.'],
  ['VARIANT_NOT_FOUND', 'Variante introuvable.'],
  ['VARIANT_ATTRIBUTE_INACTIVE', 'Cette couleur ou cette taille est désactivée dans le catalogue.'],
  ['VARIANT_BAD_ATTRIBUTE', 'Couleur ou taille invalide.'],
  ['VARIANT_BAD_BOM', 'La nomenclature doit être une nomenclature produit active, du même client (ou sans article).'],
  ['VARIANT_EMPTY_SELECTION', 'Sélectionnez au moins une couleur et une taille.'],
  ['VARIANT_TOO_MANY', 'Trop de combinaisons à la fois (400 maximum).'],
  ['VARIANT_NO_SPEC', 'Le produit n’a pas de fiche technique à importer.'],
  ['VARIANT_HAS_STOCK', 'Suppression impossible : la variante a un historique de stock. Désactivez-la.'],
  ['VARIANT_STOCK_INSUFFICIENT', 'Stock disponible insuffisant (les pièces réservées ne sont pas disponibles).'],
  ['VARIANT_BAD_WAREHOUSE', 'Entrepôt invalide, archivé, ou identique à l’entrepôt d’origine.'],
  ['VARIANT_BAD_QTY', 'Quantité invalide.'],
  ['VARIANT_REASON_REQUIRED', 'Un motif est obligatoire pour un ajustement.'],
  ['VARIANT_NO_CHANGE', 'La quantité comptée est identique au stock : aucun écart à enregistrer.'],
  ['VARIANT_BAD_INPUT', 'Données invalides.'],
  ['VARIANT_REF_LOCKED', 'Cette donnée ne peut plus être modifiée.'],
  ['sizes_code_uq', 'Ce code de taille existe déjà.'],
  ['sizes_code_check', 'Code de taille invalide (lettres, chiffres, . / - ; 12 caractères maximum).'],
  ['colors_code_uq', 'Ce code de couleur existe déjà.'],
  ['colors_name_uq', 'Une couleur porte déjà ce nom.'],
  ['colors_code_check', 'Code de couleur invalide (lettres majuscules et chiffres, 10 maximum).'],
  ['colors_hex_check', 'Teinte invalide (format #RRGGBB).'],
  ['product_variants_sku_uq', 'Ce SKU existe déjà.'],
  ['product_variants_barcode_uq', 'Ce code-barres est déjà utilisé par une autre variante.'],
  ['product_variants_barcode_check', 'Code-barres invalide (somme de contrôle GTIN incorrecte : 8, 12, 13 ou 14 chiffres).'],
  ['product_variants_price_check', 'Prix invalide.'],
  ['product_variants_product_id_color_id_size_id_key', 'Cette variante existe déjà.'],
  ['product_variants_color_id_fkey', 'Cette couleur est utilisée par des variantes : désactivez-la plutôt que la supprimer.'],
  ['product_variants_size_id_fkey', 'Cette taille est utilisée par des variantes : désactivez-la plutôt que la supprimer.'],
  ['RBAC_FORBIDDEN', 'Vous n’avez pas la permission d’effectuer cette action.'],
]

export function variantErrorMessage(err: DbError | null | undefined): string {
  const text = `${err?.message ?? ''} ${err?.details ?? ''}`
  for (const [k, msg] of BY_CODE) if (text.includes(k)) return msg
  if (err?.code === '42501' || text.includes('row-level security')) return 'Vous n’avez pas la permission d’effectuer cette action.'
  if (err?.code === '23503') return 'Cet élément est utilisé ailleurs : désactivez-le plutôt que de le supprimer.'
  if (err?.code === '23514') return 'Une valeur ne respecte pas les règles de saisie. Vérifiez le formulaire.'
  return 'Une erreur est survenue. Réessayez ou contactez un administrateur.'
}

export const isPermissionError = (err: DbError | null | undefined) =>
  Boolean(err && (err.code === '42501' || err.message?.includes('RBAC_FORBIDDEN') || err.message?.includes('row-level security')))
