<?php
declare(strict_types=1);

/*
 * Mises à jour automatiques du schéma (idempotentes, additives uniquement).
 * Le dernier numéro appliqué est mémorisé dans uploads/.schema-version pour ne
 * pas interroger information_schema à chaque requête.
 */
const SCHEMA_VERSION = 6;

function table_exists(string $name): bool
{
    return (int) q1(
        'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?',
        [$name],
    )['n'] > 0;
}

function column_exists(string $table, string $column): bool
{
    return (int) q1(
        'SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?',
        [$table, $column],
    )['n'] > 0;
}

function ensure_schema(): void
{
    $flag = __DIR__ . '/../uploads/.schema-version';
    if (is_file($flag) && (int) file_get_contents($flag) >= SCHEMA_VERSION) {
        return;
    }
    try {
        migrate_v2_mdp_temporaire();
        migrate_v3_modules_rh();
        migrate_v4_multi_tenant();
        migrate_v5_admin_seed();
        migrate_v6_attestations();
        @file_put_contents($flag, (string) SCHEMA_VERSION);
    } catch (Throwable $e) {
        // Sans droit ALTER : exécuter database/04_migration_collaborateurs.sql,
        // database/05_migration_modules_rh.sql et database/06_migration_multi_tenant.sql
        // dans phpMyAdmin.
        error_log('[workvoice][schema] ' . $e->getMessage());
    }
}

// ---------------------------------------------------------------- v2 (existant, inchangé)

function migrate_v2_mdp_temporaire(): void
{
    if (!column_exists('users', 'mdp_temporaire')) {
        db()->exec(
            "ALTER TABLE users ADD COLUMN mdp_temporaire TINYINT(1) NOT NULL DEFAULT 0
             COMMENT '1 = mot de passe provisoire à changer à la prochaine connexion' AFTER password",
        );
    }
}

// ---------------------------------------------------------------- v3 : Congés, Sorties, Retards, Fiche enrichie

