export type Role = "EMPLOYE" | "RH" | "DIRECTION" | "SYSTEM_ADMIN";
export type Kind = "demande" | "reclamation" | "suggestion";
export type Statut = "NOUVEAU" | "EN_COURS" | "EN_ATTENTE" | "RESOLU" | "CLOTURE";
export type Urgence = "FAIBLE" | "MOYEN" | "ELEVE" | "CRITIQUE";

export interface User {
  id: number;
  matricule: string;
  nom: string;
  prenom: string;
  email: string | null;
  telephone: string | null;
  service: string;
  departement: string;
  site: string;
  role: Role;
  /** Multi-société : null = portée globale (SYSTEM_ADMIN / DIRECTION). */
  company_id?: number | null;
  derniere_connexion?: string | null;
  created_at?: string;
  actif?: boolean;
  /** Mot de passe provisoire (créé ou réinitialisé par le RH) à changer. */
  mdp_temporaire?: boolean;

  // ---- Fiche collaborateur enrichie (Module 4) — visible RH uniquement ----
  societe?: string | null;
  fonction?: string | null;
  manager_id?: number | null;
  matricule_paie?: string | null;
  date_naissance?: string | null;
  adresse?: string | null;
  cin?: string | null;
  cin_date_delivrance?: string | null;
  cnss?: string | null;
  date_embauche?: string | null;
  date_fin_contrat?: string | null;
  type_contrat?: TypeContrat | null;
  salaire_base?: number | null;
  prime?: number | null;
  indemnite?: number | null;
  observations_rh?: string | null;
  solde_conge_initial?: number;
  solde_conge_actuel?: number;
}

export interface Auteur {
  matricule: string;
  nom: string;
  prenom: string;
  email: string | null;
  telephone: string | null;
  service: string;
  departement: string;
  site: string;
}

export interface Commentaire {
  id: number;
  message: string;
  date_creation: string;
  est_moi: boolean;
  auteur: { role: Role; nom: string };
}

export interface Ticket {
  kind: Kind;
  id: number;
  numero: string;
  type: string;
  objet: string;
  description: string;
  statut: Statut;
  date_creation: string;
  date_maj: string;
  date_cloture: string | null;
  niveau_urgence?: Urgence;
  confidentielle?: boolean;
  has_piece_jointe?: boolean;
  piece_jointe_nom?: string | null;
  nb_commentaires?: number;
  auteur?: Auteur;
  commentaires?: Commentaire[];
}

export interface TicketSummary {
  kind: Kind;
  id: number;
  numero: string;
  type: string;
  objet: string;
  statut: Statut;
  date_creation: string;
  date_maj?: string;
  date_cloture?: string | null;
  niveau_urgence?: Urgence | null;
  nom?: string;
  prenom?: string;
  matricule?: string;
  site?: string;
}

export interface Paged<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
}

export interface Notification {
  id: number;
  type: string;
  titre: string;
  message: string;
  lien: string | null;
  lu: boolean;
  date_creation: string;
}

export interface DirectionReclamation {
  id: number;
  numero: string;
  categorie: string;
  objet: string;
  description: string;
  niveau_urgence: Urgence;
  confidentielle: boolean;
  statut: Statut;
  date_creation: string;
  date_cloture: string | null;
  service: string;
  departement: string;
  site: string;
}

export interface QuestionQsp {
  id: number;
  ordre: number;
  texte_fr: string;
  texte_ar: string;
  inverse: boolean;
}

export interface Campagne {
  id: number;
  titre: string;
  reference: string;
  date_debut: string;
  date_fin: string | null;
  statut?: "BROUILLON" | "OUVERTE" | "CLOTUREE";
  nb_reponses?: number;
  effectif?: number;
  taux_participation?: number;
  indice_satisfaction?: number | null;
}

export interface ResultatsQsp {
  campagne: Campagne;
  seuil: number;
  nb_reponses: number;
  effectif: number;
  taux_participation: number | null;
  insuffisant: boolean;
  indice_satisfaction?: number | null;
  par_question?: {
    question_id: number;
    ordre: number;
    texte_fr: string;
    texte_ar: string;
    inverse: boolean;
    repartition: number[];
    total: number;
    moyenne: number;
    indice: number;
    taux_favorable: number;
  }[];
  par_departement?: { groupes: { groupe: string; n: number; indice: number }[]; reponses_masquees: number };
  par_site?: { groupes: { groupe: string; n: number; indice: number }[]; reponses_masquees: number };
  commentaires?: string[];
}

