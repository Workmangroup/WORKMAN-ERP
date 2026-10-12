/** Messages affichés pour les refus de la base (délégations, séparation des tâches, dérogations, lots critiques). */
const MESSAGES: Record<string, string> = {
  RBAC_FORBIDDEN: 'Vous n’avez pas la permission d’effectuer cette action.',
  DELEGATION_EXPIRED: 'Votre délégation a expiré : elle ne permet plus cette décision.',
  DELEGATION_INACTIVE: 'Votre délégation n’a pas encore commencé.',
  DELEGATION_AMOUNT_EXCEEDED: 'Le montant dépasse la limite de votre délégation.',
  DELEGATION_NOT_HELD: 'Vous ne pouvez déléguer que les permissions que vous détenez directement.',
  DELEGATION_WINDOW: 'Une délégation dure au plus 90 jours et doit se terminer après son début.',
  DELEGATION_SELF: 'Une délégation ne peut pas vous être accordée à vous-même.',
  DELEGATION_BAD_DELEGATE: 'Le délégué doit être un utilisateur actif de la société.',
  DELEGATION_BAD_OBJECT: 'L’objet indiqué n’existe pas dans cette société.',
  DELEGATION_NOT_FOUND: 'Délégation introuvable.',
  DELEGATION_BAD_STATUS: 'Cette délégation est déjà révoquée.',
  DELEGATION_REASON_REQUIRED: 'Indiquez le motif de révocation (3 caractères minimum).',
  SOD_SELF_APPROVAL: 'Séparation des tâches : vous ne pouvez pas approuver ce que vous avez préparé ou demandé.',
  SOD_NOT_INDEPENDENT: 'Contrôle indépendant requis : le contrôleur ne peut être ni le demandeur ni l’approbateur.',
  QUALITY_SELF_RELEASE: 'Lot critique : son contrôleur ne peut pas le libérer. Un autre contrôleur doit le faire.',
  PAYMENT_ORDER_BAD_STATUS: 'Cet ordre de paiement a déjà été décidé.',
  PAYMENT_ORDER_COMMENT_REQUIRED: 'Un refus exige un commentaire (3 caractères minimum).',
  PAYMENT_ORDER_BAD_SUPPLIER: 'Fournisseur introuvable.',
  PAYMENT_ORDER_NOT_FOUND: 'Ordre de paiement introuvable.',
  DEROGATION_BAD_STATUS: 'Cette dérogation n’est pas dans l’état attendu pour cette action.',
  DEROGATION_COMMENT_REQUIRED: 'Un refus exige un commentaire (3 caractères minimum).',
  DEROGATION_WINDOW: 'La validité d’une dérogation doit être comprise entre demain et 90 jours.',
  DEROGATION_NOT_FOUND: 'Dérogation introuvable.',
  FINANCE_OVERPAYMENT: 'Le montant dépasse le solde ouvert du fournisseur.',
  FINANCE_BAD_AMOUNT: 'Montant invalide.',
  QUALITY_REASON_REQUIRED: 'Indiquez le motif (5 caractères minimum).',
  QUALITY_NOT_FOUND: 'Contrôle qualité introuvable.',
  QUALITY_BAD_STATUS: 'Ce contrôle qualité est déjà clôturé.',
}

/** Traduit une erreur PostgreSQL / PostgREST en message français. Les refus de droits restent visibles sans détail technique. */
export function governanceErrorMessage(err: { message?: string; code?: string; details?: string | null }): string {
  const key = [err.message, err.details].find((v) => v && MESSAGES[v]) ?? err.message ?? ''
  return MESSAGES[key] ?? 'Action impossible : vérifiez les données et vos droits, puis réessayez.'
}

export function isGovernancePermissionError(err: { message?: string; details?: string | null }): boolean {
  return [err.message, err.details].some((v) => v === 'RBAC_FORBIDDEN' || v === 'DELEGATION_EXPIRED' || v === 'DELEGATION_INACTIVE' || v === 'DELEGATION_AMOUNT_EXCEEDED' || v === 'SOD_SELF_APPROVAL' || v === 'SOD_NOT_INDEPENDENT' || v === 'QUALITY_SELF_RELEASE')
}
