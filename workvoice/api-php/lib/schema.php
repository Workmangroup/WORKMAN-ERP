<?php
declare(strict_types=1);

/*
 * Mises à jour automatiques du schéma (idempotentes).
 * Le dernier numéro appliqué est mémorisé dans uploads/.schema-version pour ne
 * pas interroger information_schema à chaque requête.
 */
const SCHEMA_VERSION = 2;

function ensure_schema(): void
{
    $flag = __DIR__ . '/../uploads/.schema-version';
    if (is_file($flag) && (int) file_get_contents($flag) >= SCHEMA_VERSION) {
        return;
    }
    try {
        // v2 : mot de passe provisoire (gestion des collaborateurs par le RH)
        $exists = q1(
            "SELECT COUNT(*) AS n FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'mdp_temporaire'",
        );
        if ((int) $exists['n'] === 0) {
            db()->exec(
                "ALTER TABLE users ADD COLUMN mdp_temporaire TINYINT(1) NOT NULL DEFAULT 0
                 COMMENT '1 = mot de passe provisoire à changer à la prochaine connexion' AFTER password",
            );
        }
        @file_put_contents($flag, (string) SCHEMA_VERSION);
    } catch (Throwable $e) {
        // Sans droit ALTER : exécuter database/04_migration_collaborateurs.sql dans phpMyAdmin
        error_log('[workvoice][schema] ' . $e->getMessage());
    }
}
