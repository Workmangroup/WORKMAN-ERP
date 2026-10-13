interface DbError {
  message?: string
  code?: string
  details?: string | null
}

const BY_CODE: [string, string][] = [
  ['PURCHASE_SELF_APPROVAL', 'Vous ne pouvez pas valider votre propre demande : un autre approbateur doit la traiter.'],
  ['PURCHASE_COMMENT_REQUIRED', 'Un motif est obligatoire pour rejeter une demande.'],
  ['PURCHASE_REASON_REQUIRED', 'Le motif est obligatoire (5 caractères minimum) : pour une demande budgétée, ou pour un retour fournisseur.'],
  ['PURCHASE_ESTIMATE_REQUIRED', 'Estimation manquante : saisissez un coût unitaire, ou renseignez le prix catalogue du composant.'],
  ['PURCHASE_USE_APPROVAL', 'Cette demande se valide par le workflow d’approbation : utilisez la décision d’approbation.'],
  ['BUDGET_EXCEEDED', 'Budget dépassé : le montant de la demande dépasse le disponible du centre de coût pour la période du besoin.'],
  ['BUDGET_NOT_DEFINED', 'Aucun budget défini pour ce centre de coût à la date du besoin : la demande ne peut pas être soumise.'],
  ['BUDGET_BELOW_COMMITTED', 'Montant inférieur à l’engagé et au réalisé déjà constatés : le budget ne peut pas descendre en dessous.'],
  ['BUDGET_OVERLAP', 'Un budget existe déjà pour ce centre de coût sur une partie de cette période.'],
  ['BUDGET_PERIOD_FIXED', 'La période d’un budget existant ne se modifie pas : seul le montant peut être révisé.'],
  ['BUDGET_BAD_PERIOD', 'Période invalide : la fin doit suivre le début.'],
  ['BUDGET_BAD_AMOUNT', 'Montant de budget invalide (positif ou nul).'],
  ['BUDGET_BAD_COST_CENTER', 'Centre de coût introuvable ou archivé.'],
  ['BUDGET_NOT_FOUND', 'Budget introuvable.'],
  ['APPROVAL_REASON_REQUIRED', 'Le motif de refus doit comporter au moins 10 caractères.'],
  ['APPROVAL_NO_POLICY', 'Aucune politique d’approbation n’est définie pour les demandes d’achat.'],
  ['PURCHASE_LOCKED', 'Ce document n’est plus modifiable.'],
  ['PURCHASE_EMPTY', 'Aucune ligne ou aucune quantité saisie.'],
  ['PURCHASE_BAD_STATUS', 'Cette action n’est pas possible dans l’état actuel du document.'],
  ['PURCHASE_NO_SUPPLIER', 'Transformation impossible : aucun fournisseur pour'],
  ['PURCHASE_NO_SUGGESTION', 'Aucune suggestion acceptée disponible pour cette simulation.'],
  ['PURCHASE_ALREADY_ORDERED', 'Annulation impossible : des lignes sont déjà commandées. Annulez d’abord les commandes.'],
  ['PURCHASE_HAS_RECEIPTS', 'Annulation impossible : des réceptions existent. Utilisez un retour fournisseur.'],
  ['PURCHASE_OVER_RECEIPT', 'Réception supérieure à la quantité restant à recevoir pour'],
  ['PURCHASE_OVER_RETURN', 'Retour supérieur à la quantité réceptionnée non encore retournée.'],
  ['PURCHASE_BAD_LINE', 'Ligne invalide pour ce document.'],
  ['PURCHASE_BAD_MATERIAL', 'Composant invalide ou archivé.'],
  ['PURCHASE_BAD_SUPPLIER', 'Fournisseur invalide ou archivé.'],
  ['PURCHASE_BAD_SOURCE', 'Origine de demande non autorisée.'],
  ['PURCHASE_NOT_FOUND', 'Document introuvable.'],
  ['SUPPLIER_ARCHIVED', 'Ce fournisseur est archivé.'],
  ['STOCK_INSUFFICIENT', 'Stock insuffisant pour effectuer cette sortie (retour fournisseur).'],
  ['STOCK_RESERVED', 'Une partie du stock est réservée : retour impossible tant que la réservation existe.'],
  ['STOCK_LOCATION_REQUIRED', 'Choisissez l’emplacement de réception.'],
  ['STOCK_LOCATION_NOT_FOUND', 'Emplacement introuvable pour cet entrepôt.'],
  ['STOCK_LOCATION_ARCHIVED', 'Cet emplacement est archivé.'],
  ['STOCK_WAREHOUSE_ARCHIVED', 'Cet entrepôt est archivé.'],
  ['STOCK_WAREHOUSE_NOT_FOUND', 'Entrepôt introuvable.'],
  ['STOCK_MATERIAL_ARCHIVED', 'Ce composant est archivé : entrée en stock impossible.'],
  ['purchase_request_lines_qty_check', 'La quantité doit être supérieure à 0.'],
  ['purchase_order_lines_qty_ordered_check', 'La quantité doit être supérieure à 0.'],
  ['RBAC_FORBIDDEN', 'Vous n’avez pas la permission d’effectuer cette action.'],
]
const WITH_DETAIL = ['PURCHASE_NO_SUPPLIER', 'PURCHASE_OVER_RECEIPT']

export function purchaseErrorMessage(err: DbError | null | undefined): string {
  const text = `${err?.message ?? ''} ${err?.details ?? ''}`
  for (const [k, msg] of BY_CODE) {
    if (!text.includes(k)) continue
    return WITH_DETAIL.includes(k) && err?.details ? `${msg} ${err.details}.` : msg
  }
  if (err?.code === '42501' || text.includes('row-level security')) return 'Vous n’avez pas la permission d’effectuer cette action.'
  if (err?.code === '23514') return 'Une valeur ne respecte pas les règles de saisie. Vérifiez le formulaire.'
  return 'Une erreur est survenue. Réessayez ou contactez un administrateur.'
}

export const isPermissionError = (err: DbError | null | undefined) =>
  Boolean(err && (err.code === '42501' || err.message?.includes('RBAC_FORBIDDEN') || err.message?.includes('row-level security')))