function migrate_v3_modules_rh(): void
{
    // ---- Module 4 : colonnes ajoutées à users ----
    if (!column_exists('users', 'societe')) {
        db()->exec(
            "ALTER TABLE users
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
               ADD COLUMN solde_conge_actuel DECIMAL(5,1) NOT NULL DEFAULT 0,
               ADD KEY idx_users_manager (manager_id),
               ADD CONSTRAINT fk_users_manager FOREIGN KEY (manager_id) REFERENCES users (id) ON DELETE SET NULL",
        );
    }

    // ---- Module 1 : congés ----
    if (!table_exists('jours_feries')) {
        db()->exec(
            'CREATE TABLE jours_feries (
               id INT UNSIGNED NOT NULL AUTO_INCREMENT, date_ferie DATE NOT NULL, libelle VARCHAR(150) NOT NULL,
               created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
               PRIMARY KEY (id), UNIQUE KEY uq_jours_feries_date (date_ferie)
             ) ENGINE=InnoDB',
        );
    }
    if (!table_exists('conges_types')) {
        db()->exec(
            "CREATE TABLE conges_types (
               id INT UNSIGNED NOT NULL AUTO_INCREMENT, code VARCHAR(30) NOT NULL, libelle VARCHAR(100) NOT NULL,
               deduit_solde TINYINT(1) NOT NULL DEFAULT 1, is_systeme TINYINT(1) NOT NULL DEFAULT 0,
               actif TINYINT(1) NOT NULL DEFAULT 1, ordre SMALLINT UNSIGNED NOT NULL DEFAULT 0,
               PRIMARY KEY (id), UNIQUE KEY uq_conges_types_code (code)
             ) ENGINE=InnoDB",
        );
        db()->exec(
            "INSERT INTO conges_types (id, code, libelle, deduit_solde, is_systeme, ordre) VALUES
               (1,'ANNUEL','Congé annuel',1,1,1), (2,'MALADIE','Congé maladie',0,1,2),
               (3,'EXCEPTIONNEL','Congé exceptionnel',0,1,3), (4,'MATERNITE','Congé maternité',0,1,4),
               (5,'SANS_SOLDE','Congé sans solde',0,1,5)",
        );
    }
    if (!table_exists('conges_demandes')) {
        db()->exec(
            "CREATE TABLE conges_demandes (
               id INT UNSIGNED NOT NULL AUTO_INCREMENT, numero VARCHAR(20) NOT NULL, user_id INT UNSIGNED NOT NULL,
               type_id INT UNSIGNED NOT NULL, date_debut DATE NOT NULL, date_fin DATE NOT NULL, nb_jours DECIMAL(5,1) NOT NULL,
               commentaire TEXT NULL, piece_jointe VARCHAR(255) NULL, piece_jointe_nom VARCHAR(255) NULL, piece_jointe_mime VARCHAR(100) NULL,
               statut ENUM('BROUILLON','EN_ATTENTE','VALIDE','REFUSE','ANNULE') NOT NULL DEFAULT 'EN_ATTENTE',
               motif_refus VARCHAR(500) NULL, traite_par INT UNSIGNED NULL, date_traitement DATETIME NULL,
               date_creation DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, date_maj DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
               PRIMARY KEY (id), UNIQUE KEY uq_conges_demandes_numero (numero),
               KEY idx_conges_user (user_id, date_debut), KEY idx_conges_statut (statut, date_debut), KEY idx_conges_type (type_id),
               CONSTRAINT fk_conges_user FOREIGN KEY (user_id) REFERENCES users (id),
               CONSTRAINT fk_conges_type FOREIGN KEY (type_id) REFERENCES conges_types (id),
               CONSTRAINT fk_conges_traite FOREIGN KEY (traite_par) REFERENCES users (id) ON DELETE SET NULL,
               CONSTRAINT chk_conges_dates CHECK (date_fin >= date_debut)
             ) ENGINE=InnoDB",
        );
    }
    if (!table_exists('conges_mouvements')) {
        db()->exec(
            "CREATE TABLE conges_mouvements (
               id INT UNSIGNED NOT NULL AUTO_INCREMENT, user_id INT UNSIGNED NOT NULL, demande_id INT UNSIGNED NULL,
               type ENUM('INITIAL','AJOUT','DEDUCTION','ANNULATION','AJUSTEMENT') NOT NULL, jours DECIMAL(5,1) NOT NULL,
               solde_apres DECIMAL(6,1) NOT NULL, commentaire VARCHAR(255) NULL, created_by INT UNSIGNED NULL,
               date_creation DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
               PRIMARY KEY (id), KEY idx_mouvements_user (user_id, date_creation),
               CONSTRAINT fk_mouvements_user FOREIGN KEY (user_id) REFERENCES users (id),
               CONSTRAINT fk_mouvements_demande FOREIGN KEY (demande_id) REFERENCES conges_demandes (id) ON DELETE SET NULL,
               CONSTRAINT fk_mouvements_by FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
             ) ENGINE=InnoDB",
        );
    }

    // ---- Module 2 : sorties ----
    if (!table_exists('sorties_motifs')) {
        db()->exec(
            'CREATE TABLE sorties_motifs (
               id INT UNSIGNED NOT NULL AUTO_INCREMENT, libelle VARCHAR(100) NOT NULL, actif TINYINT(1) NOT NULL DEFAULT 1,
               ordre SMALLINT UNSIGNED NOT NULL DEFAULT 0, PRIMARY KEY (id), UNIQUE KEY uq_sorties_motifs_libelle (libelle)
             ) ENGINE=InnoDB',
        );
        db()->exec(
            "INSERT INTO sorties_motifs (id, libelle, ordre) VALUES
               (1,'Rendez-vous médical',1), (2,'Démarche administrative',2), (3,'Mission externe',3),
               (4,'Déplacement professionnel',4), (5,'Urgence familiale',5), (6,'Autre',6)",
        );
    }
    if (!table_exists('sorties_demandes')) {
        db()->exec(
            "CREATE TABLE sorties_demandes (
               id INT UNSIGNED NOT NULL AUTO_INCREMENT, numero VARCHAR(20) NOT NULL, user_id INT UNSIGNED NOT NULL,
               motif_id INT UNSIGNED NOT NULL, date_sortie DATE NOT NULL, heure_debut TIME NOT NULL, heure_fin TIME NOT NULL,
               duree_minutes SMALLINT UNSIGNED NOT NULL, commentaire TEXT NULL,
               statut ENUM('EN_ATTENTE','VALIDE','REFUSE','ANNULE') NOT NULL DEFAULT 'EN_ATTENTE',
               motif_refus VARCHAR(500) NULL, traite_par INT UNSIGNED NULL, date_traitement DATETIME NULL,
               date_creation DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, date_maj DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
               PRIMARY KEY (id), UNIQUE KEY uq_sorties_numero (numero),
               KEY idx_sorties_user (user_id, date_sortie), KEY idx_sorties_statut (statut, date_sortie),
               CONSTRAINT fk_sorties_user FOREIGN KEY (user_id) REFERENCES users (id),
               CONSTRAINT fk_sorties_motif FOREIGN KEY (motif_id) REFERENCES sorties_motifs (id),
               CONSTRAINT fk_sorties_traite FOREIGN KEY (traite_par) REFERENCES users (id) ON DELETE SET NULL,
               CONSTRAINT chk_sorties_heures CHECK (heure_fin > heure_debut)
             ) ENGINE=InnoDB",
        );
    }

    // ---- Module 3 : retards ----
    if (!table_exists('retards_motifs')) {
        db()->exec(
            'CREATE TABLE retards_motifs (
               id INT UNSIGNED NOT NULL AUTO_INCREMENT, libelle VARCHAR(100) NOT NULL, actif TINYINT(1) NOT NULL DEFAULT 1,
               ordre SMALLINT UNSIGNED NOT NULL DEFAULT 0, PRIMARY KEY (id), UNIQUE KEY uq_retards_motifs_libelle (libelle)
             ) ENGINE=InnoDB',
        );
        db()->exec(
            "INSERT INTO retards_motifs (id, libelle, ordre) VALUES
               (1,'Embouteillage',1), (2,'Transport public',2), (3,'Problème véhicule',3), (4,'Rendez-vous médical',4),
               (5,'Urgence familiale',5), (6,'Intempéries',6), (7,'Autre',7)",
        );
    }
    if (!table_exists('retards_declarations')) {
        db()->exec(
            "CREATE TABLE retards_declarations (
               id INT UNSIGNED NOT NULL AUTO_INCREMENT, numero VARCHAR(20) NOT NULL, user_id INT UNSIGNED NOT NULL,
               date_retard DATE NOT NULL, heure_arrivee TIME NOT NULL, motif_id INT UNSIGNED NOT NULL, commentaire TEXT NULL,
               piece_jointe VARCHAR(255) NULL, piece_jointe_nom VARCHAR(255) NULL, piece_jointe_mime VARCHAR(100) NULL,
               statut ENUM('EN_ATTENTE','VALIDE','REFUSE','ANNULE') NOT NULL DEFAULT 'EN_ATTENTE',
               motif_refus VARCHAR(500) NULL, traite_par INT UNSIGNED NULL, date_traitement DATETIME NULL,
               date_creation DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, date_maj DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
               PRIMARY KEY (id), UNIQUE KEY uq_retards_numero (numero),
               KEY idx_retards_user (user_id, date_retard), KEY idx_retards_statut (statut, date_retard),
               CONSTRAINT fk_retards_user FOREIGN KEY (user_id) REFERENCES users (id),
               CONSTRAINT fk_retards_motif FOREIGN KEY (motif_id) REFERENCES retards_motifs (id),
               CONSTRAINT fk_retards_traite FOREIGN KEY (traite_par) REFERENCES users (id) ON DELETE SET NULL
             ) ENGINE=InnoDB",
        );
    }
}

