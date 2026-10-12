interface DbError {
  message?: string
  code?: string
  details?: string | null
}

const BY_CODE: [string, string][] = [
  ['COMMERCIAL_LOCKED', 'Ce document n’est plus modifiable.'],
  ['COMMERCIAL_BAD_STATUS', 'Cette action n’est pas possible dans l’état actuel du document.'],
  ['COMMERCIAL_EMPTY', 'Le document ne contient aucune ligne.'],
  ['COMMERCIAL_BAD_ARTICLE', 'Article invalide : il doit appartenir au client du devis et ne pas être arrêté (pas d’article sur un devis de prospect).'],
  ['COMMERCIAL_BAD_CLIENT', 'Client invalide.'],
  ['COMMERCIAL_BAD_PROSPECT', 'Choisissez un client ou un prospect encore ouvert.'],
  ['COMMERCIAL_NOT_FOUND', 'Document introuvable.'],
  ['CLIENT_ARCHIVED', 'Le client est archivé : le document est en lecture seule.'],
  ['QUOTE_EXPIRED', 'Ce devis a expiré : dupliquez-le pour en créer une nouvelle version.'],
  ['QUOTE_REASON_REQUIRED', 'Le motif du refus est obligatoire.'],
  ['QUOTE_BAD_VALIDITY', 'La date de validité doit être postérieure à la date du devis.'],
  ['QUOTE_PROSPECT_NOT_CONVERTED', 'Convertissez d’abord le prospect en client pour créer la commande.'],
  ['PROSPECT_USE_CONVERT', 'Pour gagner un prospect, convertissez-le en client.'],
  ['PROSPECT_REASON_REQUIRED', 'Le motif de la perte est obligatoire.'],
  ['PROSPECT_CLOSED', 'Ce prospect est clos (gagné ou perdu).'],
  ['PROSPECT_COUNTRY_REQUIRED', 'Renseignez le pays du prospect avant de le convertir (champ obligatoire de la fiche client).'],
  ['PROSPECT_BAD_STAGE', 'Étape invalide.'],
  ['PROSPECT_BAD_OWNER', 'Commercial invalide.'],
  ['PROSPECT_NOT_FOUND', 'Prospect introuvable.'],
  ['INVOICE_ORDER_NOT_CONFIRMED', 'Seule une commande confirmée peut être facturée.'],
  ['INVOICE_NOTHING_TO_INVOICE', 'Plus rien à facturer sur cette commande.'],
  ['INVOICE_OVER_INVOICED', 'Quantité facturée supérieure au reste à facturer de la commande.'],
  ['INVOICE_ZERO_TOTAL', 'Le montant du document doit être supérieur à 0.'],
  ['INVOICE_CANCEL_ISSUED', 'Une facture émise ne s’annule pas : créez un avoir.'],
  ['INVOICE_OVERPAYMENT', 'Le montant dépasse le solde restant dû.'],
  ['INVOICE_BAD_AMOUNT', 'Montant invalide.'],
  ['CREDIT_BAD_INVOICE', 'Un avoir se crée sur une facture émise.'],
  ['CREDIT_REASON_REQUIRED', 'Le motif de l’avoir est obligatoire.'],
  ['CREDIT_NOTHING_TO_CREDIT', 'Cette facture est déjà entièrement créditée.'],
  ['CREDIT_OVER_CREDIT', 'Quantité créditée supérieure à la quantité facturée restante.'],
  ['ORDER_LOCKED', 'Cette commande n’est plus modifiable.'],
  ['ORDER_BAD_ARTICLE', 'Article invalide pour cette commande (ou description manquante pour une ligne libre).'],
  ['ORDER_NOT_FOUND', 'Commande introuvable.'],
  ['ORDER_BAD_STATUS', 'Cette action n’est pas possible dans l’état actuel de la commande.'],
  ['ORDER_EMPTY', 'Confirmation impossible : la commande ne contient aucune ligne.'],
  ['quote_lines_qty_check', 'La quantité doit être supérieure à 0.'],
  ['invoice_lines_qty_check', 'La quantité doit être supérieure à 0.'],
  ['RBAC_FORBIDDEN', 'Vous n’avez pas la permission d’effectuer cette action.'],
]

export function commercialErrorMessage(err: DbError | null | undefined): string {
  const text = `${err?.message ?? ''} ${err?.details ?? ''}`
  for (const [k, msg] of BY_CODE) if (text.includes(k)) return msg
  if (err?.code === '42501' || text.includes('row-level security')) return 'Vous n’avez pas la permission d’effectuer cette action.'
  if (err?.code === '23514') return 'Une valeur ne respecte pas les règles de saisie. Vérifiez le formulaire.'
  return 'Une erreur est survenue. Réessayez ou contactez un administrateur.'
}

export const isPermissionError = (err: DbError | null | undefined) =>
  Boolean(err && (err.code === '42501' || err.message?.includes('RBAC_FORBIDDEN') || err.message?.includes('row-level security')))
