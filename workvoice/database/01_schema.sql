-- =====================================================================
--  WORKVOICE — Portail Collaborateur Workman
--  01_schema.sql — Schéma de base de données (MySQL 8.0.16+)
-- =====================================================================

CREATE DATABASE IF NOT EXISTS workvoice
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE workvoice;

SET FOREIGN_KEY_CHECKS = 0;
DROP VIEW  IF EXISTS v_direction_reclamations;
DROP VIEW  IF EXISTS v_direction_demandes;
DROP TABLE IF EXISTS attestation_requests;
DROP TABLE IF EXISTS hr_document_versions;
DROP TABLE IF EXISTS hr_documents;
DROP TABLE IF EXISTS retards_declarations;
DROP TABLE IF EXISTS retards_motifs;
DROP TABLE IF EXISTS sorties_demandes;
DROP TABLE IF EXISTS sorties_motifs;
DROP TABLE IF EXISTS conges_mouvements;
DROP TABLE IF EXISTS conges_demandes;
DROP TABLE IF EXISTS conges_types;
DROP TABLE IF EXISTS jours_feries;
DROP TABLE IF EXISTS questionnaire_reponses_detail;
DROP TABLE IF EXISTS questionnaire_reponses;
DROP TABLE IF EXISTS questionnaire_participations;
DROP TABLE IF EXISTS questionnaire_questions;
DROP TABLE IF EXISTS questionnaire_campagnes;
DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS notifications;
DROP TABLE IF EXISTS commentaires;
DROP TABLE IF EXISTS suggestions;
DROP TABLE IF EXISTS reclamations;
DROP TABLE IF EXISTS demandes;
DROP TABLE IF EXISTS sequences;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS companies;
SET FOREIGN_KEY_CHECKS = 1;

-- ---------------------------------------------------------------------
--  COMPANIES — Multi-société (Multi-Tenant)
-- ---------------------------------------------------------------------
CREATE TABLE companies (
  id            INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  company_code  VARCHAR(20)   NOT NULL,
  company_name  VARCHAR(120)  NOT NULL,
  legal_name    VARCHAR(180)  NULL,
  address       VARCHAR(255)  NULL,
  city          VARCHAR(80)   NULL,
  country       VARCHAR(80)   NOT NULL DEFAULT 'Tunisie',
  phone         VARCHAR(30)   NULL,
  email         VARCHAR(150)  NULL,
  tax_number    VARCHAR(40)   NULL,
  logo          VARCHAR(255)  NULL,
  status        ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  settings      JSON          NULL COMMENT 'Paramètres par société (jours travaillés, congés par défaut, etc.)',
  created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at    DATETIME      NULL COMMENT 'Réservé : une société se désactive via status, ne se supprime jamais physiquement',
  PRIMARY KEY (id),
  UNIQUE KEY uq_companies_code (company_code)
) ENGINE=InnoDB;

INSERT INTO companies (id, company_code, company_name) VALUES
  (1, 'WORKMAN', 'Workman'),
  (2, 'STID', 'STID Export'),
  (3, 'MBCONF', 'MB Confection'),
  (4, 'SOMICO', 'Somico');

