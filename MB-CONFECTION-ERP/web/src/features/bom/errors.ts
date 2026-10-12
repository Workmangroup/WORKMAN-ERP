interface DbError {
  message?: string
  code?: string
  details?: string | null
}

const BY_CODE: [string, string][] = [
  ['CLIENT_ARCHIVED', 'Le client de l’article est archivé : la nomenclature est en lecture seule.'],
  ['BOM_VERSION_LOCKED', 'Cette version est validée : créez une nouvelle version pour la modifier.'],
  ['BOM_ARCHIVED', 'Cette nomenclature est archivée : restaurez-la pour la modifier.'],
  ['BOM_EMPTY', 'Validation impossible : la nomenclature ne contient aucun composant.'],
  ['BOM_PRICE_MISSING', 'Validation impossible : des composants n’ont pas de prix. Demandez à l’achat de les renseigner'],
  ['BOM_MATERIAL_ARCHIVED', 'Un composant archivé ne peut pas être utilisé'],
  ['BOM_CHILD_NOT_VALIDATED', 'Validation impossible : un sous-ensemble n’a pas de version validée (ou est archivé)'],
  ['BOM_CHILD_ARCHIVED', 'Ce sous-ensemble est archivé.'],
  ['BOM_CYCLE', 'Boucle interdite : ce sous-ensemble contient déjà (directement ou non) la nomenclature en cours.'],
  ['BOM_TOO_DEEP', 'Nomenclature trop profonde (8 niveaux maximum).'],
  ['BOM_DRAFT_EXISTS', 'Un brouillon existe déjà : validez-le ou abandonnez-le avant d’en créer un autre.'],
  ['BOM_BAD_STATUS', 'Cette action n’est pas possible dans l’état actuel.'],
  ['BOM_FIRST_VERSION', 'La première version ne peut pas être abandonnée.'],
  ['BOM_IN_USE', 'Suppression impossible : la nomenclature est validée ou sert de sous-ensemble. Archivez-la plutôt.'],
  ['BOM_USED_AS_CHILD', 'Archivage impossible : cette nomenclature sert de sous-ensemble dans les nomenclatures'],
  ['BOM_NOT_ARCHIVED', 'Cette nomenclature n’est pas archivée.'],
  ['BOM_BAD_ARTICLE', 'Article invalide pour cette nomenclature (un sous-ensemble n’est pas rattaché à un article).'],
  ['BOM_INVALID_NAME', 'Le nom doit contenir au moins 2 caractères.'],
  ['BOM_NOT_FOUND', 'Nomenclature introuvable.'],
  ['BOM_MATERIAL_NOT_FOUND', 'Composant introuvable.'],
  ['BOM_MATERIAL_IN_USE', 'Suppression impossible : ce composant est utilisé. Archivez-le plutôt.'],
  ['BOM_MATERIAL_UNIT_LOCKED', 'L’unité ne peut plus changer : le composant est déjà utilisé dans une nomenclature.'],
  ['BOM_BAD_SUPPLIER', 'Fournisseur invalide.'],
  ['boms_article_uq', 'Cet article possède déjà une nomenclature active.'],
  ['boms_subassembly_no_article', 'Un sous-ensemble ne se rattache pas à un article.'],
  ['bom_lines_kind_ck', 'Ligne invalide : choisissez un composant ou un sous-ensemble (sans perte pour un sous-ensemble).'],
  ['bom_lines_quantity_check', 'La quantité doit être supérieure à 0.'],
  ['bom_operations_minutes_check', 'La durée doit être comprise entre 0,01 et 600 minutes.'],
  ['RBAC_FORBIDDEN', 'Vous n’avez pas la permission d’effectuer cette action.'],
]

export function bomErrorMessage(err: DbError | null | undefined): string {
  const text = `${err?.message ?? ''} ${err?.details ?? ''}`
  for (const [k, msg] of BY_CODE) {
    if (!text.includes(k)) continue
    // les codes « liste » ajoutent le détail (composants concernés) en fin de message
    const extra = ['BOM_PRICE_MISSING', 'BOM_MATERIAL_ARCHIVED', 'BOM_CHILD_NOT_VALIDATED', 'BOM_USED_AS_CHILD'].includes(k) && err?.details ? ` : ${err.details}.` : msg.endsWith('.') ? '' : '.'
    return msg + extra
  }
  if (err?.code === '42501' || text.includes('row-level security')) return 'Vous n’avez pas la permission d’effectuer cette action.'
  if (err?.code === '23514') return 'Une valeur ne respecte pas les règles de saisie. Vérifiez le formulaire.'
  return 'Une erreur est survenue. Réessayez ou contactez un administrateur.'
}

export const isPermissionError = (err: DbError | null | undefined) =>
  Boolean(err && (err.code === '42501' || err.message?.includes('RBAC_FORBIDDEN') || err.message?.includes('row-level security')))