// ---------------------------------------------------------------- v4 : Multi-société (Multi-Tenant)

function migrate_v4_multi_tenant(): void
{
    // ---- Table companies + 4 sociétés initiales ----
    if (!table_exists('companies')) {
        db()->exec(
            "CREATE TABLE companies (
               id INT UNSIGNED NOT NULL AUTO_INCREMENT,
               company_code VARCHAR(20) NOT NULL,
               company_name VARCHAR(120) NOT NULL,
               legal_name VARCHAR(180) NULL,
               address VARCHAR(255) NULL,
               city VARCHAR(80) NULL,
               country VARCHAR(80) NOT NULL DEFAULT 'Tunisie',
               phone VARCHAR(30) NULL,
               email VARCHAR(150) NULL,
               tax_number VARCHAR(40) NULL,
               logo VARCHAR(255) NULL,
               status ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
               settings JSON NULL COMMENT 'Paramètres par société (jours travaillés, congés par défaut, etc.)',
               created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
               updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
               deleted_at DATETIME NULL COMMENT 'Réservé : les sociétés se désactivent via status, ne se suppriment jamais physiquement',
               PRIMARY KEY (id),
               UNIQUE KEY uq_companies_code (company_code)
             ) ENGINE=InnoDB",
        );
        db()->exec(
            "INSERT INTO companies (id, company_code, company_name) VALUES
               (1, 'WORKMAN', 'Workman'),
               (2, 'STID', 'STID Export'),
               (3, 'MBCONF', 'MB Confection'),
               (4, 'SOMICO', 'Somico')",
        );
    }

    // ---- users : rôle SYSTEM_ADMIN (ajout d'une valeur ENUM, aucune donnée existante
    //      affectée) + company_id (NULL = portée globale, réservé SYSTEM_ADMIN/DIRECTION) ----
    if (!column_exists('users', 'company_id')) {
        db()->exec(
            "ALTER TABLE users
               MODIFY COLUMN role ENUM('EMPLOYE','RH','DIRECTION','SYSTEM_ADMIN') NOT NULL DEFAULT 'EMPLOYE',
               ADD COLUMN company_id INT UNSIGNED NULL COMMENT 'NULL = portée globale (SYSTEM_ADMIN / DIRECTION)',
               ADD KEY idx_users_company (company_id),
               ADD CONSTRAINT fk_users_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE RESTRICT",
        );
        // Rattachement par défaut : tous les comptes EMPLOYE/RH déjà existants vers WORKMAN
        // (seule société gérée par l'application avant cette migration), réaffectables
        // ensuite individuellement par un SYSTEM_ADMIN sans risque (simple mise à jour).
        db()->exec("UPDATE users SET company_id = 1 WHERE role IN ('EMPLOYE', 'RH') AND company_id IS NULL");
    }

    // ---- Propagation de company_id (dénormalisé depuis l'auteur) sur les tables métier ----
    foreach (['demandes', 'reclamations', 'suggestions', 'conges_demandes', 'sorties_demandes', 'retards_declarations', 'notifications'] as $t) {
        if (!column_exists($t, 'company_id')) {
            db()->exec(
                "ALTER TABLE $t
                   ADD COLUMN company_id INT UNSIGNED NULL,
                   ADD KEY idx_{$t}_company (company_id),
                   ADD CONSTRAINT fk_{$t}_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE RESTRICT",
            );
            db()->exec("UPDATE $t x JOIN users u ON u.id = x.user_id SET x.company_id = u.company_id WHERE x.company_id IS NULL");
        }
    }

    // ---- audit_logs : company_id nullable (une action système n'a pas toujours de user_id) ----
    if (!column_exists('audit_logs', 'company_id')) {
        db()->exec(
            "ALTER TABLE audit_logs
               ADD COLUMN company_id INT UNSIGNED NULL,
               ADD KEY idx_audit_company (company_id),
               ADD CONSTRAINT fk_audit_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE SET NULL",
        );
        db()->exec('UPDATE audit_logs a JOIN users u ON u.id = a.user_id SET a.company_id = u.company_id WHERE a.company_id IS NULL');
    }

    // ---- Référentiels congés/sorties/retards : company_id préparé mais laissé NULL
    //      (= gabarit partagé par toutes les sociétés). La bascule effective vers un
    //      paramétrage par société est une étape applicative distincte (écran RH
    //      « Paramétrage »), non activée par cette migration. jours_feries reste
    //      volontairement global : jours légaux nationaux, identiques pour les 4 sociétés.
    foreach (['conges_types', 'sorties_motifs', 'retards_motifs'] as $t) {
        if (!column_exists($t, 'company_id')) {
            db()->exec(
                "ALTER TABLE $t
                   ADD COLUMN company_id INT UNSIGNED NULL COMMENT 'NULL = gabarit partagé par toutes les sociétés',
                   ADD KEY idx_{$t}_company (company_id),
                   ADD CONSTRAINT fk_{$t}_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE SET NULL",
            );
        }
    }
}