-- ---------------------------------------------------------------------
--  USERS
-- ---------------------------------------------------------------------
CREATE TABLE users (
  id                  INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  matricule           VARCHAR(20)   NOT NULL,
  nom                 VARCHAR(80)   NOT NULL,
  prenom              VARCHAR(80)   NOT NULL,
  email               VARCHAR(150)  NULL,
  telephone           VARCHAR(30)   NULL,
  service             VARCHAR(80)   NOT NULL,
  departement         VARCHAR(80)   NOT NULL,
  site                VARCHAR(80)   NOT NULL,
  role                ENUM('EMPLOYE','RH','DIRECTION','SYSTEM_ADMIN') NOT NULL DEFAULT 'EMPLOYE',
  company_id          INT UNSIGNED  NULL COMMENT 'NULL = portée globale (SYSTEM_ADMIN / DIRECTION)',
  password            VARCHAR(255)  NOT NULL COMMENT 'Hash bcrypt',
  mdp_temporaire      TINYINT(1)    NOT NULL DEFAULT 0 COMMENT '1 = mot de passe provisoire à changer à la prochaine connexion',
  actif               TINYINT(1)    NOT NULL DEFAULT 1,
  derniere_connexion  DATETIME      NULL,
  -- ---- Fiche collaborateur enrichie (Module 4) — RH uniquement, jamais exposé
  --      à la Direction ni renvoyé par /auth/me ou /me/profile.
  societe               VARCHAR(80)  NULL COMMENT 'Entité juridique (ex. MB Confection, STID Export)',
  fonction               VARCHAR(100) NULL,
  manager_id             INT UNSIGNED NULL,
  matricule_paie         VARCHAR(20)  NULL,
  date_naissance         DATE         NULL,
  adresse                VARCHAR(255) NULL,
  cin                    VARCHAR(20)  NULL,
  cin_date_delivrance    DATE         NULL,
  cnss                   VARCHAR(30)  NULL,
  date_embauche          DATE         NULL,
  date_fin_contrat       DATE         NULL,
  type_contrat           ENUM('CDI','CDD','SIVP','STAGE','INTERIM','AUTRE') NULL,
  salaire_base           DECIMAL(10,2) NULL,
  prime                  DECIMAL(10,2) NULL,
  indemnite              DECIMAL(10,2) NULL,
  observations_rh        TEXT NULL,
  solde_conge_initial    DECIMAL(5,1) NOT NULL DEFAULT 0,
  solde_conge_actuel     DECIMAL(5,1) NOT NULL DEFAULT 0,
  created_at          DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_matricule (matricule),
  UNIQUE KEY uq_users_email (email),
  KEY idx_users_role (role, actif),
  KEY idx_users_orga (departement, service, site),
  KEY idx_users_manager (manager_id),
  KEY idx_users_company (company_id),
  CONSTRAINT fk_users_manager FOREIGN KEY (manager_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_users_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE RESTRICT
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
--  SEQUENCES — numérotation annuelle atomique (DEM / REC / SUG)
-- ---------------------------------------------------------------------
CREATE TABLE sequences (
  prefixe  VARCHAR(5)        NOT NULL,
  annee    SMALLINT UNSIGNED NOT NULL,
  dernier  INT UNSIGNED      NOT NULL DEFAULT 0,
  PRIMARY KEY (prefixe, annee)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
--  DEMANDES RH
-- ---------------------------------------------------------------------
CREATE TABLE demandes (
  id                 INT UNSIGNED NOT NULL AUTO_INCREMENT,
  numero_demande     VARCHAR(20)  NOT NULL,
  user_id            INT UNSIGNED NOT NULL,
  company_id         INT UNSIGNED NULL COMMENT 'Dénormalisé depuis users.company_id à la création',
  type_demande       ENUM('ATTESTATION_TRAVAIL','ATTESTATION_SALAIRE','SOLDE_CONGES',
                          'CONGE','AVANCE_SALAIRE','FORMATION','AUTRE') NOT NULL,
  objet              VARCHAR(150) NOT NULL,
  description        TEXT         NOT NULL,
  piece_jointe       VARCHAR(255) NULL COMMENT 'Nom de fichier stocké (UUID)',
  piece_jointe_nom   VARCHAR(255) NULL COMMENT 'Nom de fichier d''origine',
  piece_jointe_mime  VARCHAR(100) NULL,
  statut             ENUM('NOUVEAU','EN_COURS','EN_ATTENTE','RESOLU','CLOTURE') NOT NULL DEFAULT 'NOUVEAU',
  date_creation      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  date_maj           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  date_cloture       DATETIME     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_demandes_numero (numero_demande),
  KEY idx_demandes_user (user_id, date_creation),
  KEY idx_demandes_statut (statut, date_creation),
  KEY idx_demandes_type (type_demande),
  KEY idx_demandes_company (company_id),
  CONSTRAINT fk_demandes_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_demandes_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE RESTRICT
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
--  RECLAMATIONS
-- ---------------------------------------------------------------------
CREATE TABLE reclamations (
  id                  INT UNSIGNED NOT NULL AUTO_INCREMENT,
  numero_reclamation  VARCHAR(20)  NOT NULL,
  user_id             INT UNSIGNED NOT NULL,
  company_id          INT UNSIGNED NULL COMMENT 'Dénormalisé depuis users.company_id à la création',
  categorie           ENUM('PAIE','CONDITIONS_TRAVAIL','RESPONSABLE_HIERARCHIQUE','EQUIPEMENT',
                           'SECURITE','HARCELEMENT','ORGANISATION','AUTRE') NOT NULL,
  objet               VARCHAR(150) NOT NULL,
  description         TEXT         NOT NULL,
  niveau_urgence      ENUM('FAIBLE','MOYEN','ELEVE','CRITIQUE') NOT NULL DEFAULT 'MOYEN',
  confidentielle      TINYINT(1)   NOT NULL DEFAULT 0,
  statut              ENUM('NOUVEAU','EN_COURS','EN_ATTENTE','RESOLU','CLOTURE') NOT NULL DEFAULT 'NOUVEAU',
  date_creation       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  date_maj            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  date_cloture        DATETIME     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_reclamations_numero (numero_reclamation),
  KEY idx_reclamations_user (user_id, date_creation),
  KEY idx_reclamations_statut (statut, date_creation),
  KEY idx_reclamations_categorie (categorie),
  KEY idx_reclamations_urgence (niveau_urgence, statut),
  KEY idx_reclamations_company (company_id),
  CONSTRAINT fk_reclamations_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_reclamations_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE RESTRICT,
  -- Le harcèlement est toujours confidentiel
  CONSTRAINT chk_reclamations_harcelement CHECK (categorie <> 'HARCELEMENT' OR confidentielle = 1)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
--  SUGGESTIONS
-- ---------------------------------------------------------------------
CREATE TABLE suggestions (
  id                 INT UNSIGNED NOT NULL AUTO_INCREMENT,
  numero_suggestion  VARCHAR(20)  NOT NULL,
  user_id            INT UNSIGNED NOT NULL,
  company_id         INT UNSIGNED NULL COMMENT 'Dénormalisé depuis users.company_id à la création',
  theme              ENUM('ORGANISATION','QUALITE','SECURITE','BIEN_ETRE','ENVIRONNEMENT',
                          'DIGITAL','AUTRE') NOT NULL DEFAULT 'AUTRE',
  objet              VARCHAR(150) NOT NULL,
  description        TEXT         NOT NULL,
  statut             ENUM('NOUVEAU','EN_COURS','EN_ATTENTE','RESOLU','CLOTURE') NOT NULL DEFAULT 'NOUVEAU',
  date_creation      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  date_maj           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  date_cloture       DATETIME     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_suggestions_numero (numero_suggestion),
  KEY idx_suggestions_user (user_id, date_creation),
  KEY idx_suggestions_statut (statut, date_creation),
  KEY idx_suggestions_company (company_id),
  CONSTRAINT fk_suggestions_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_suggestions_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE RESTRICT
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
--  COMMENTAIRES — rattaché à exactement un ticket
-- ---------------------------------------------------------------------
CREATE TABLE commentaires (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  demande_id      INT UNSIGNED NULL,
  reclamation_id  INT UNSIGNED NULL,
  suggestion_id   INT UNSIGNED NULL,
  user_id         INT UNSIGNED NOT NULL,
  message         TEXT         NOT NULL,
  date_creation   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_commentaires_demande (demande_id, date_creation),
  KEY idx_commentaires_reclamation (reclamation_id, date_creation),
  KEY idx_commentaires_suggestion (suggestion_id, date_creation),
  KEY idx_commentaires_user (user_id),
  CONSTRAINT fk_commentaires_demande     FOREIGN KEY (demande_id)     REFERENCES demandes (id),
  CONSTRAINT fk_commentaires_reclamation FOREIGN KEY (reclamation_id) REFERENCES reclamations (id),
  CONSTRAINT fk_commentaires_suggestion  FOREIGN KEY (suggestion_id)  REFERENCES suggestions (id),
  CONSTRAINT fk_commentaires_user        FOREIGN KEY (user_id)        REFERENCES users (id),
  CONSTRAINT chk_commentaires_cible CHECK (
    (demande_id IS NOT NULL) + (reclamation_id IS NOT NULL) + (suggestion_id IS NOT NULL) = 1
  )
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
--  NOTIFICATIONS (in-app)
-- ---------------------------------------------------------------------
CREATE TABLE notifications (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id        INT UNSIGNED NOT NULL,
  company_id     INT UNSIGNED NULL COMMENT 'Dénormalisé depuis users.company_id, pour un filtrage RH sans jointure',
  type           VARCHAR(40)  NOT NULL,
  titre          VARCHAR(150) NOT NULL,
  message        VARCHAR(500) NOT NULL,
  lien           VARCHAR(255) NULL,
  lu             TINYINT(1)   NOT NULL DEFAULT 0,
  date_creation  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_notifications_user (user_id, lu, date_creation),
  KEY idx_notifications_company (company_id),
  CONSTRAINT fk_notifications_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_notifications_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE RESTRICT
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
--  AUDIT LOGS — journalisation des actions
-- ---------------------------------------------------------------------
CREATE TABLE audit_logs (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id        INT UNSIGNED    NULL,
  company_id     INT UNSIGNED    NULL COMMENT 'Dénormalisé depuis users.company_id ; NULL sur une action système sans utilisateur',
  action         VARCHAR(60)     NOT NULL,
  entite         VARCHAR(40)     NULL,
  entite_id      INT UNSIGNED    NULL,
  ip             VARCHAR(45)     NULL,
  user_agent     VARCHAR(255)    NULL,
  details        JSON            NULL,
  date_creation  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_audit_user (user_id, date_creation),
  KEY idx_audit_action (action, date_creation),
  KEY idx_audit_entite (entite, entite_id),
  KEY idx_audit_company (company_id),
  CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_audit_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- =====================================================================
--  QUESTIONNAIRE DE SATISFACTION DU PERSONNEL (GRH-IFD-23)
--  Anonymat par construction :
--   - questionnaire_participations sait QUI a répondu (anti-doublon) ;
--   - questionnaire_reponses sait CE QUI a été répondu, sans aucun lien
--     avec l'utilisateur (identifiant UUID aléatoire, date sans heure).
--  Aucune jointure ne permet de relier une réponse à une personne.
-- =====================================================================
CREATE TABLE questionnaire_campagnes (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  titre          VARCHAR(150) NOT NULL,
  reference      VARCHAR(30)  NOT NULL DEFAULT 'GRH-IFD-23',
  date_debut     DATE         NOT NULL,
  date_fin       DATE         NULL,
  statut         ENUM('BROUILLON','OUVERTE','CLOTUREE') NOT NULL DEFAULT 'BROUILLON',
  created_by     INT UNSIGNED NULL,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_campagnes_statut (statut),
  CONSTRAINT fk_campagnes_user FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE questionnaire_questions (
  id        INT UNSIGNED NOT NULL AUTO_INCREMENT,
  ordre     SMALLINT UNSIGNED NOT NULL,
  texte_fr  VARCHAR(300) NOT NULL,
  texte_ar  VARCHAR(300) NOT NULL,
  inverse   TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '1 = formulation négative : score inversé dans l''indice',
  actif     TINYINT(1)   NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  KEY idx_questions_ordre (actif, ordre)
) ENGINE=InnoDB;

CREATE TABLE questionnaire_participations (
  campagne_id         INT UNSIGNED NOT NULL,
  user_id             INT UNSIGNED NOT NULL,
  date_participation  DATE         NOT NULL,
  PRIMARY KEY (campagne_id, user_id),
  KEY idx_participations_user (user_id),
  CONSTRAINT fk_participations_campagne FOREIGN KEY (campagne_id) REFERENCES questionnaire_campagnes (id),
  CONSTRAINT fk_participations_user     FOREIGN KEY (user_id)     REFERENCES users (id)
) ENGINE=InnoDB;

CREATE TABLE questionnaire_reponses (
  id               CHAR(36)     NOT NULL COMMENT 'UUID aléatoire : ne révèle pas l''ordre de soumission',
  campagne_id      INT UNSIGNED NOT NULL,
  service          VARCHAR(80)  NOT NULL,
  departement      VARCHAR(80)  NOT NULL,
  site             VARCHAR(80)  NOT NULL,
  date_soumission  DATE         NOT NULL,
  commentaire      TEXT         NULL,
  PRIMARY KEY (id),
  KEY idx_reponses_campagne (campagne_id, departement, site),
  CONSTRAINT fk_reponses_campagne FOREIGN KEY (campagne_id) REFERENCES questionnaire_campagnes (id)
) ENGINE=InnoDB;

CREATE TABLE questionnaire_reponses_detail (
  reponse_id   CHAR(36)         NOT NULL,
  question_id  INT UNSIGNED     NOT NULL,
  note         TINYINT UNSIGNED NOT NULL COMMENT '5 = Tout à fait d''accord … 1 = Pas du tout d''accord',
  PRIMARY KEY (reponse_id, question_id),
  KEY idx_detail_question (question_id, note),
  CONSTRAINT fk_detail_reponse  FOREIGN KEY (reponse_id)  REFERENCES questionnaire_reponses (id) ON DELETE CASCADE,
  CONSTRAINT fk_detail_question FOREIGN KEY (question_id) REFERENCES questionnaire_questions (id),
  CONSTRAINT chk_detail_note CHECK (note BETWEEN 1 AND 5)
) ENGINE=InnoDB;

-- Données de référence : questions du formulaire GRH-IFD-23 (version 01, 12/2025)
INSERT INTO questionnaire_questions (id, ordre, texte_fr, texte_ar, inverse) VALUES
  (1,  1,  'Je suis fier de travailler à STID.', 'أنا فخور بالعمل في شركة ستيد.', 0),
  (2,  2,  'Je recommande STID en tant qu’employeur à mes proches, amis, …etc.', 'أوصي بشركة ستيد كصاحب عمل لأقاربي وأصدقائي ، إلخ.', 0),
  (3,  3,  'Il y a une bonne ambiance de travail à STID.', 'يسود جو عمل جيد في شركة ستيد.', 0),
  (4,  4,  'Je suis satisfait de mon poste et de mon salaire.', 'أنا راضٍ عن عملي وراتبي.', 0),
  (5,  5,  'Ma charge de travail est équilibrée.', 'توزيع عبء عملي متوازن.', 0),
  (6,  6,  'Je me sens libre dans la façon de faire et d’organiser mon travail.', 'أشعر بالحرية في طريقة وتنظيم عملي.', 0),
  (7,  7,  'Je sais à qui m’adresser pour obtenir les informations recherchées.', 'أنا أعرف بمن أتصل للحصول على المعلومات التي أبحث عنها.', 0),
  (8,  8,  'Je me sens encouragé à prendre des initiatives et à proposer de nouvelles idées.', 'أشعر بالتشجيع على اتخاذ المبادرات والتوصل إلى أفكار جديدة.', 0),
  (9,  9,  'Mon supérieur hiérarchique est à l’écoute de mes besoins personnels et professionnels.', 'يستمع مديري المباشر إلى احتياجاتي الشخصية والمهنية.', 0),
  (10, 10, 'Les critères d’évolution professionnelle (promotion, augmentation) sont clairs et équitables.', 'معايير التطوير المهني (ترقية ، زيادة) واضحة وعادلة.', 0),
  (11, 11, 'J''ai déjà pensé à quitter mon poste.', 'فكرت بالفعل في ترك منصبي.', 1);

-- =====================================================================
--  MODULE 1 — GESTION DES CONGÉS
-- =====================================================================
CREATE TABLE jours_feries (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  date_ferie   DATE         NOT NULL,
  libelle      VARCHAR(150) NOT NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_jours_feries_date (date_ferie)
) ENGINE=InnoDB COMMENT='Jours feries configures par le RH, utilises dans le calcul des jours de conge';

CREATE TABLE conges_types (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  code          VARCHAR(30)  NOT NULL,
  libelle       VARCHAR(100) NOT NULL,
  deduit_solde  TINYINT(1)   NOT NULL DEFAULT 1 COMMENT '1 = decompte du solde de conge annuel',
  is_systeme    TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '1 = type standard, non supprimable (desactivable uniquement)',
  actif         TINYINT(1)   NOT NULL DEFAULT 1,
  ordre         SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  company_id    INT UNSIGNED NULL COMMENT 'NULL = gabarit partagé par toutes les sociétés',
  PRIMARY KEY (id),
  UNIQUE KEY uq_conges_types_code (code),
  KEY idx_conges_types_company (company_id),
  CONSTRAINT fk_conges_types_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE SET NULL
) ENGINE=InnoDB COMMENT='Types de conge, parametrables par le RH';

INSERT INTO conges_types (id, code, libelle, deduit_solde, is_systeme, ordre) VALUES
  (1, 'ANNUEL',       'Congé annuel',      1, 1, 1),
  (2, 'MALADIE',       'Congé maladie',     0, 1, 2),
  (3, 'EXCEPTIONNEL',  'Congé exceptionnel',0, 1, 3),
  (4, 'MATERNITE',     'Congé maternité',   0, 1, 4),
  (5, 'SANS_SOLDE',    'Congé sans solde',  0, 1, 5);

CREATE TABLE conges_demandes (
  id                 INT UNSIGNED NOT NULL AUTO_INCREMENT,
  numero             VARCHAR(20)  NOT NULL,
  user_id            INT UNSIGNED NOT NULL,
  company_id         INT UNSIGNED NULL COMMENT 'Dénormalisé depuis users.company_id à la création',
  type_id            INT UNSIGNED NOT NULL,
  date_debut         DATE         NOT NULL,
  date_fin           DATE         NOT NULL,
  nb_jours           DECIMAL(5,1) NOT NULL COMMENT 'Jours ouvres (hors samedi, dimanche, jours feries)',
  commentaire        TEXT         NULL,
  piece_jointe       VARCHAR(255) NULL COMMENT 'Nom de fichier stocke (UUID)',
  piece_jointe_nom   VARCHAR(255) NULL,
  piece_jointe_mime  VARCHAR(100) NULL,
  statut             ENUM('BROUILLON','EN_ATTENTE','VALIDE','REFUSE','ANNULE') NOT NULL DEFAULT 'EN_ATTENTE',
  motif_refus        VARCHAR(500) NULL,
  traite_par         INT UNSIGNED NULL,
  date_traitement    DATETIME     NULL,
  date_creation      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  date_maj           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_conges_demandes_numero (numero),
  KEY idx_conges_user (user_id, date_debut),
  KEY idx_conges_statut (statut, date_debut),
  KEY idx_conges_type (type_id),
  KEY idx_conges_company (company_id),
  CONSTRAINT fk_conges_user   FOREIGN KEY (user_id)  REFERENCES users (id),
  CONSTRAINT fk_conges_type   FOREIGN KEY (type_id)  REFERENCES conges_types (id),
  CONSTRAINT fk_conges_traite FOREIGN KEY (traite_par) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_conges_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE RESTRICT,
  CONSTRAINT chk_conges_dates CHECK (date_fin >= date_debut)
) ENGINE=InnoDB;

CREATE TABLE conges_mouvements (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id        INT UNSIGNED NOT NULL,
  demande_id     INT UNSIGNED NULL COMMENT 'NULL = ajustement manuel du RH (solde initial, regularisation)',
  type           ENUM('INITIAL','AJOUT','DEDUCTION','ANNULATION','AJUSTEMENT') NOT NULL,
  jours          DECIMAL(5,1) NOT NULL COMMENT 'Signe : positif = credit, negatif = debit',
  solde_apres    DECIMAL(6,1) NOT NULL,
  commentaire    VARCHAR(255) NULL,
  created_by     INT UNSIGNED NULL,
  date_creation  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_mouvements_user (user_id, date_creation),
  CONSTRAINT fk_mouvements_user    FOREIGN KEY (user_id)    REFERENCES users (id),
  CONSTRAINT fk_mouvements_demande FOREIGN KEY (demande_id) REFERENCES conges_demandes (id) ON DELETE SET NULL,
  CONSTRAINT fk_mouvements_by      FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB COMMENT='Historique du solde de conge, une ligne par mouvement';

-- =====================================================================
--  MODULE 2 — AUTORISATIONS DE SORTIE
-- =====================================================================
CREATE TABLE sorties_motifs (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  libelle     VARCHAR(100) NOT NULL,
  actif       TINYINT(1)   NOT NULL DEFAULT 1,
  ordre       SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  company_id  INT UNSIGNED NULL COMMENT 'NULL = gabarit partagé par toutes les sociétés',
  PRIMARY KEY (id),
  UNIQUE KEY uq_sorties_motifs_libelle (libelle),
  KEY idx_sorties_motifs_company (company_id),
  CONSTRAINT fk_sorties_motifs_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE SET NULL
) ENGINE=InnoDB;

INSERT INTO sorties_motifs (id, libelle, ordre) VALUES
  (1, 'Rendez-vous médical', 1),
  (2, 'Démarche administrative', 2),
  (3, 'Mission externe', 3),
  (4, 'Déplacement professionnel', 4),
  (5, 'Urgence familiale', 5),
  (6, 'Autre', 6);

CREATE TABLE sorties_demandes (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  numero           VARCHAR(20)  NOT NULL,
  user_id          INT UNSIGNED NOT NULL,
  company_id       INT UNSIGNED NULL COMMENT 'Dénormalisé depuis users.company_id à la création',
  motif_id         INT UNSIGNED NOT NULL,
  date_sortie      DATE         NOT NULL,
  heure_debut      TIME         NOT NULL,
  heure_fin        TIME         NOT NULL,
  duree_minutes    SMALLINT UNSIGNED NOT NULL,
  commentaire      TEXT         NULL,
  statut           ENUM('EN_ATTENTE','VALIDE','REFUSE','ANNULE') NOT NULL DEFAULT 'EN_ATTENTE',
  motif_refus      VARCHAR(500) NULL,
  traite_par       INT UNSIGNED NULL,
  date_traitement  DATETIME     NULL,
  date_creation    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  date_maj         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sorties_numero (numero),
  KEY idx_sorties_user (user_id, date_sortie),
  KEY idx_sorties_statut (statut, date_sortie),
  KEY idx_sorties_company (company_id),
  CONSTRAINT fk_sorties_user   FOREIGN KEY (user_id)  REFERENCES users (id),
  CONSTRAINT fk_sorties_motif  FOREIGN KEY (motif_id) REFERENCES sorties_motifs (id),
  CONSTRAINT fk_sorties_traite FOREIGN KEY (traite_par) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_sorties_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE RESTRICT,
  CONSTRAINT chk_sorties_heures CHECK (heure_fin > heure_debut)
) ENGINE=InnoDB;

-- =====================================================================
--  MODULE 3 — DÉCLARATION DES RETARDS
-- =====================================================================
CREATE TABLE retards_motifs (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  libelle     VARCHAR(100) NOT NULL,
  actif       TINYINT(1)   NOT NULL DEFAULT 1,
  ordre       SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  company_id  INT UNSIGNED NULL COMMENT 'NULL = gabarit partagé par toutes les sociétés',
  PRIMARY KEY (id),
  UNIQUE KEY uq_retards_motifs_libelle (libelle),
  KEY idx_retards_motifs_company (company_id),
  CONSTRAINT fk_retards_motifs_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE SET NULL
) ENGINE=InnoDB;

INSERT INTO retards_motifs (id, libelle, ordre) VALUES
  (1, 'Embouteillage', 1),
  (2, 'Transport public', 2),
  (3, 'Problème véhicule', 3),
  (4, 'Rendez-vous médical', 4),
  (5, 'Urgence familiale', 5),
  (6, 'Intempéries', 6),
  (7, 'Autre', 7);

CREATE TABLE retards_declarations (
  id                 INT UNSIGNED NOT NULL AUTO_INCREMENT,
  numero             VARCHAR(20)  NOT NULL,
  user_id            INT UNSIGNED NOT NULL,
  company_id         INT UNSIGNED NULL COMMENT 'Dénormalisé depuis users.company_id à la création',
  date_retard        DATE         NOT NULL,
  heure_arrivee      TIME         NOT NULL,
  motif_id           INT UNSIGNED NOT NULL,
  commentaire        TEXT         NULL,
  piece_jointe       VARCHAR(255) NULL,
  piece_jointe_nom   VARCHAR(255) NULL,
  piece_jointe_mime  VARCHAR(100) NULL,
  statut             ENUM('EN_ATTENTE','VALIDE','REFUSE','ANNULE') NOT NULL DEFAULT 'EN_ATTENTE',
  motif_refus        VARCHAR(500) NULL,
  traite_par         INT UNSIGNED NULL,
  date_traitement    DATETIME     NULL,
  date_creation      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  date_maj           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_retards_numero (numero),
  KEY idx_retards_user (user_id, date_retard),
  KEY idx_retards_statut (statut, date_retard),
  KEY idx_retards_company (company_id),
  CONSTRAINT fk_retards_user   FOREIGN KEY (user_id)  REFERENCES users (id),
  CONSTRAINT fk_retards_motif  FOREIGN KEY (motif_id) REFERENCES retards_motifs (id),
  CONSTRAINT fk_retards_traite FOREIGN KEY (traite_par) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_retards_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE RESTRICT
) ENGINE=InnoDB;

-- =====================================================================
--  ATTESTATIONS RH + COFFRE-FORT RH (fondation)
-- =====================================================================
CREATE TABLE hr_documents (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id       INT UNSIGNED NOT NULL,
  employee_id      INT UNSIGNED NOT NULL,
  category         ENUM('ATTESTATION_TRAVAIL','ATTESTATION_SALAIRE','CONTRAT','BULLETIN_PAIE','AVERTISSEMENT','DECISION_RH','AUTRE_DOCUMENT_SENSIBLE') NOT NULL,
  document_number  VARCHAR(30)  NULL,
  current_version  SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  status           ENUM('ACTIVE','CANCELLED') NOT NULL DEFAULT 'ACTIVE',
  uploaded_by      INT UNSIGNED NOT NULL,
  created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_hrdoc_company (company_id),
  KEY idx_hrdoc_employee (employee_id, category),
  CONSTRAINT fk_hrdoc_company  FOREIGN KEY (company_id)  REFERENCES companies (id),
  CONSTRAINT fk_hrdoc_employee FOREIGN KEY (employee_id) REFERENCES users (id)
) ENGINE=InnoDB COMMENT='Coffre-fort RH : document sensible (toutes categories), une ligne par document logique';

CREATE TABLE hr_document_versions (
  id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
  document_id       INT UNSIGNED NOT NULL,
  version           SMALLINT UNSIGNED NOT NULL,
  storage_key       VARCHAR(255) NOT NULL COMMENT 'Nom de fichier aleatoire dans uploads/',
  file_name         VARCHAR(255) NOT NULL,
  mime_type         VARCHAR(100) NOT NULL DEFAULT 'application/pdf',
  file_size         INT UNSIGNED NOT NULL,
  checksum          CHAR(64)     NOT NULL COMMENT 'SHA-256 du fichier',
  signed_at         DATETIME     NULL,
  signed_by         INT UNSIGNED NULL,
  signature_method  VARCHAR(40)  NULL COMMENT 'Validation RH interne, jamais presentee comme signature qualifiee',
  created_by        INT UNSIGNED NOT NULL,
  created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_hrdocver (document_id, version),
  CONSTRAINT fk_hrdocver_document   FOREIGN KEY (document_id) REFERENCES hr_documents (id),
  CONSTRAINT fk_hrdocver_signed_by  FOREIGN KEY (signed_by)   REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_hrdocver_created_by FOREIGN KEY (created_by)  REFERENCES users (id)
) ENGINE=InnoDB COMMENT='Versions immuables d''un document du coffre-fort : une reedition ajoute une ligne, n''ecrase rien';

CREATE TABLE attestation_requests (
  id                     INT UNSIGNED NOT NULL AUTO_INCREMENT,
  numero                 VARCHAR(30)  NOT NULL COMMENT 'Ex. ATT-WORKMAN-2026-000125',
  company_id             INT UNSIGNED NOT NULL,
  employee_id            INT UNSIGNED NOT NULL,
  requested_by           INT UNSIGNED NOT NULL,
  type                   ENUM('ATTESTATION_TRAVAIL','ATTESTATION_SALAIRE') NOT NULL,
  status                 ENUM('SUBMITTED','IN_REVIEW','GENERATED','APPROVED','READY','REJECTED','CANCELLED') NOT NULL DEFAULT 'SUBMITTED',
  snapshot_nom           VARCHAR(80)  NOT NULL,
  snapshot_prenom        VARCHAR(80)  NOT NULL,
  snapshot_matricule     VARCHAR(20)  NOT NULL,
  snapshot_fonction      VARCHAR(100) NULL,
  snapshot_date_embauche DATE         NULL,
  commentaire            TEXT         NULL,
  document_id            INT UNSIGNED NULL,
  version                SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  rejection_reason       VARCHAR(500) NULL,
  processed_by           INT UNSIGNED NULL,
  processed_at           DATETIME     NULL,
  approved_by            INT UNSIGNED NULL,
  approved_at            DATETIME     NULL,
  date_creation          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  date_maj               DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_attestation_numero (numero),
  KEY idx_attestation_company (company_id),
  KEY idx_attestation_employee (employee_id, date_creation),
  KEY idx_attestation_statut (status),
  CONSTRAINT fk_attestation_company     FOREIGN KEY (company_id)    REFERENCES companies (id),
  CONSTRAINT fk_attestation_employee    FOREIGN KEY (employee_id)   REFERENCES users (id),
  CONSTRAINT fk_attestation_requested_by FOREIGN KEY (requested_by) REFERENCES users (id),
  CONSTRAINT fk_attestation_processed_by FOREIGN KEY (processed_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_attestation_approved_by  FOREIGN KEY (approved_by)  REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_attestation_document     FOREIGN KEY (document_id)  REFERENCES hr_documents (id) ON DELETE SET NULL
) ENGINE=InnoDB;
