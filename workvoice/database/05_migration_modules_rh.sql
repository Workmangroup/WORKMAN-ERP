-- =====================================================================
--  WORKVOICE — Migration additive : Congés, Sorties, Retards, Fiche enrichie
--  À exécuter UNE FOIS sur une base déjà installée (phpMyAdmin, onglet SQL,
--  ou : mysql nom_de_la_base < 05_migration_modules_rh.sql).
--  N'efface ni ne modifie aucune donnée existante.
--  (L'API PHP applique aussi cette migration automatiquement au premier
--   appel : voir api-php/lib/schema.php. Ce fichier reste nécessaire pour
--   le backend Node, ou en cas de droits ALTER insuffisants pour l'API.)
-- =====================================================================

-- Sélectionne la base cible : adapter le nom si votre base n'est pas
-- « workmagrh » (visible dans le menu de gauche de phpMyAdmin).
USE workmagrh;

-- ---- Module 4 : fiche collaborateur enrichie (colonnes ajoutées à users) ----
ALTER TABLE users
  ADD COLUMN societe VARCHAR(80) NULL COMMENT 'Entité juridique (ex. MB Confection, STID Export)',
  ADD COLUMN fonction VARCHAR(100) NULL,
  ADD COLUMN manager_id INT UNSIGNED NULL,
  ADD COLUMN matricule_paie VARCHAR(20) NULL,
  ADD COLUMN date_naissance DATE NULL,
  ADD COLUMN adresse VARCHAR(255) NULL,
  ADD COLUMN cin VARCHAR(20) NULL,
  ADD COLUMN cin_date_delivrance DATE NULL,
  ADD COLUMN cnss VARCHAR(30) NULL,
  ADD COLUMN date_embauche DATE NULL,
  ADD COLUMN date_fin_contrat DATE NULL,
  ADD COLUMN type_contrat ENUM('CDI','CDD','SIVP','STAGE','INTERIM','AUTRE') NULL,
  ADD COLUMN salaire_base DECIMAL(10,2) NULL,
  ADD COLUMN prime DECIMAL(10,2) NULL,
  ADD COLUMN indemnite DECIMAL(10,2) NULL,
  ADD COLUMN observations_rh TEXT NULL,
  ADD COLUMN solde_conge_initial DECIMAL(5,1) NOT NULL DEFAULT 0,
  ADD COLUMN solde_conge_actuel DECIMAL(5,1) NOT NULL DEFAULT 0;

ALTER TABLE users
  ADD KEY idx_users_manager (manager_id),
  ADD CONSTRAINT fk_users_manager FOREIGN KEY (manager_id) REFERENCES users (id) ON DELETE SET NULL;

-- ---- Module 1 : gestion des congés ----
CREATE TABLE jours_feries (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  date_ferie   DATE         NOT NULL,
  libelle      VARCHAR(150) NOT NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_jours_feries_date (date_ferie)
) ENGINE=InnoDB;

CREATE TABLE conges_types (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  code          VARCHAR(30)  NOT NULL,
  libelle       VARCHAR(100) NOT NULL,
  deduit_solde  TINYINT(1)   NOT NULL DEFAULT 1,
  is_systeme    TINYINT(1)   NOT NULL DEFAULT 0,
  actif         TINYINT(1)   NOT NULL DEFAULT 1,
  ordre         SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_conges_types_code (code)
) ENGINE=InnoDB;

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
  type_id            INT UNSIGNED NOT NULL,
  date_debut         DATE         NOT NULL,
  date_fin           DATE         NOT NULL,
  nb_jours           DECIMAL(5,1) NOT NULL,
  commentaire        TEXT         NULL,
  piece_jointe       VARCHAR(255) NULL,
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
  CONSTRAINT fk_conges_user   FOREIGN KEY (user_id)  REFERENCES users (id),
  CONSTRAINT fk_conges_type   FOREIGN KEY (type_id)  REFERENCES conges_types (id),
  CONSTRAINT fk_conges_traite FOREIGN KEY (traite_par) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT chk_conges_dates CHECK (date_fin >= date_debut)
) ENGINE=InnoDB;

CREATE TABLE conges_mouvements (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id        INT UNSIGNED NOT NULL,
  demande_id     INT UNSIGNED NULL,
  type           ENUM('INITIAL','AJOUT','DEDUCTION','ANNULATION','AJUSTEMENT') NOT NULL,
  jours          DECIMAL(5,1) NOT NULL,
  solde_apres    DECIMAL(6,1) NOT NULL,
  commentaire    VARCHAR(255) NULL,
  created_by     INT UNSIGNED NULL,
  date_creation  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_mouvements_user (user_id, date_creation),
  CONSTRAINT fk_mouvements_user    FOREIGN KEY (user_id)    REFERENCES users (id),
  CONSTRAINT fk_mouvements_demande FOREIGN KEY (demande_id) REFERENCES conges_demandes (id) ON DELETE SET NULL,
  CONSTRAINT fk_mouvements_by      FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- ---- Module 2 : autorisations de sortie ----
CREATE TABLE sorties_motifs (
  id       INT UNSIGNED NOT NULL AUTO_INCREMENT,
  libelle  VARCHAR(100) NOT NULL,
  actif    TINYINT(1)   NOT NULL DEFAULT 1,
  ordre    SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sorties_motifs_libelle (libelle)
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
  CONSTRAINT fk_sorties_user   FOREIGN KEY (user_id)  REFERENCES users (id),
  CONSTRAINT fk_sorties_motif  FOREIGN KEY (motif_id) REFERENCES sorties_motifs (id),
  CONSTRAINT fk_sorties_traite FOREIGN KEY (traite_par) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT chk_sorties_heures CHECK (heure_fin > heure_debut)
) ENGINE=InnoDB;

-- ---- Module 3 : déclaration des retards ----
CREATE TABLE retards_motifs (
  id       INT UNSIGNED NOT NULL AUTO_INCREMENT,
  libelle  VARCHAR(100) NOT NULL,
  actif    TINYINT(1)   NOT NULL DEFAULT 1,
  ordre    SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_retards_motifs_libelle (libelle)
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
  CONSTRAINT fk_retards_user   FOREIGN KEY (user_id)  REFERENCES users (id),
  CONSTRAINT fk_retards_motif  FOREIGN KEY (motif_id) REFERENCES retards_motifs (id),
  CONSTRAINT fk_retards_traite FOREIGN KEY (traite_par) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB;
