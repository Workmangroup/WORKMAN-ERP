export type Role = "EMPLOYE" | "RH" | "DIRECTION";
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
  derniere_connexion?: string | null;
  created_at?: string;
  actif?: boolean;
  /** Mot de passe provisoire (créé ou réinitialisé par le RH) à changer. */
  mdp_temporaire?: boolean;
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
