interface DbError {
  message?: string
  code?: string
  details?: string | null
}

const BY_CODE: [string, string][] = [
  ['STOCK_INSUFFICIENT_AVAILABLE', 'Réservation impossible : la quantité disponible (en stock − déjà réservé) est insuffisante.'],
  ['STOCK_INSUFFICIENT', 'Stock insuffisant pour cette quantité (à l’emplacement ou dans l’entrepôt choisi).'],
  ['STOCK_RESERVED', 'Une partie du stock est réservée : la quantité disponible est inférieure à la demande. Utilisez la réservation concernée ou libérez-la.'],
  ['STOCK_BAD_RESERVATION', 'Réservation invalide (inactive, autre composant / entrepôt, ou quantité supérieure au reste réservé).'],
  ['STOCK_BAD_QTY', 'La quantité doit être strictement positive (non nulle pour un ajustement).'],
  ['STOCK_REASON_REQUIRED', 'Un motif est obligatoire pour un ajustement.'],
  ['STOCK_REFERENCE_REQUIRED', 'La référence (ordre de fabrication, commande…) est obligatoire.'],
  ['STOCK_LOCATION_REQUIRED', 'Choisissez l’emplacement.'],
  ['STOCK_SAME_LOCATION', 'L’emplacement de destination doit être différent de la source.'],
  ['STOCK_LOCATION_NOT_FOUND', 'Emplacement introuvable (ou d’un autre entrepôt).'],
  ['STOCK_LOCATION_ARCHIVED', 'Cet emplacement est archivé.'],
  ['STOCK_WAREHOUSE_ARCHIVED', 'Cet entrepôt est archivé.'],
  ['STOCK_WAREHOUSE_NOT_FOUND', 'Entrepôt introuvable.'],
  ['STOCK_MATERIAL_NOT_FOUND', 'Composant introuvable.'],
  ['STOCK_MATERIAL_ARCHIVED', 'Ce composant est archivé : entrée impossible.'],
  ['STOCK_NOT_EMPTY', 'Archivage impossible : du stock, des réservations ou un inventaire en cours subsistent.'],
  ['STOCK_LAST_LOCATION', 'Un entrepôt doit conserver au moins un emplacement actif.'],
  ['STOCK_INVENTORY_OPEN', 'Un inventaire est déjà en cours sur ce périmètre.'],
  ['STOCK_INVENTORY_CLOSED', 'Cet inventaire est clos : il ne peut plus être modifié.'],
  ['STOCK_INVENTORY_EMPTY', 'Validation impossible : aucune quantité comptée.'],
  ['STOCK_INVENTORY_NOT_FOUND', 'Inventaire introuvable.'],
  ['STOCK_BAD_STATUS', 'Cette action n’est pas possible dans l’état actuel.'],
  ['STOCK_IMMUTABLE', 'L’historique des mouvements ne peut pas être modifié.'],
  ['warehouses_name_uq', 'Un entrepôt porte déjà ce nom.'],
  ['stock_locations_warehouse_id_code_key', 'Cet emplacement existe déjà dans l’entrepôt.'],
  ['stock_locations_code_check', 'Code d’emplacement invalide (lettres, chiffres, . _ - ; 30 caractères maximum).'],
  ['STOCK_BAD_KIND', 'Type de mouvement inconnu.'],
  ['STOCK_DESTINATION_REQUIRED', 'Un transfert exige un entrepôt et un emplacement de destination.'],
  ['STOCK_REQUEST_CLOSED', 'Cette demande a déjà été traitée (validée, refusée ou annulée).'],
  ['STOCK_SELF_APPROVAL', 'Vous ne pouvez pas valider ou refuser votre propre demande.'],
  ['STOCK_HIERARCHY', 'La validation de niveau 2 doit être faite par une autre personne que celle du niveau 1.'],
  ['STOCK_CANCEL_FORBIDDEN', 'Ce mouvement ne peut pas être annulé (inventaire, réversion ou emplacement manquant).'],
  ['STOCK_ALREADY_CANCELLED', 'Ce mouvement a déjà une annulation en cours ou appliquée.'],
  ['STOCK_BAD_REQUEST', 'Demande introuvable.'],
  ['STOCK_BAD_MOVEMENT', 'Mouvement introuvable.'],
  ['RBAC_FORBIDDEN', 'Vous n’avez pas la permission d’effectuer cette action.'],
]

export function stockErrorMessage(err: DbError | null | undefined): string {
  const text = `${err?.message ?? ''} ${err?.details ?? ''}`
  for (const [k, msg] of BY_CODE) if (text.includes(k)) return msg
  if (err?.code === '42501' || text.includes('row-level security')) return 'Vous n’avez pas la permission d’effectuer cette action.'
  if (err?.code === '23514') return 'Une valeur ne respecte pas les règles de saisie. Vérifiez le formulaire.'
  return 'Une erreur est survenue. Réessayez ou contactez un administrateur.'
}

export const isPermissionError = (err: DbError | null | undefined) =>
  Boolean(err && (err.code === '42501' || err.message?.includes('RBAC_FORBIDDEN') || err.message?.includes('row-level security')))
