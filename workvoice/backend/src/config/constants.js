export const ROLES = Object.freeze({
  EMPLOYE: 'EMPLOYE',
  RH: 'RH',
  DIRECTION: 'DIRECTION',
});

export const STATUTS = ['NOUVEAU', 'EN_COURS', 'EN_ATTENTE', 'RESOLU', 'CLOTURE'];
export const STATUTS_TERMINES = ['RESOLU', 'CLOTURE'];

// Modules Congés / Sorties / Retards — workflow Collaborateur → RH → Validation/Refus.
// Congés a en plus l'état BROUILLON ; Sorties et Retards utilisent le même sous-ensemble.
export const CONGE_STATUTS = ['BROUILLON', 'EN_ATTENTE', 'VALIDE', 'REFUSE', 'ANNULE'];
export const ABSENCE_STATUTS = ['EN_ATTENTE', 'VALIDE', 'REFUSE', 'ANNULE'];
export const TYPES_CONTRAT = ['CDI', 'CDD', 'SIVP', 'STAGE', 'INTERIM', 'AUTRE'];

export const TYPES_DEMANDE = [
  'ATTESTATION_TRAVAIL',
  'ATTESTATION_SALAIRE',
  'SOLDE_CONGES',
  'CONGE',
  'AVANCE_SALAIRE',
  'FORMATION',
  'AUTRE',
];

export const CATEGORIES_RECLAMATION = [
  'PAIE',
  'CONDITIONS_TRAVAIL',
  'RESPONSABLE_HIERARCHIQUE',
  'EQUIPEMENT',
  'SECURITE',
  'HARCELEMENT',
  'ORGANISATION',
  'AUTRE',
];

/** Catégories toujours traitées comme confidentielles. */
export const CATEGORIES_TOUJOURS_CONFIDENTIELLES = ['HARCELEMENT'];

export const NIVEAUX_URGENCE = ['FAIBLE', 'MOYEN', 'ELEVE', 'CRITIQUE'];

export const THEMES_SUGGESTION = [
  'ORGANISATION',
  'QUALITE',
  'SECURITE',
  'BIEN_ETRE',
  'ENVIRONNEMENT',
  'DIGITAL',
  'AUTRE',
];

export const LABELS = {
  statut: {
    NOUVEAU: 'Nouveau',
    EN_COURS: 'En cours',
    EN_ATTENTE: 'En attente',
    RESOLU: 'Résolu',
    CLOTURE: 'Clôturé',
  },
  type_demande: {
    ATTESTATION_TRAVAIL: 'Attestation de travail',
    ATTESTATION_SALAIRE: 'Attestation de salaire',
    SOLDE_CONGES: 'Solde congés',
    CONGE: 'Congé',
    AVANCE_SALAIRE: 'Avance sur salaire',
    FORMATION: 'Formation',
    AUTRE: 'Autre',
  },
  categorie: {
    PAIE: 'Paie',
    CONDITIONS_TRAVAIL: 'Conditions de travail',
    RESPONSABLE_HIERARCHIQUE: 'Responsable hiérarchique',
    EQUIPEMENT: 'Équipement',
    SECURITE: 'Sécurité',
    HARCELEMENT: 'Harcèlement',
    ORGANISATION: 'Organisation',
    AUTRE: 'Autre',
  },
  niveau_urgence: {
    FAIBLE: 'Faible',
    MOYEN: 'Moyen',
    ELEVE: 'Élevé',
    CRITIQUE: 'Critique',
  },
  theme: {
    ORGANISATION: 'Organisation',
    QUALITE: 'Qualité',
    SECURITE: 'Sécurité',
    BIEN_ETRE: 'Bien-être',
    ENVIRONNEMENT: 'Environnement',
    DIGITAL: 'Digital',
    AUTRE: 'Autre',
  },
  statut_absence: {
    BROUILLON: 'Brouillon',
    EN_ATTENTE: 'En attente',
    VALIDE: 'Validé',
    REFUSE: 'Refusé',
    ANNULE: 'Annulé',
  },
  type_contrat: {
    CDI: 'CDI',
    CDD: 'CDD',
    SIVP: 'SIVP',
    STAGE: 'Stage',
    INTERIM: 'Intérim',
    AUTRE: 'Autre',
  },
};

/** Pièces jointes autorisées : type MIME → extensions acceptées. */
export const ALLOWED_UPLOADS = {
  'application/pdf': ['.pdf'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'application/msword': ['.doc'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  // Accepté en plus pour les déclarations de retard (justificatifs multiples)
  'application/zip': ['.zip'],
  'application/x-zip-compressed': ['.zip'],
};