// ---------------------------------------------------------------- v5 : premier compte SYSTEM_ADMIN

/** Mot de passe provisoire aléatoire, généré à l'exécution (jamais écrit en dur). */
function generate_temp_password(): string
{
    $upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    $lower = 'abcdefghijkmnpqrstuvwxyz';
    $digits = '23456789';
    $all = $upper . $lower . $digits;
    $chars = [$upper[random_int(0, 23)], $lower[random_int(0, 23)], $digits[random_int(0, 7)]];
    for ($i = 0; $i < 9; $i++) {
        $chars[] = $all[random_int(0, strlen($all) - 1)];
    }
    for ($i = count($chars) - 1; $i > 0; $i--) {
        $j = random_int(0, $i);
        [$chars[$i], $chars[$j]] = [$chars[$j], $chars[$i]];
    }
    return implode('', $chars);
}

function migrate_v5_admin_seed(): void
{
    // Aucun SYSTEM_ADMIN n'existe encore : en crée un premier, mot de passe provisoire
    // aléatoire (changement obligatoire à la première connexion, même politique que tout
    // compte créé par le RH). Portée globale : company_id volontairement NULL.
    $exists = (int) q1("SELECT COUNT(*) AS n FROM users WHERE role = 'SYSTEM_ADMIN'")['n'];
    if ($exists > 0) {
        return;
    }
    $password = generate_temp_password();
    run(
        "INSERT INTO users (matricule, nom, prenom, service, departement, site, role, company_id, password, mdp_temporaire, actif)
         VALUES ('ADMIN01', 'Système', 'Administrateur', 'Direction Générale', 'Administration', 'Siège', 'SYSTEM_ADMIN', NULL, ?, 1, 1)",
        [password_hash($password, PASSWORD_BCRYPT, ['cost' => 12])],
    );
    // Déposé une seule fois dans le dossier uploads (déjà protégé par .htaccess : Deny all),
    // jamais renvoyé par l'API, jamais journalisé : à récupérer par FTP puis à supprimer.
    @file_put_contents(__DIR__ . '/../uploads/.admin-first-login', "matricule: ADMIN01\nmot_de_passe_provisoire: $password\n");
}

