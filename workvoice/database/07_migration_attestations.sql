-- =====================================================================
--  WORKVOICE — Migration additive : Attestations RH + Coffre-Fort (fondation)
--  À exécuter UNE FOIS sur une base déjà installée (phpMyAdmin, onglet SQL,
--  ou : mysql nom_de_la_base < 07_migration_attestations.sql).
--  N'efface ni ne modifie aucune donnée existante.
--  (L'API PHP applique aussi cette migration automatiquement au premier
--   appel : voir api-php/lib/schema.php, migrate_v6_attestations(). Ce
--   fichier reste nécessaire pour le backend Node, ou en cas de droits
--   ALTER/CREATE insuffisants pour l'API.)
-- =====================================================================

-- Sélectionne la base cible : adapter le nom si votre base n'est pas
-- « workmagrh » (visible dans le menu de gauche de phpMyAdmin).
USE workmagrh;

CREATE TABLE IF NOT EXISTS hr_documents (
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
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS hr_document_versions (
  id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
  document_id       INT UNSIGNED NOT NULL,
  version           SMALLINT UNSIGNED NOT NULL,
  storage_key       VARCHAR(255) NOT NULL,
  file_name         VARCHAR(255) NOT NULL,
  mime_type         VARCHAR(100) NOT NULL DEFAULT 'application/pdf',
  file_size         INT UNSIGNED NOT NULL,
  checksum          CHAR(64)     NOT NULL,
  signed_at         DATETIME     NULL,
  signed_by         INT UNSIGNED NULL,
  signature_method  VARCHAR(40)  NULL,
  created_by        INT UNSIGNED NOT NULL,
  created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_hrdocver (document_id, version),
  CONSTRAINT fk_hrdocver_document   FOREIGN KEY (document_id) REFERENCES hr_documents (id),
  CONSTRAINT fk_hrdocver_signed_by  FOREIGN KEY (signed_by)   REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_hrdocver_created_by FOREIGN KEY (created_by)  REFERENCES users (id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS attestation_requests (
  id                     INT UNSIGNED NOT NULL AUTO_INCREMENT,
  numero                 VARCHAR(30)  NOT NULL,
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
  CONSTRAINT fk_attestation_company      FOREIGN KEY (company_id)    REFERENCES companies (id),
  CONSTRAINT fk_attestation_employee     FOREIGN KEY (employee_id)   REFERENCES users (id),
  CONSTRAINT fk_attestation_requested_by FOREIGN KEY (requested_by)  REFERENCES users (id),
  CONSTRAINT fk_attestation_processed_by FOREIGN KEY (processed_by)  REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_attestation_approved_by  FOREIGN KEY (approved_by)   REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_attestation_document     FOREIGN KEY (document_id)   REFERENCES hr_documents (id) ON DELETE SET NULL
) ENGINE=InnoDB;
