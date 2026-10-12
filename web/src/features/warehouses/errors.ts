interface DbError { message?: string; code?: string; details?: string | null }

const BY_CODE: [string, string][] = [
  ['WAREHOUSE_FORBIDDEN', 'Accès refusé : cet entrepôt ne vous est pas affecté, ou votre rôle ne le permet pas.'],
  ['WAREHOUSE_NOT_FOUND', 'Entrepôt introuvable ou non accessible.'],
  ['WAREHOUSE_USER_NOT_FOUND', 'Utilisateur introuvable dans votre société.'],
  ['WAREHOUSE_ACCESS_NOT_FOUND', 'Cet utilisateur n’a pas d’accès actif à cet entrepôt.'],
  ['WAREHOUSE_BAD_ROLE', 'Rôle inconnu.'],
  ['WAREHOUSE_LAST_MANAGER', 'Un entrepôt garde au moins un responsable : désignez-en un autre avant de retirer celui-ci.'],
  ['WAREHOUSE_ZONE_MISMATCH', 'L’emplacement doit être rattaché à une zone du même entrepôt.'],
  ['WAREHOUSE_ARCHIVED', 'Cet entrepôt est archivé.'],
  ['WAREHOUSE_REF_LOCKED', 'Cette donnée ne peut plus être modifiée.'],
  ['warehouses_name_uq', 'Un entrepôt porte déjà ce nom.'],
  ['warehouse_locations_warehouse_id_code_key', 'Cette zone existe déjà dans l’entrepôt.'],
  ['stock_locations_warehouse_id_code_key', 'Cet emplacement existe déjà dans l’entrepôt.'],
  ['warehouse_locations_zone_type_check', 'Type de zone inconnu.'],
  ['warehouses_kind_check', 'Type d’entrepôt inconnu.'],
  ['RBAC_FORBIDDEN', 'Vous n’avez pas la permission d’effectuer cette action.'],
]

export function warehouseErrorMessage(err: DbError | null | undefined): string {
  const text = `${err?.message ?? ''} ${err?.details ?? ''}`
  for (const [k, msg] of BY_CODE) if (text.includes(k)) return msg
  if (err?.code === '42501' || text.includes('row-level security')) return 'Accès refusé : vous n’avez pas les droits nécessaires sur cet entrepôt.'
  if (err?.code === '23514' || err?.code === '23505') return 'Une valeur ne respecte pas les règles de saisie ou existe déjà.'
  return 'Une erreur est survenue. Réessayez ou contactez un administrateur.'
}

export const isPermissionError = (err: DbError | null | undefined) =>
  Boolean(err && (err.code === '42501' || err.message?.includes('WAREHOUSE_FORBIDDEN') || err.message?.includes('RBAC_FORBIDDEN') || err.message?.includes('row-level security')))