// ---------------------------------------------------------------- Modules Congés / Sorties / Retards

export type AbsenceStatut = "BROUILLON" | "EN_ATTENTE" | "VALIDE" | "REFUSE" | "ANNULE";
export type TypeContrat = "CDI" | "CDD" | "SIVP" | "STAGE" | "INTERIM" | "AUTRE";

export interface CongeType {
  id: number;
  code: string;
  libelle: string;
  deduit_solde: boolean;
  is_systeme?: boolean;
  actif?: boolean;
  ordre?: number;
}

export interface CongeDemande {
  id: number;
  numero: string;
  date_debut: string;
  date_fin: string;
  nb_jours: number;
  statut: AbsenceStatut;
  motif_refus?: string | null;
  date_creation: string;
  date_traitement?: string | null;
  type_code: string;
  type_libelle: string;
  deduit_solde?: boolean;
  has_piece_jointe?: boolean;
  piece_jointe_nom?: string | null;
  commentaire?: string | null;
  auteur?: Auteur;
  matricule?: string;
  nom?: string;
  prenom?: string;
  service?: string;
  departement?: string;
  site?: string;
}

export interface CongeMouvement {
  id: number;
  type: "INITIAL" | "AJOUT" | "DEDUCTION" | "ANNULATION" | "AJUSTEMENT";
  jours: number;
  solde_apres: number;
  commentaire: string | null;
  date_creation: string;
  numero?: string | null;
}

export interface JourFerie {
  id: number;
  date_ferie: string;
  libelle: string;
}

export interface Motif {
  id: number;
  libelle: string;
  actif?: boolean;
  ordre?: number;
}

export interface SortieDemande {
  id: number;
  numero: string;
  date_sortie: string;
  heure_debut: string;
  heure_fin: string;
  duree_minutes: number;
  statut: AbsenceStatut;
  motif_refus?: string | null;
  date_creation: string;
  motif_libelle: string;
  commentaire?: string | null;
  auteur?: Auteur;
  matricule?: string;
  nom?: string;
  prenom?: string;
  service?: string;
  departement?: string;
  site?: string;
  societe?: string | null;
}

export interface RetardDeclaration {
  id: number;
  numero: string;
  date_retard: string;
  heure_arrivee: string;
  statut: AbsenceStatut;
  motif_refus?: string | null;
  date_creation: string;
  motif_libelle: string;
  commentaire?: string | null;
  has_piece_jointe?: boolean;
  auteur?: Auteur;
  matricule?: string;
  nom?: string;
  prenom?: string;
  service?: string;
  departement?: string;
  site?: string;
}

export interface Alerte {
  niveau: "INFO" | "ATTENTION" | "CRITIQUE";
  categorie: string;
  message: string;
}

// ---------------------------------------------------------------- Multi-société (Administration système)

// ---------------------------------------------------------------- Attestations RH

export type AttestationType = "ATTESTATION_TRAVAIL" | "ATTESTATION_SALAIRE";
export type AttestationStatut = "SUBMITTED" | "IN_REVIEW" | "GENERATED" | "APPROVED" | "READY" | "REJECTED" | "CANCELLED";

export interface AttestationRequest {
  id: number;
  numero: string;
  type: AttestationType;
  type_libelle: string;
  statut: AttestationStatut;
  statut_libelle: string;
  commentaire: string | null;
  rejection_reason: string | null;
  date_creation: string;
  date_maj: string;
  // RH uniquement
  company_id?: number;
  version?: number;
  document_id?: number | null;
  matricule?: string;
  nom?: string;
  prenom?: string;
  service?: string;
  departement?: string;
  site?: string;
  company_name?: string;
}

export interface Company {
  id: number;
  company_code: string;
  company_name: string;
  legal_name: string | null;
  address: string | null;
  city: string | null;
  country: string;
  phone: string | null;
  email: string | null;
  tax_number: string | null;
  status: "ACTIVE" | "INACTIVE";
  nb_collaborateurs: number;
  nb_rh: number;
}
