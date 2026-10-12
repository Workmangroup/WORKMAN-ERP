interface DbError {
  message?: string
  code?: string
  details?: string | null
}

const BY_CODE: [string, string][] = [
  ['CLIENT_ARCHIVED', 'Ce client est archivé : sa GED est en lecture seule.'],
  ['GED_TRASHED', 'Ce document est dans la corbeille.'],
  ['GED_NOT_TRASHED', 'Ce document n’est pas dans la corbeille.'],
  ['GED_BAD_STATUS', 'Cette action n’est pas possible dans l’état actuel du document.'],
  ['GED_COMMENT_REQUIRED', 'Un commentaire est obligatoire pour rejeter un document.'],
  ['GED_SYSTEM_FOLDER', 'Les dossiers système ne peuvent être ni renommés ni supprimés.'],
  ['GED_FOLDER_NOT_EMPTY', 'Ce dossier n’est pas vide (documents, corbeille ou sous-dossiers).'],
  ['GED_TOO_DEEP', 'Les dossiers sont limités à 3 niveaux.'],
  ['GED_BAD_FOLDER', 'Dossier de destination invalide.'],
  ['GED_BAD_PARENT', 'Dossier parent invalide.'],
  ['GED_TOO_MANY_TAGS', 'Dix mots-clés maximum.'],
  ['GED_INVALID_PATH', 'Chemin de fichier invalide.'],
  ['GED_NOT_FOUND', 'Élément introuvable.'],
  ['ged_folders_name_uq', 'Un dossier porte déjà ce nom à cet emplacement.'],
  ['RBAC_FORBIDDEN', 'Vous n’avez pas la permission d’effectuer cette action.'],
]

export function gedErrorMessage(err: DbError | null | undefined): string {
  const text = `${err?.message ?? ''} ${err?.details ?? ''}`
  for (const [k, msg] of BY_CODE) if (text.includes(k)) return msg
  if (err?.code === '42501' || text.includes('row-level security')) return 'Vous n’avez pas la permission d’effectuer cette action.'
  if (err?.code === '23514') return 'Une valeur ne respecte pas les règles de saisie (titre, taille, empreinte…).'
  return 'Une erreur est survenue. Réessayez ou contactez un administrateur.'
}

export const isPermissionError = (err: DbError | null | undefined) =>
  Boolean(err && (err.code === '42501' || err.message?.includes('RBAC_FORBIDDEN') || err.message?.includes('row-level security')))
