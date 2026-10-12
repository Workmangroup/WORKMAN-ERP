interface DbError {
  message?: string
  code?: string
  details?: string | null
}

const BY_CODE: [string, string][] = [
  ['CLIENT_ARCHIVED', 'Ce client est archivé : restaurez-le avant de le modifier.'],
  ['CLIENT_NOT_ARCHIVED', 'Seul un client archivé peut être supprimé définitivement (ou restauré).'],
  ['CLIENT_NOT_FOUND', 'Client introuvable.'],
  ['CLIENT_IN_USE', 'Suppression impossible : des données liées (comptes portail, commandes…) référencent ce client. Conservez-le archivé.'],
  ['CLIENT_INVALID_REP', 'Le commercial affecté est invalide (compte inactif ou d’une autre société).'],
  ['CLIENT_INVALID_TERMS', 'Conditions de paiement invalides.'],
  ['CLIENT_CODE_LOCKED', 'Le code client ne peut plus être modifié.'],
  ['CLIENT_INVALID_CODE', 'Code client invalide (lettres, chiffres, - et _ ; 2 à 20 caractères).'],
  ['CLIENT_INVALID_PATH', 'Chemin de fichier invalide.'],
  ['RBAC_FORBIDDEN', 'Vous n’avez pas la permission d’effectuer cette action.'],
]

const BY_CONSTRAINT: [string, string][] = [
  ['clients_name_active_uq', 'Un client actif porte déjà cette raison sociale.'],
  ['clients_tax_id_uq', 'Cet identifiant fiscal est déjà utilisé par un autre client.'],
  ['clients_company_id_code_key', 'Ce code client existe déjà.'],
  ['client_documents_storage_path_key', 'Ce fichier est déjà enregistré.'],
]

export function clientErrorMessage(err: DbError | null | undefined): string {
  const text = `${err?.message ?? ''} ${err?.details ?? ''}`
  for (const [k, msg] of BY_CODE) if (text.includes(k)) return msg
  for (const [k, msg] of BY_CONSTRAINT) if (text.includes(k)) return msg
  if (err?.code === '42501' || text.includes('row-level security')) return 'Vous n’avez pas la permission d’effectuer cette action.'
  if (err?.code === '23514') return 'Une valeur ne respecte pas les règles de saisie. Vérifiez le formulaire.'
  return 'Une erreur est survenue. Réessayez ou contactez un administrateur.'
}

export const isPermissionError = (err: DbError | null | undefined) =>
  Boolean(err && (err.code === '42501' || err.message?.includes('RBAC_FORBIDDEN') || err.message?.includes('row-level security')))
