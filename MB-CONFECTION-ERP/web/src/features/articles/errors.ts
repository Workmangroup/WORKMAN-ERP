interface DbError {
  message?: string
  code?: string
  details?: string | null
}

const BY_CODE: [string, string][] = [
  ['CLIENT_ARCHIVED', 'Ce client est archivé : ses articles sont en lecture seule.'],
  ['ARTICLE_VERSION_LOCKED', 'Cette version est validée : créez une nouvelle version pour la modifier.'],
  ['ARTICLE_NO_VALIDATED_VERSION', 'Un article ne peut devenir actif qu’après validation d’une version.'],
  ['ARTICLE_SPEC_INCOMPLETE', 'Validation impossible : indiquez au moins une couleur et une taille.'],
  ['ARTICLE_DRAFT_EXISTS', 'Un brouillon existe déjà : validez-le ou abandonnez-le avant d’en créer un autre.'],
  ['ARTICLE_BAD_STATUS', 'Cette action n’est pas possible dans l’état actuel de la version.'],
  ['ARTICLE_FIRST_VERSION', 'La première version ne peut pas être abandonnée.'],
  ['ARTICLE_IN_USE', 'Suppression impossible : l’article a déjà eu une version validée. Passez-le en « Arrêté ».'],
  ['ARTICLE_INVALID_REF', 'Référence interne invalide (lettres, chiffres, - et _ ; 2 à 30 caractères).'],
  ['ARTICLE_REF_LOCKED', 'La référence interne ne peut plus être modifiée.'],
  ['ARTICLE_TOO_MANY_PHOTOS', 'Vingt photos maximum par article.'],
  ['ARTICLE_INVALID_PATH', 'Chemin de fichier invalide.'],
  ['ARTICLE_NOT_FOUND', 'Article introuvable.'],
  ['article_versions_spec_ck', 'La fiche contient une valeur invalide (couleur, taille, norme ou lavage).'],
  ['articles_client_ref_uq', 'Ce client possède déjà un article avec cette référence client.'],
  ['articles_company_id_internal_ref_key', 'Cette référence interne existe déjà.'],
  ['boms_article_id_fkey', 'Suppression impossible : une nomenclature (BOM) est rattachée à cet article.'],
  ['GED_BAD_ARTICLE', 'L’article doit appartenir au même client que le document.'],
  ['RBAC_FORBIDDEN', 'Vous n’avez pas la permission d’effectuer cette action.'],
]

export function articleErrorMessage(err: DbError | null | undefined): string {
  const text = `${err?.message ?? ''} ${err?.details ?? ''}`
  for (const [k, msg] of BY_CODE) if (text.includes(k)) return msg
  if (err?.code === '42501' || text.includes('row-level security')) return 'Vous n’avez pas la permission d’effectuer cette action.'
  if (err?.code === '23514') return 'Une valeur ne respecte pas les règles de saisie. Vérifiez le formulaire.'
  return 'Une erreur est survenue. Réessayez ou contactez un administrateur.'
}

export const isPermissionError = (err: DbError | null | undefined) =>
  Boolean(err && (err.code === '42501' || err.message?.includes('RBAC_FORBIDDEN') || err.message?.includes('row-level security')))
