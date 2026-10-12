interface DbError { message?: string; code?: string; details?: string | null }

const BY_CODE: [string, string][] = [
  ['CLIENT_ARCHIVED', 'Ce client est archivé : ses projets sont en lecture seule.'],
  ['DEV_PROJECT_CLOSED', 'Ce projet est terminé ou annulé : il n’est plus modifiable.'],
  ['DEV_PROJECT_NOT_ACTIVE', 'Le projet est en pause : reprenez-le pour continuer.'],
  ['DEV_STAGE_SKIP', 'On ne peut avancer que d’une étape à la fois.'],
  ['DEV_REASON_REQUIRED', 'Un motif (3 caractères minimum) est requis.'],
  ['DEV_GATE_PROTOTYPE', 'Étape bloquée : approuvez d’abord au moins un prototype.'],
  ['DEV_GATE_SAMPLE', 'Étape bloquée : au moins un échantillon doit être approuvé par le client.'],
  ['DEV_GATE_BAT', 'Étape bloquée : soumettez d’abord un BAT au client.'],
  ['DEV_GATE_VALIDATION', 'Étape bloquée : le dernier BAT doit être approuvé par le client.'],
  ['DEV_GATE_INDUSTRIALIZATION', 'Étape bloquée : l’industrialisation doit être « prête » (liste de contrôle complète).'],
  ['DEV_GATE_COMPLETE', 'Un projet ne peut être terminé qu’une fois en production série.'],
  ['DEV_PRODUCT_NOT_VALIDATED', 'La fiche produit liée n’a pas de version validée : validez-la dans le PDM avant la série.'],
  ['DEV_CHECKLIST_INCOMPLETE', 'Cochez tous les points de la liste de contrôle avant de déclarer l’industrialisation prête.'],
  ['DEV_COMMENT_REQUIRED', 'Précisez le motif du refus ou les modifications demandées.'],
  ['DEV_BAD_STAGE', 'Un BAT ne se soumet qu’aux étapes « BAT » et « Validation client ».'],
  ['DEV_BAD_STATUS', 'Cette action n’est pas possible dans l’état actuel.'],
  ['DEV_BAD_SAMPLE', 'Échantillon invalide pour ce projet.'],
  ['DEV_BAD_PROTOTYPE', 'Le prototype doit appartenir au même projet.'],
  ['DEV_BAD_PRODUCT', 'La fiche produit doit appartenir au même client que le projet.'],
  ['DEV_BAD_BOM', 'La nomenclature doit appartenir à un article du même client.'],
  ['DEV_BAD_DOCUMENT', 'Le document doit appartenir au même client que le projet (et ne pas être dans la corbeille).'],
  ['DEV_REF_LOCKED', 'Cette donnée ne peut plus être modifiée.'],
  ['DEV_NOT_FOUND', 'Élément introuvable.'],
  ['cv_one_pending_uq', 'Une validation est déjà en attente pour cet élément : enregistrez la réponse du client d’abord.'],
  ['development_documents_project_id_ged_document_id_key', 'Ce document est déjà rattaché au projet.'],
  ['dev_dates_ck', 'L’échéance doit être postérieure à la date de la demande.'],
  ['cv_dates_ck', 'La date de réponse attendue doit être postérieure à la date d’envoi.'],
  ['industrialization_checklist_ck', 'Liste de contrôle invalide.'],
  ['RBAC_FORBIDDEN', 'Vous n’avez pas la permission d’effectuer cette action.'],
]

export function devErrorMessage(err: DbError | null | undefined): string {
  const text = `${err?.message ?? ''} ${err?.details ?? ''}`
  for (const [k, msg] of BY_CODE) if (text.includes(k)) return msg
  if (err?.code === '42501' || text.includes('row-level security')) return 'Vous n’avez pas la permission d’effectuer cette action.'
  if (err?.code === '23514') return 'Une valeur ne respecte pas les règles de saisie. Vérifiez le formulaire.'
  return 'Une erreur est survenue. Réessayez ou contactez un administrateur.'
}

export const isPermissionError = (err: DbError | null | undefined) =>
  Boolean(err && (err.code === '42501' || err.message?.includes('RBAC_FORBIDDEN') || err.message?.includes('row-level security')))
