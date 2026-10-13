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
  ['PO_NOT_APPROVED', 'Envoi impossible : la commande n’a pas de version approuvée. Soumettez-la à accord.'],
  ['PO_CHANGED_AFTER_APPROVAL', 'Envoi impossible : le contenu a changé depuis l’approbation. Soumettez-le de nouveau à accord.'],
  ['PO_APPROVAL_PENDING', 'Une demande d’accord est déjà ouverte pour cette commande : attendez la décision.'],
  ['PO_NOTHING_TO_SEND', 'Aucune modification approuvée à envoyer.'],
  ['PO_STALE_VERSION', 'Cette version n’est plus la version envoyée au fournisseur.'],
  ['PO_ALREADY_CONFIRMED', 'Cette version est déjà confirmée par le fournisseur.'],
  ['PO_CONFIRMATION_REFERENCE_REQUIRED', 'Référence de confirmation requise (3 caractères minimum).'],
  ['PO_BAD_DATE', 'Date de confirmation invalide (pas de date future).'],
  ['PO_REASON_REQUIRED', 'Le motif de la modification est obligatoire (5 caractères minimum).'],
  ['PO_BAD_LINE', 'Modification : chaque ligne de la commande doit être renseignée une fois, avec une quantité positive et un prix positif ou nul.'],
  ['PO_QTY_BELOW_RECEIVED', 'Modification refusée : la quantité ne peut pas descendre sous ce qui est déjà reçu ou retourné.'],
  ['SOURCING_NOT_FOUND', 'Consultation introuvable.'],
  ['SOURCING_EMPTY', 'La consultation doit comporter au moins un composant.'],
  ['SOURCING_BAD_MATERIAL', 'Composant introuvable ou archivé.'],
  ['SOURCING_WEIGHTS_INVALID', 'Pondérations invalides : trois valeurs positives ou nulles dont le total est 100.'],
  ['SOURCING_BAD_STATUS', 'Cette action n’est pas possible dans l’état actuel de la consultation.'],
  ['SOURCING_SUPPLIER_NOT_APPROVED', 'Fournisseur non qualifié ou archivé : seuls les fournisseurs approuvés peuvent répondre.'],
  ['SOURCING_CURRENCY_UNKNOWN', 'Devise inconnue.'],
  ['FX_RATE_MISSING', 'Aucun taux de change enregistré à la date d’ouverture de la consultation : saisissez le taux (devise à convertir) avant de comparer.'],
  ['SOURCING_BAD_INCOTERM', 'Incoterm invalide.'],
  ['SOURCING_BAD_LEAD', 'Délai de livraison : entier entre 0 et 365 jours.'],
  ['SOURCING_BAD_AMOUNT', 'Transport et droits : montants positifs ou nuls.'],
  ['SOURCING_REFERENCE_REQUIRED', 'Référence du document requise (3 caractères minimum).'],
  ['SOURCING_BAD_SHA', 'Empreinte SHA-256 invalide : 64 caractères hexadécimaux, ou laisser vide.'],
  ['SOURCING_INCOMPLETE', 'Offre incomplète : chaque ligne de la consultation doit être chiffrée une seule fois, pour comparer une base identique.'],
  ['SOURCING_NO_OFFER', 'Aucune offre : impossible de clôturer ou de comparer.'],
  ['SOURCING_NOT_CLOSED', 'Le comparatif n’est établi qu’après clôture de la consultation.'],
  ['SOURCING_QUALITY_MISSING', 'Comparatif impossible : fournisseur sans notation qualité (à renseigner sur la fiche fournisseur)'],
  ['SOURCING_ZERO_PRICE', 'Comparatif impossible : un coût rendu est nul.'],
  ['SOURCING_RATIONALE_REQUIRED', 'Le motif de sélection doit comporter au moins 20 caractères.'],
  ['SOURCING_BAD_VERSION', 'Offre retenue invalide pour cette consultation.'],
  ['SOURCING_STALE_VERSION', 'Cette offre a été révisée : choisissez la version la plus récente.'],
  ['SOURCING_AWARD_PENDING', 'Une demande d’attribution est déjà en attente de décision.'],
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
const WITH_DETAIL = ['PURCHASE_NO_SUPPLIER', 'PURCHASE_OVER_RECEIPT', 'SOURCING_QUALITY_MISSING']

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
