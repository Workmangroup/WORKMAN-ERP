/** Valeurs métier du module Développement produit (libellés FR). Alignées avec 0014_development.sql. */
import { FAMILIES, label } from '@/lib/articles/options'

export { FAMILIES, label }

export type Tone = 'success' | 'neutral' | 'warning' | 'danger' | 'brand'

export const STAGES = [
  { id: 'request', label: 'Demande client', short: 'Demande', hint: 'Demande reçue du client, à qualifier.' },
  { id: 'project', label: 'Projet', short: 'Projet', hint: 'Cadrage : cahier des charges, budget, planning.' },
  { id: 'prototype', label: 'Prototype', short: 'Prototype', hint: 'Prototypes internes jusqu’à un prototype approuvé.' },
  { id: 'sample', label: 'Échantillon', short: 'Échantillon', hint: 'Échantillons envoyés au client jusqu’à son approbation.' },
  { id: 'bat', label: 'BAT', short: 'BAT', hint: 'Bon à tirer à soumettre au client.' },
  { id: 'validation', label: 'Validation client', short: 'Validation', hint: 'Attente de l’approbation du BAT par le client.' },
  { id: 'industrialization', label: 'Industrialisation', short: 'Industrialisation', hint: 'Préparation de la série : liste de contrôle complète.' },
  { id: 'production', label: 'Production série', short: 'Série', hint: 'Projet transmis à la production série.' },
] as const
export type StageId = (typeof STAGES)[number]['id']
export const STAGE_IDS: StageId[] = STAGES.map((s) => s.id)
export const stageInfo = (id: string) => STAGES.find((s) => s.id === id) ?? STAGES[0]
export const stageIndex = (id: string) => STAGE_IDS.indexOf(id as StageId)
export const nextStage = (id: string): StageId | null => STAGE_IDS[stageIndex(id) + 1] ?? null

/** Condition à remplir pour quitter chaque étape vers la suivante (reprend les portes de contrôle de la base). */
export const GATES: Record<string, string> = {
  request: 'Aucune condition.',
  project: 'Aucune condition.',
  prototype: 'Au moins un prototype approuvé.',
  sample: 'Au moins un échantillon approuvé par le client.',
  bat: 'Un BAT soumis au client.',
  validation: 'Le dernier BAT approuvé par le client.',
  industrialization: 'Industrialisation « prête » (liste de contrôle complète) ; fiche produit liée validée le cas échéant.',
}

export const PROJECT_STATUS = {
  active: { label: 'Actif', tone: 'success' },
  on_hold: { label: 'En pause', tone: 'warning' },
  cancelled: { label: 'Annulé', tone: 'neutral' },
  completed: { label: 'Terminé', tone: 'brand' },
} as const satisfies Record<string, { label: string; tone: Tone }>
export type ProjectStatus = keyof typeof PROJECT_STATUS

export const PRIORITY = {
  low: { label: 'Basse', tone: 'neutral' },
  normal: { label: 'Normale', tone: 'brand' },
  high: { label: 'Haute', tone: 'warning' },
  urgent: { label: 'Urgente', tone: 'danger' },
} as const satisfies Record<string, { label: string; tone: Tone }>

export const PROTO_STATUS = {
  planned: { label: 'Planifié', tone: 'neutral' },
  in_progress: { label: 'En cours', tone: 'brand' },
  ready: { label: 'Prêt à essayer', tone: 'warning' },
  approved: { label: 'Approuvé', tone: 'success' },
  rejected: { label: 'Rejeté', tone: 'danger' },
} as const satisfies Record<string, { label: string; tone: Tone }>
/** Transitions proposées dans l'interface (la base fait foi). */
export const PROTO_NEXT: Record<string, { to: string; label: string }[]> = {
  planned: [{ to: 'in_progress', label: 'Démarrer' }, { to: 'rejected', label: 'Rejeter' }],
  in_progress: [{ to: 'ready', label: 'Marquer prêt' }, { to: 'rejected', label: 'Rejeter' }],
  ready: [{ to: 'approved', label: 'Approuver' }, { to: 'in_progress', label: 'Reprendre' }, { to: 'rejected', label: 'Rejeter' }],
}

