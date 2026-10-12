interface DbError {
  message?: string
  code?: string
  details?: string | null
}

const BY_CODE: [string, string][] = [
  ['CLIENT_ARCHIVED', 'Le client est archivé : la commande est en lecture seule.'],
  ['ORDER_LOCKED', 'Cette commande n’est plus modifiable (confirmée, livrée ou annulée).'],
  ['ORDER_BAD_ARTICLE', 'Article invalide : il doit appartenir au client de la commande et ne pas être arrêté.'],
  ['ORDER_BAD_STATUS', 'Cette action n’est pas possible dans l’état actuel de la commande.'],
  ['ORDER_EMPTY', 'Confirmation impossible : la commande ne contient aucune ligne.'],
  ['ORDER_NOT_FOUND', 'Commande introuvable.'],
  ['ORDER_BAD_CLIENT', 'Client invalide.'],
  ['MRP_BAD_ARTICLE', 'Article invalide.'],
  ['MRP_BAD_MATERIAL', 'Composant invalide.'],
  ['MRP_BAD_STATUS', 'Statut invalide.'],
  ['MRP_NOT_FOUND', 'Élément introuvable.'],
  ['sales_order_lines_qty_check', 'La quantité doit être supérieure à 0.'],
  ['mrp_forecasts_qty_check', 'La quantité doit être supérieure à 0.'],
  ['RBAC_FORBIDDEN', 'Vous n’avez pas la permission d’effectuer cette action.'],
]

export function mrpErrorMessage(err: DbError | null | undefined): string {
  const text = `${err?.message ?? ''} ${err?.details ?? ''}`
  for (const [k, msg] of BY_CODE) if (text.includes(k)) return msg
  if (err?.code === '42501' || text.includes('row-level security')) return 'Vous n’avez pas la permission d’effectuer cette action.'
  if (err?.code === '23514') return 'Une valeur ne respecte pas les règles de saisie. Vérifiez le formulaire.'
  return 'Une erreur est survenue. Réessayez ou contactez un administrateur.'
}

export const isPermissionError = (err: DbError | null | undefined) =>
  Boolean(err && (err.code === '42501' || err.message?.includes('RBAC_FORBIDDEN') || err.message?.includes('row-level security')))
