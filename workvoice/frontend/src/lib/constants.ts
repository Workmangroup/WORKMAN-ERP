import type { Kind, Role, Statut, Urgence } from "@/types";

export const STATUTS: Statut[] = ["NOUVEAU", "EN_COURS", "EN_ATTENTE", "RESOLU", "CLOTURE"];

export const STATUT_LABELS: Record<Statut, string> = {
  NOUVEAU: "Nouveau",
  EN_COURS: "En cours",
  EN_ATTENTE: "En attente",
  RESOLU: "Résolu",
  CLOTURE: "Clôturé",
};

export const STATUT_STYLES: Record<Statut, string> = {
  NOUVEAU: "bg-blue-50 text-blue-700 ring-blue-600/20",
  EN_COURS: "bg-amber-50 text-amber-800 ring-amber-600/25",
  EN_ATTENTE: "bg-violet-50 text-violet-700 ring-violet-600/20",
  RESOLU: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  CLOTURE: "bg-slate-100 text-slate-600 ring-slate-500/20",
};

export const URGENCES: Urgence[] = ["FAIBLE", "MOYEN", "ELEVE", "CRITIQUE"];

export const URGENCE_LABELS: Record<Urgence, string> = {
  FAIBLE: "Faible",
  MOYEN: "Moyen",
  ELEVE: "Élevé",
  CRITIQUE: "Critique",
};

export const URGENCE_STYLES: Record<Urgence, string> = {
  FAIBLE: "bg-slate-100 text-slate-600 ring-slate-500/20",
  MOYEN: "bg-sky-50 text-sky-700 ring-sky-600/20",
  ELEVE: "bg-orange-50 text-orange-700 ring-orange-600/25",
  CRITIQUE: "bg-red-600 text-white ring-red-700",
};

export const TYPES_DEMANDE: Record<string, string> = {
  ATTESTATION_TRAVAIL: "Attestation de travail",
  ATTESTATION_SALAIRE: "Attestation de salaire",
  SOLDE_CONGES: "Solde congés",
  CONGE: "Congé",
  AVANCE_SALAIRE: "Avance sur salaire",
  FORMATION: "Formation",
  AUTRE: "Autre",
};

export const CATEGORIES: Record<string, string> = {
  PAIE: "Paie",
  CONDITIONS_TRAVAIL: "Conditions de travail",
  RESPONSABLE_HIERARCHIQUE: "Responsable hiérarchique",
  EQUIPEMENT: "Équipement",
  SECURITE: "Sécurité",
  HARCELEMENT: "Harcèlement",
  ORGANISATION: "Organisation",
  AUTRE: "Autre",
};

export const THEMES: Record<string, string> = {
  ORGANISATION: "Organisation",
  QUALITE: "Qualité",
  SECURITE: "Sécurité",
  BIEN_ETRE: "Bien-être",
  ENVIRONNEMENT: "Environnement",
  DIGITAL: "Digital",
  AUTRE: "Autre",
};

export const KINDS: Record<Kind, { label: string; plural: string; api: string; types: Record<string, string> }> = {
  demande: { label: "Demande RH", plural: "Demandes RH", api: "demandes", types: TYPES_DEMANDE },
  reclamation: { label: "Réclamation", plural: "Réclamations", api: "reclamations", types: CATEGORIES },
  suggestion: { label: "Suggestion", plural: "Suggestions", api: "suggestions", types: THEMES },
};

export const typeLabel = (kind: Kind, type: string) => KINDS[kind].types[type] ?? type;

export const ROLE_HOME: Record<Role, string> = {
  EMPLOYE: "/employe/",
  RH: "/rh/",
  DIRECTION: "/direction/",
  SYSTEM_ADMIN: "/admin/societes/",
};

export const ROLE_LABELS: Record<Role, string> = {
  EMPLOYE: "Collaborateur",
  RH: "Ressources Humaines",
  DIRECTION: "Direction",
  SYSTEM_ADMIN: "Administrateur Système",
};

export const ATTESTATION_STATUT_LABELS: Record<string, string> = {
  SUBMITTED: "Soumise", IN_REVIEW: "En cours de traitement", GENERATED: "Document généré",
  APPROVED: "Validée", READY: "Prête", REJECTED: "Refusée", CANCELLED: "Annulée",
};