export const SAMPLE_STATUS = {
  planned: { label: 'Planifié', tone: 'neutral' },
  in_progress: { label: 'En fabrication', tone: 'brand' },
  sent: { label: 'Envoyé au client', tone: 'warning' },
  approved: { label: 'Approuvé', tone: 'success' },
  rejected: { label: 'Refusé', tone: 'danger' },
  revision: { label: 'À reprendre', tone: 'warning' },
} as const satisfies Record<string, { label: string; tone: Tone }>
export const SAMPLE_NEXT: Record<string, { to: string; label: string }[]> = {
  planned: [{ to: 'in_progress', label: 'Lancer la fabrication' }],
  in_progress: [{ to: 'sent', label: 'Marquer envoyé' }],
  revision: [{ to: 'in_progress', label: 'Reprendre' }],
  rejected: [{ to: 'in_progress', label: 'Reprendre' }],
}

export const VALIDATION_KIND = { sample: 'Échantillon', bat: 'BAT' } as const
export const VALIDATION_STATUS = {
  pending: { label: 'En attente', tone: 'warning' },
  approved: { label: 'Approuvé', tone: 'success' },
  rejected: { label: 'Refusé', tone: 'danger' },
  changes_requested: { label: 'Modifications demandées', tone: 'warning' },
} as const satisfies Record<string, { label: string; tone: Tone }>

export const INDUSTRIALIZATION_STATUS = {
  not_started: { label: 'Non démarrée', tone: 'neutral' },
  in_progress: { label: 'En cours', tone: 'brand' },
  ready: { label: 'Prête', tone: 'success' },
  released: { label: 'Livrée en série', tone: 'brand' },
} as const satisfies Record<string, { label: string; tone: Tone }>

export const EXCHANGE_DIRECTION = [
  { value: 'inbound', label: 'Reçu du client' }, { value: 'outbound', label: 'Envoyé au client' }, { value: 'internal', label: 'Note interne' },
] as const
export const EXCHANGE_CHANNEL = [
  { value: 'email', label: 'E-mail' }, { value: 'phone', label: 'Téléphone' }, { value: 'meeting', label: 'Réunion' },
  { value: 'portal', label: 'Portail client' }, { value: 'message', label: 'Messagerie' }, { value: 'other', label: 'Autre' },
] as const
export const COST_KINDS = [
  { value: 'material', label: 'Matière' }, { value: 'labor', label: 'Main-d’œuvre' }, { value: 'subcontract', label: 'Sous-traitance' },
  { value: 'shipping', label: 'Transport' }, { value: 'other', label: 'Autre' },
] as const
export const DEV_DOC_KINDS = [
  { value: 'request', label: 'Demande / cahier des charges' }, { value: 'tech_pack', label: 'Dossier technique' }, { value: 'photo', label: 'Photo / visuel' },
  { value: 'bat', label: 'BAT' }, { value: 'sample_report', label: 'Rapport d’essai' }, { value: 'approval', label: 'Accord du client' }, { value: 'other', label: 'Autre' },
] as const

export const ALERT_TYPES: Record<string, { label: string; tone: Tone }> = {
  validation_overdue: { label: 'Validation en retard', tone: 'danger' },
  validation_due_soon: { label: 'Validation bientôt due', tone: 'warning' },
  validation_stale: { label: 'Sans réponse du client', tone: 'warning' },
  project_overdue: { label: 'Projet en retard', tone: 'danger' },
  prototype_overdue: { label: 'Prototype en retard', tone: 'warning' },
  sample_overdue: { label: 'Échantillon en retard', tone: 'warning' },
  stage_stuck: { label: 'Étape bloquée', tone: 'neutral' },
}

export interface ChecklistItem { key: string; label: string; done: boolean }

export const DEV_FIELD_LABELS: Record<string, string> = {
  name: 'Désignation', family: 'Famille', description: 'Demande', priority: 'Priorité', owner_id: 'Responsable', due_date: 'Échéance', target_qty: 'Quantité visée', product_id: 'Fiche produit',
  status: 'Statut', stage: 'Étape', feedback: 'Retour', started_on: 'Début', qty: 'Quantité', size_label: 'Taille', color: 'Couleur', notes: 'Notes', prototype_id: 'Prototype', pilot_qty: 'Série pilote', lead_time_days: 'Délai (jours)', target_date: 'Date cible',
}

/** Jours restants (négatif = retard) jusqu'à une date ISO ; null sans date. */
export function daysUntil(d: string | null | undefined, today = new Date()): number | null {
  if (!d) return null
  const t = new Date(`${d.slice(0, 10)}T00:00:00`).getTime()
  const n = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  return Math.round((t - n) / 86_400_000)
}
