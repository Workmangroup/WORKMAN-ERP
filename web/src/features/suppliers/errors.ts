interface DbError {
  message?: string
  code?: string
  details?: string | null
}

const BY_CODE: [string, string][] = [
  ['SUPPLIER_ARCHIVED', 'Ce fournisseur est archivé : restaurez-le avant de le modifier.'],
  ['SUPPLIER_NOT_ARCHIVED', 'Seul un fournisseur archivé peut être supprimé définitivement (ou restauré).'],
  ['SUPPLIER_NOT_FOUND', 'Fournisseur introuvable.'],
  ['SUPPLIER_IN_USE', 'Suppression impossible : des commandes d’achat existent pour ce fournisseur. Conservez-le archivé.'],
  ['SUPPLIER_INVALID_BUYER', 'L’acheteur référent est invalide (compte inactif ou d’une autre société).'],
  ['SUPPLIER_INVALID_TERMS', 'Conditions de paiement invalides.'],
  ['SUPPLIER_CODE_LOCKED', 'Le code fournisseur ne peut plus être modifié.'],
  ['SUPPLIER_INVALID_CODE', 'Code invalide (lettres, chiffres, - et _ ; 2 à 20 caractères).'],
  ['SUPPLIER_INVALID_PATH', 'Chemin de fichier invalide.'],
  ['RBAC_FORBIDDEN', 'Vous n’avez pas la permission d’effectuer cette action.'],
]
const BY_CONSTRAINT: [string, string][] = [
  ['suppliers_name_active_uq', 'Un fournisseur actif porte déjà cette raison sociale.'],
  ['suppliers_tax_id_uq', 'Cet identifiant fiscal est déjà utilisé par un autre fournisseur.'],
  ['suppliers_company_id_code_key', 'Ce code fournisseur existe déjà.'],
]

export function supplierErrorMessage(err: DbError | null | undefined): string {
  const text = `${err?.message ?? ''} ${err?.details ?? ''}`
  for (const [k, msg] of BY_CODE) if (text.includes(k)) return msg
  for (const [k, msg] of BY_CONSTRAINT) if (text.includes(k)) return msg
  if (err?.code === '42501' || text.includes('row-level security')) return 'Vous n’avez pas la permission d’effectuer cette action.'
  if (err?.code === '23514') return 'Une valeur ne respecte pas les règles de saisie. Vérifiez le formulaire.'
  return 'Une erreur est survenue. Réessayez ou contactez un administrateur.'
}

export const isPermissionError = (err: DbError | null | undefined) =>
  Boolean(err && (err.code === '42501' || err.message?.includes('RBAC_FORBIDDEN') || err.message?.includes('row-level security')))