export const ATTESTATION_STATUT_STYLES: Record<string, string> = {
  SUBMITTED: "bg-slate-100 text-slate-700 ring-slate-500/20",
  IN_REVIEW: "bg-blue-50 text-blue-700 ring-blue-600/20",
  GENERATED: "bg-wm-yellow-50 text-amber-800 ring-amber-500/30",
  APPROVED: "bg-wm-yellow-50 text-amber-800 ring-amber-500/30",
  READY: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  REJECTED: "bg-red-50 text-red-700 ring-red-600/20",
  CANCELLED: "bg-slate-100 text-slate-500 ring-slate-400/20",
};

export const ATTESTATION_TYPE_LABELS: Record<string, string> = {
  ATTESTATION_TRAVAIL: "Attestation de travail",
  ATTESTATION_SALAIRE: "Attestation de salaire",
};

export const MOIS_COURTS =["Janv.", "Févr.", "Mars", "Avr.", "Mai", "Juin", "Juil.", "Août", "Sept.", "Oct.", "Nov.", "Déc."];

/** Échelle du questionnaire GRH-IFD-23 (5 = tout à fait d'accord). Affichée de 5 à 1 comme le formulaire papier. */
export const ECHELLE_QSP = [
  { note: 5, fr: "Tout à fait d'accord", frLong: "Tout à fait d'accord / Très satisfait(e)", ar: "أوافق تمامًا / راضٍ جدًا", color: "bg-emerald-600", ring: "ring-emerald-600", soft: "bg-emerald-50 text-emerald-800" },
  { note: 4, fr: "Plutôt d'accord", frLong: "Plutôt d'accord / Satisfait(e)", ar: "أوافق إلى حد ما / راضٍ", color: "bg-lime-500", ring: "ring-lime-500", soft: "bg-lime-50 text-lime-800" },
  { note: 3, fr: "Neutre", frLong: "Ni d'accord ni pas d'accord / Neutre", ar: "لا أوافق ولا أعارض / محايد", color: "bg-slate-400", ring: "ring-slate-400", soft: "bg-slate-100 text-slate-700" },
  { note: 2, fr: "Plutôt pas d'accord", frLong: "Plutôt pas d'accord / Peu satisfait(e)", ar: "لا أوافق إلى حد ما / غير راضٍ", color: "bg-orange-500", ring: "ring-orange-500", soft: "bg-orange-50 text-orange-800" },
  { note: 1, fr: "Pas du tout d'accord", frLong: "Pas du tout d'accord / Pas du tout satisfait(e)", ar: "لا أوافق أبدًا / غير راضٍ تمامًا", color: "bg-red-600", ring: "ring-red-600", soft: "bg-red-50 text-red-800" },
] as const;

export const CAMPAGNE_STATUT: Record<string, { label: string; style: string }> = {
  BROUILLON: { label: "Brouillon", style: "bg-slate-100 text-slate-600 ring-slate-500/20" },
  OUVERTE: { label: "Ouverte", style: "bg-emerald-50 text-emerald-700 ring-emerald-600/20" },
  CLOTUREE: { label: "Clôturée", style: "bg-blue-50 text-blue-700 ring-blue-600/20" },
};

// ---------------------------------------------------------------- Modules Congés / Sorties / Retards

export const ABSENCE_STATUT_LABELS: Record<string, string> = {
  BROUILLON: "Brouillon",
  EN_ATTENTE: "En attente",
  VALIDE: "Validé",
  REFUSE: "Refusé",
  ANNULE: "Annulé",
};

export const ABSENCE_STATUT_STYLES: Record<string, string> = {
  BROUILLON: "bg-slate-100 text-slate-600 ring-slate-500/20",
  EN_ATTENTE: "bg-amber-50 text-amber-800 ring-amber-600/25",
  VALIDE: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  REFUSE: "bg-red-50 text-red-700 ring-red-600/20",
  ANNULE: "bg-slate-100 text-slate-500 ring-slate-500/20",
};

export const TYPE_CONTRAT_LABELS: Record<string, string> = {
  CDI: "CDI",
  CDD: "CDD",
  SIVP: "SIVP",
  STAGE: "Stage",
  INTERIM: "Intérim",
  AUTRE: "Autre",
};

export const ALERTE_NIVEAU_STYLES: Record<string, string> = {
  INFO: "bg-sky-50 text-sky-700 ring-sky-600/20",
  ATTENTION: "bg-amber-50 text-amber-800 ring-amber-600/25",
  CRITIQUE: "bg-red-50 text-red-700 ring-red-600/20",
};

export function formatDuree(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m}`;
}
