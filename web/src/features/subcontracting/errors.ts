interface DbError { message?: string; code?: string; details?: string | null }

const BY_CODE: [string, string][] = [
  ['SC_NO_COMPANY', 'Société introuvable pour votre compte.'],
  ['SC_NOT_FOUND', 'Élément introuvable.'],
  ['SC_SUBCONTRACTOR_INACTIVE', 'Ce sous-traitant est désactivé : réactivez-le pour lui confier une commande.'],
  ['SC_SERVICE_NOT_OFFERED', 'Ce sous-traitant ne propose pas cette prestation.'],
  ['SC_SERVICE_IN_USE', 'Impossible de retirer cette prestation : des commandes en cours l’utilisent.'],
  ['SC_BAD_PRODUCT', 'Le produit doit appartenir à votre société.'],
  ['SC_DATE_ORDER', 'L’échéance doit être postérieure à la date de la demande.'],
  ['SC_ORDER_LOCKED', 'Après envoi, seuls l’échéance et les notes peuvent être modifiées.'],
  ['SC_ORDER_CLOSED', 'Cette commande est clôturée ou annulée : elle n’est plus modifiable.'],
  ['SC_BAD_STATUS', 'Cette action n’est pas possible dans l’état actuel de la commande.'],
  ['SC_DUE_REQUIRED', 'Indiquez l’échéance de retour avant d’envoyer la commande.'],
  ['SC_REASON_REQUIRED', 'Un motif d’au moins 3 caractères est requis.'],
  ['SC_OVER_QTY', 'La quantité dépasse ce qui reste à envoyer sur la commande.'],
  ['SC_BAD_QTY', 'Quantité invalide.'],
  ['SC_BAD_SHIPMENT', 'L’envoi choisi n’appartient pas à cette commande.'],
  ['SC_RECEIPT_EXCEEDS_SHIPMENT', 'Le retour dépasse ce qui a été envoyé : enregistrez d’abord l’envoi correspondant.'],
  ['SC_QC_SUM', 'Acceptées + rejetées doivent égaler la quantité reçue.'],
  ['SC_QC_PENDING', 'Des retours restent à contrôler avant la clôture.'],
  ['SC_STOCK_PENDING', 'Des retours acceptés ne sont pas encore entrés en stock.'],
  ['SC_BAD_VARIANT', 'La variante doit être une variante du produit de la commande.'],
  ['SC_BAD_SHIPMENT_COST', 'Le transport doit être rattaché à un envoi de cette commande.'],
  ['SC_RPC_ONLY', 'Les envois et réceptions passent par les actions dédiées.'],
  ['subcontractors_name_uq', 'Un sous-traitant porte déjà ce nom.'],
  ['subcontractors_services_check', 'Prestation inconnue.'],
  ['subcontractors_default_lead_days_check', 'Délai habituel : 0 à 365 jours.'],
  ['sc_costs_one_service_uq', 'Cette commande a déjà une prestation facturée : modifiez-la plutôt que d’en ajouter une.'],
  ['sc_orders_qc_ck', 'Quantités de contrôle incohérentes.'],
  ['RBAC_FORBIDDEN', 'Vous n’avez pas la permission d’effectuer cette action.'],
]

export function subcontractErrorMessage(err: DbError | null | undefined): string {
  const text = `${err?.message ?? ''} ${err?.details ?? ''}`
  for (const [k, msg] of BY_CODE) if (text.includes(k)) return msg
  if (err?.code === '42501' || text.includes('row-level security')) return 'Vous n’avez pas la permission d’effectuer cette action.'
  if (err?.code === '23503') return 'Cet élément est utilisé ailleurs : désactivez-le plutôt que de le supprimer.'
  if (err?.code === '23514') return 'Une valeur ne respecte pas les règles de saisie. Vérifiez le formulaire.'
  return 'Une erreur est survenue. Réessayez ou contactez un administrateur.'
}

export const isPermissionError = (err: DbError | null | undefined) =>
  Boolean(err && (err.code === '42501' || err.message?.includes('RBAC_FORBIDDEN') || err.message?.includes('row-level security')))
