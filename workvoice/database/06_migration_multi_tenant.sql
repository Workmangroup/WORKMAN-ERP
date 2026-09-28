-- =====================================================================
--  WORKVOICE — Migration additive : Multi-société (Multi-Tenant)
--  À exécuter UNE FOIS sur une base déjà installée (phpMyAdmin, onglet SQL,
--  ou : mysql nom_de_la_base < 06_migration_multi_tenant.sql).
--  N'efface ni ne modifie aucune donnée existante.
--  (L'API PHP applique aussi cette migration automatiquement au premier
--   appel : voir api-php/lib/schema.php, migrate_v4_multi_tenant(). Ce
--   fichier reste nécessaire pour le backend Node, ou en cas de droits
--   ALTER insuffisants pour l'API.)
--
--  ⚠️ Faire une sauvegarde de la base avant d'exécuter cette migration
--     (phpMyAdmin → Exporter → Format SQL), conformément à la procédure
--     de migration en production.
-- =====================================================================

-- Sélectionne la base cible : adapter le nom si votre base n'est pas
-- « workmagrh » (visible dans le menu de gauche de phpMyAdmin).
USE workmagrh;

-- ---- Table companies + 4 sociétés initiales ----
CREATE TABLE IF NOT EXISTS companies (
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

INSERT IGNORE INTO companies (id, company_code, company_name) VALUES
  (1, 'WORKMAN', 'Workman'),
  (2, 'STID', 'STID Export'),
  (3, 'MBCONF', 'MB Confection'),
  (4, 'SOMICO', 'Somico');

-- ---- users : rôle SYSTEM_ADMIN + company_id (NULL = portée globale) ----
-- Si cette section échoue avec « Duplicate column » : la colonne existe déjà,
-- passez directement à la section suivante.
ALTER TABLE users
  MODIFY COLUMN role ENUM('EMPLOYE','RH','DIRECTION','SYSTEM_ADMIN') NOT NULL DEFAULT 'EMPLOYE',
  ADD COLUMN company_id INT UNSIGNED NULL COMMENT 'NULL = portée globale (SYSTEM_ADMIN / DIRECTION)',
  ADD KEY idx_users_company (company_id),
  ADD CONSTRAINT fk_users_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE RESTRICT;

-- Rattachement par défaut : tous les comptes EMPLOYE/RH déjà existants vers
-- WORKMAN (seule société gérée par l'application avant cette migration),
-- réaffectables ensuite individuellement par un SYSTEM_ADMIN.
UPDATE users SET company_id = 1 WHERE role IN ('EMPLOYE', 'RH') AND company_id IS NULL;

-- ---- Propagation de company_id (dénormalisé depuis l'auteur) ----
ALTER TABLE demandes
  ADD COLUMN company_id INT UNSIGNED NULL COMMENT 'Dénormalisé depuis users.company_id à la création',
  ADD KEY idx_demandes_company (company_id),
  ADD CONSTRAINT fk_demandes_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE RESTRICT;
UPDATE demandes x JOIN users u ON u.id = x.user_id SET x.company_id = u.company_id WHERE x.company_id IS NULL;

ALTER TABLE reclamations
  ADD COLUMN company_id INT UNSIGNED NULL COMMENT 'Dénormalisé depuis users.company_id à la création',
  ADD KEY idx_reclamations_company (company_id),
  ADD CONSTRAINT fk_reclamations_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE RESTRICT;
UPDATE reclamations x JOIN users u ON u.id = x.user_id SET x.company_id = u.company_id WHERE x.company_id IS NULL;

ALTER TABLE suggestions
  ADD COLUMN company_id INT UNSIGNED NULL COMMENT 'Dénormalisé depuis users.company_id à la création',
  ADD KEY idx_suggestions_company (company_id),
  ADD CONSTRAINT fk_suggestions_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE RESTRICT;
UPDATE suggestions x JOIN users u ON u.id = x.user_id SET x.company_id = u.company_id WHERE x.company_id IS NULL;

ALTER TABLE conges_demandes
  ADD COLUMN company_id INT UNSIGNED NULL COMMENT 'Dénormalisé depuis users.company_id à la création',
  ADD KEY idx_conges_company (company_id),
  ADD CONSTRAINT fk_conges_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE RESTRICT;
UPDATE conges_demandes x JOIN users u ON u.id = x.user_id SET x.company_id = u.company_id WHERE x.company_id IS NULL;

ALTER TABLE sorties_demandes
  ADD COLUMN company_id INT UNSIGNED NULL COMMENT 'Dénormalisé depuis users.company_id à la création',
  ADD KEY idx_sorties_company (company_id),
  ADD CONSTRAINT fk_sorties_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE RESTRICT;
UPDATE sorties_demandes x JOIN users u ON u.id = x.user_id SET x.company_id = u.company_id WHERE x.company_id IS NULL;

ALTER TABLE retards_declarations
  ADD COLUMN company_id INT UNSIGNED NULL COMMENT 'Dénormalisé depuis users.company_id à la création',
  ADD KEY idx_retards_company (company_id),
  ADD CONSTRAINT fk_retards_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE RESTRICT;
UPDATE retards_declarations x JOIN users u ON u.id = x.user_id SET x.company_id = u.company_id WHERE x.company_id IS NULL;

ALTER TABLE notifications
  ADD COLUMN company_id INT UNSIGNED NULL COMMENT 'Dénormalisé depuis users.company_id, pour un filtrage RH sans jointure',
  ADD KEY idx_notifications_company (company_id),
  ADD CONSTRAINT fk_notifications_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE RESTRICT;
UPDATE notifications x JOIN users u ON u.id = x.user_id SET x.company_id = u.company_id WHERE x.company_id IS NULL;

-- ---- audit_logs : company_id nullable (une action système n'a pas toujours de user_id) ----
ALTER TABLE audit_logs
  ADD COLUMN company_id INT UNSIGNED NULL COMMENT 'Dénormalisé depuis users.company_id ; NULL sur une action système sans utilisateur',
  ADD KEY idx_audit_company (company_id),
  ADD CONSTRAINT fk_audit_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE SET NULL;
UPDATE audit_logs a JOIN users u ON u.id = a.user_id SET a.company_id = u.company_id WHERE a.company_id IS NULL;

-- ---- Référentiels congés/sorties/retards : company_id préparé mais laissé NULL
--      (= gabarit partagé par toutes les sociétés). La bascule effective vers un
--      paramétrage par société est une étape applicative distincte (écran RH
--      « Paramétrage »), non activée par cette migration. jours_feries reste
--      volontairement global : jours légaux nationaux, identiques pour les 4 sociétés.
ALTER TABLE conges_types
  ADD COLUMN company_id INT UNSIGNED NULL COMMENT 'NULL = gabarit partagé par toutes les sociétés',
  ADD KEY idx_conges_types_company (company_id),
  ADD CONSTRAINT fk_conges_types_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE SET NULL;

ALTER TABLE sorties_motifs
  ADD COLUMN company_id INT UNSIGNED NULL COMMENT 'NULL = gabarit partagé par toutes les sociétés',
  ADD KEY idx_sorties_motifs_company (company_id),
  ADD CONSTRAINT fk_sorties_motifs_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE SET NULL;

ALTER TABLE retards_motifs
  ADD COLUMN company_id INT UNSIGNED NULL COMMENT 'NULL = gabarit partagé par toutes les sociétés',
  ADD KEY idx_retards_motifs_company (company_id),
  ADD CONSTRAINT fk_retards_motifs_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE SET NULL;