// ---------------------------------------------------------------- v6 : Attestations RH + Coffre-Fort (fondation)

function migrate_v6_attestations(): void
{
    if (!table_exists('hr_documents')) {
        db()->exec(
            "CREATE TABLE hr_documents (
               id INT UNSIGNED NOT NULL AUTO_INCREMENT,
               company_id INT UNSIGNED NOT NULL,
               employee_id INT UNSIGNED NOT NULL,
               category ENUM('ATTESTATION_TRAVAIL','ATTESTATION_SALAIRE','CONTRAT','BULLETIN_PAIE','AVERTISSEMENT','DECISION_RH','AUTRE_DOCUMENT_SENSIBLE') NOT NULL,
               document_number VARCHAR(30) NULL,
               current_version SMALLINT UNSIGNED NOT NULL DEFAULT 1,
               status ENUM('ACTIVE','CANCELLED') NOT NULL DEFAULT 'ACTIVE',
               uploaded_by INT UNSIGNED NOT NULL,
               created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
               updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
               PRIMARY KEY (id),
               KEY idx_hrdoc_company (company_id),
               KEY idx_hrdoc_employee (employee_id, category),
               CONSTRAINT fk_hrdoc_company FOREIGN KEY (company_id) REFERENCES companies (id),
               CONSTRAINT fk_hrdoc_employee FOREIGN KEY (employee_id) REFERENCES users (id)
             ) ENGINE=InnoDB",
        );
    }

    if (!table_exists('hr_document_versions')) {
        db()->exec(
            "CREATE TABLE hr_document_versions (
               id INT UNSIGNED NOT NULL AUTO_INCREMENT,
               document_id INT UNSIGNED NOT NULL,
               version SMALLINT UNSIGNED NOT NULL,
               storage_key VARCHAR(255) NOT NULL,
               file_name VARCHAR(255) NOT NULL,
               mime_type VARCHAR(100) NOT NULL DEFAULT 'application/pdf',
               file_size INT UNSIGNED NOT NULL,
               checksum CHAR(64) NOT NULL,
               signed_at DATETIME NULL,
               signed_by INT UNSIGNED NULL,
               signature_method VARCHAR(40) NULL,
               created_by INT UNSIGNED NOT NULL,
               created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
               PRIMARY KEY (id),
               UNIQUE KEY uq_hrdocver (document_id, version),
               CONSTRAINT fk_hrdocver_document FOREIGN KEY (document_id) REFERENCES hr_documents (id),
               CONSTRAINT fk_hrdocver_signed_by FOREIGN KEY (signed_by) REFERENCES users (id) ON DELETE SET NULL,
               CONSTRAINT fk_hrdocver_created_by FOREIGN KEY (created_by) REFERENCES users (id)
             ) ENGINE=InnoDB",
        );
    }

    if (!table_exists('attestation_requests')) {
        db()->exec(
            "CREATE TABLE attestation_requests (
               id INT UNSIGNED NOT NULL AUTO_INCREMENT,
               numero VARCHAR(30) NOT NULL,
               company_id INT UNSIGNED NOT NULL,
               employee_id INT UNSIGNED NOT NULL,
               requested_by INT UNSIGNED NOT NULL,
               type ENUM('ATTESTATION_TRAVAIL','ATTESTATION_SALAIRE') NOT NULL,
               status ENUM('SUBMITTED','IN_REVIEW','GENERATED','APPROVED','READY','REJECTED','CANCELLED') NOT NULL DEFAULT 'SUBMITTED',
               snapshot_nom VARCHAR(80) NOT NULL,
               snapshot_prenom VARCHAR(80) NOT NULL,
               snapshot_matricule VARCHAR(20) NOT NULL,
               snapshot_fonction VARCHAR(100) NULL,
               snapshot_date_embauche DATE NULL,
               commentaire TEXT NULL,
               document_id INT UNSIGNED NULL,
               version SMALLINT UNSIGNED NOT NULL DEFAULT 1,
               rejection_reason VARCHAR(500) NULL,
               processed_by INT UNSIGNED NULL,
               processed_at DATETIME NULL,
               approved_by INT UNSIGNED NULL,
               approved_at DATETIME NULL,
               date_creation DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
               date_maj DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
               PRIMARY KEY (id),
               UNIQUE KEY uq_attestation_numero (numero),
               KEY idx_attestation_company (company_id),
               KEY idx_attestation_employee (employee_id, date_creation),
               KEY idx_attestation_statut (status),
               CONSTRAINT fk_attestation_company FOREIGN KEY (company_id) REFERENCES companies (id),
               CONSTRAINT fk_attestation_employee FOREIGN KEY (employee_id) REFERENCES users (id),
               CONSTRAINT fk_attestation_requested_by FOREIGN KEY (requested_by) REFERENCES users (id),
               CONSTRAINT fk_attestation_processed_by FOREIGN KEY (processed_by) REFERENCES users (id) ON DELETE SET NULL,
               CONSTRAINT fk_attestation_approved_by FOREIGN KEY (approved_by) REFERENCES users (id) ON DELETE SET NULL,
               CONSTRAINT fk_attestation_document FOREIGN KEY (document_id) REFERENCES hr_documents (id) ON DELETE SET NULL
             ) ENGINE=InnoDB",
        );
    }
}
