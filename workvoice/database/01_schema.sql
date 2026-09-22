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
SET FOREIGN_KEY_CHECKS = 1;

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
  role                ENUM('EMPLOYE','RH','DIRECTION') NOT NULL DEFAULT 'EMPLOYE',
  password            VARCHAR(255)  NOT NULL COMMENT 'Hash bcrypt',
  mdp_temporaire      TINYINT(1)    NOT NULL DEFAULT 0 COMMENT '1 = mot de passe provisoire à changer à la prochaine connexion',
  actif               TINYINT(1)    NOT NULL DEFAULT 1,
  derniere_connexion  DATETIME      NULL,
  created_at          DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_matricule (matricule),
  UNIQUE KEY uq_users_email (email),
  KEY idx_users_role (role, actif),
  KEY idx_users_orga (departement, service, site)
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
  CONSTRAINT fk_demandes_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
--  RECLAMATIONS
-- ---------------------------------------------------------------------
CREATE TABLE reclamations (
  id                  INT UNSIGNED NOT NULL AUTO_INCREMENT,
  numero_reclamation  VARCHAR(20)  NOT NULL,
  user_id             INT UNSIGNED NOT NULL,
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
  CONSTRAINT fk_reclamations_user FOREIGN KEY (user_id) REFERENCES users (id),
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
  CONSTRAINT fk_suggestions_user FOREIGN KEY (user_id) REFERENCES users (id)
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
  type           VARCHAR(40)  NOT NULL,
  titre          VARCHAR(150) NOT NULL,
  message        VARCHAR(500) NOT NULL,
  lien           VARCHAR(255) NULL,
  lu             TINYINT(1)   NOT NULL DEFAULT 0,
  date_creation  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_notifications_user (user_id, lu, date_creation),
  CONSTRAINT fk_notifications_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
--  AUDIT LOGS — journalisation des actions
-- ---------------------------------------------------------------------
CREATE TABLE audit_logs (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id        INT UNSIGNED    NULL,
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
  CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL
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
