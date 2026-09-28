# ARCHITECTURE_ATTESTATIONS_COFFRE_FORT.md

**Phase 1 — Architecture (décisions verrouillées).** Suite à [AUDIT_ATTESTATIONS_COFFRE_FORT_CEO.md](AUDIT_ATTESTATIONS_COFFRE_FORT_CEO.md). Couvre le Module 1 (Attestations), construit en premier, et la fondation partagée avec le Module 2 (Coffre-Fort).

## 1. Machine à états — `attestation_requests.status`

```
DRAFT → SUBMITTED → IN_REVIEW → GENERATED → APPROVED → READY
                 ↘ REJECTED          ↘ CANCELLED (depuis n'importe quel état non terminal)
```

En pratique, la création collaborateur passe directement à `SUBMITTED` (pas d'étape `DRAFT` exposée côté UI — réservée à un usage futur type brouillon RH). Transitions autorisées, contrôlées côté serveur uniquement (jamais par le champ envoyé par le client) :

| Transition | Déclenchée par | Route |
|---|---|---|
| `SUBMITTED → IN_REVIEW` | RH ouvre la demande | implicite à la 1ère action RH |
| `IN_REVIEW → GENERATED` | RH génère le PDF | `POST /rh/attestations/{id}/generer` |
| `GENERATED → APPROVED` | RH valide | `POST /rh/attestations/{id}/approuver` |
| `APPROVED → READY` | RH signe (ou valide sans signature si non requise) | `POST /rh/attestations/{id}/signer` |
| `* → REJECTED` | RH refuse (motif obligatoire) | `POST /rh/attestations/{id}/refuser` |
| `* → CANCELLED` (sauf READY) | RH annule (motif obligatoire) | `POST /rh/attestations/{id}/annuler` |
| `READY → READY` (nouvelle version) | RH réédite | `POST /rh/attestations/{id}/reediter` |

## 2. Schéma de données

```sql
CREATE TABLE attestation_requests (
  id                 INT UNSIGNED NOT NULL AUTO_INCREMENT,
  numero             VARCHAR(30)  NOT NULL,           -- ATT-WORKMAN-2026-000125
  company_id         INT UNSIGNED NOT NULL,
  employee_id        INT UNSIGNED NOT NULL,
  requested_by       INT UNSIGNED NOT NULL,           -- = employee_id sauf si créée par RH pour un tiers
  type               ENUM('ATTESTATION_TRAVAIL','ATTESTATION_SALAIRE') NOT NULL,
  status             ENUM('SUBMITTED','IN_REVIEW','GENERATED','APPROVED','READY','REJECTED','CANCELLED') NOT NULL DEFAULT 'SUBMITTED',
  -- Snapshot immuable au moment de la demande (jamais recalculé, jamais fourni par le frontend comme source de vérité)
  snapshot_nom       VARCHAR(80)  NOT NULL,
  snapshot_prenom    VARCHAR(80)  NOT NULL,
  snapshot_matricule VARCHAR(20)  NOT NULL,
  snapshot_fonction  VARCHAR(100) NULL,
  snapshot_date_embauche DATE     NULL,
  commentaire        TEXT         NULL,               -- note libre du collaborateur (motif de la demande)
  document_id        INT UNSIGNED NULL,                -- -> hr_documents.id une fois généré
  version             SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  rejection_reason    VARCHAR(500) NULL,
  processed_by        INT UNSIGNED NULL,
  processed_at         DATETIME NULL,
  approved_by          INT UNSIGNED NULL,
  approved_at           DATETIME NULL,
  date_creation         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  date_maj              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id), UNIQUE KEY uq_attestation_numero (numero),
  KEY idx_attestation_company (company_id), KEY idx_attestation_employee (employee_id, date_creation),
  KEY idx_attestation_statut (status),
  CONSTRAINT fk_attestation_company  FOREIGN KEY (company_id)   REFERENCES companies (id),
  CONSTRAINT fk_attestation_employee FOREIGN KEY (employee_id)  REFERENCES users (id),
  CONSTRAINT fk_attestation_document FOREIGN KEY (document_id)  REFERENCES hr_documents (id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE hr_documents (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id     INT UNSIGNED NOT NULL,
  employee_id    INT UNSIGNED NOT NULL,
  category       ENUM('ATTESTATION_TRAVAIL','ATTESTATION_SALAIRE','CONTRAT','BULLETIN_PAIE','AVERTISSEMENT','DECISION_RH','AUTRE_DOCUMENT_SENSIBLE') NOT NULL,
  document_number VARCHAR(30) NULL,                    -- = numero de l'attestation si applicable
  current_version SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  status          ENUM('ACTIVE','CANCELLED') NOT NULL DEFAULT 'ACTIVE',
  uploaded_by     INT UNSIGNED NOT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id), KEY idx_hrdoc_company (company_id), KEY idx_hrdoc_employee (employee_id, category),
  CONSTRAINT fk_hrdoc_company  FOREIGN KEY (company_id)  REFERENCES companies (id),
  CONSTRAINT fk_hrdoc_employee FOREIGN KEY (employee_id) REFERENCES users (id)
) ENGINE=InnoDB;

CREATE TABLE hr_document_versions (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  document_id    INT UNSIGNED NOT NULL,
  version        SMALLINT UNSIGNED NOT NULL,
  storage_key    VARCHAR(255) NOT NULL,                -- nom de fichier aléatoire dans uploads/
  file_name      VARCHAR(255) NOT NULL,
  mime_type      VARCHAR(100) NOT NULL DEFAULT 'application/pdf',
  file_size      INT UNSIGNED NOT NULL,
  checksum       CHAR(64) NOT NULL,                    -- SHA-256, intégrité du fichier
  signed_at      DATETIME NULL,
  signed_by      INT UNSIGNED NULL,
  signature_method VARCHAR(40) NULL,                   -- ex. 'RH_INTERNE' — jamais présenté comme qualifié
  created_by     INT UNSIGNED NOT NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id), UNIQUE KEY uq_hrdocver (document_id, version),
  CONSTRAINT fk_hrdocver_document FOREIGN KEY (document_id) REFERENCES hr_documents (id)
) ENGINE=InnoDB;
```

Numérotation : `next_numero($pdo, 'ATT' . $companyId)` — réutilise `sequences` telle quelle (un préfixe par société évite toute collision et garde des séquences lisibles par société), formatée ensuite en `ATT-{CODE_SOCIETE}-{ANNEE}-{N}`.

## 3. Stockage et téléchargement — la règle qui ne doit jamais être enfreinte

```php
/** Jamais l'auteur, quelle que soit la situation. */
function can_download_hr_document(array $user, array $doc): bool
{
    if (!in_array($user['role'], [ROLE_RH, ROLE_SYSTEM_ADMIN], true)) {
        return false;
    }
    if ($user['role'] === ROLE_RH && (int) $user['company_id'] !== (int) $doc['company_id']) {
        return false; // IDOR inter-société
    }
    return true;
}
```

Toute route de téléchargement de document RH sensible appelle cette fonction avant `readfile()`, et journalise systématiquement (succès **et** refus) dans `audit_logs` avec l'action `ACCESS_DENIED` en cas de refus. Fichiers stockés dans `api-php/uploads/` (déjà protégé par `.htaccess`), noms aléatoires, jamais servis par URL directe — pattern déjà en place, réutilisé sans modification.

## 4. Génération PDF — `lib/pdf.php`

Écrivain PDF minimal (objets PDF 1.4 bruts : catalogue, pages, police standard Helvetica non embarquée, texte positionné, lignes). Zéro dépendance externe, ~150 lignes, auditable intégralement. Capacités : page A4, en-tête (nom société, raison sociale, adresse — depuis `companies`), corps de texte, numéro de document, date, pied de page. **Pas d'image/logo embarqué dans cette première version** (limitation connue, documentée) : ajout possible ultérieurement si besoin réel, soit à la main (XObject image), soit via une librairie tierce **avec votre accord explicite avant tout téléchargement de dépendance**.

## 5. Notifications

Réutilise `notify_users()` (déjà company-aware au niveau table). Contenu strictement conforme à §26 du cahier des charges : jamais de lien vers le PDF, jamais de pièce jointe. Exemple :

```php
notify_users([$demande['employee_id']], [
  'type' => 'ATTESTATION_PRETE',
  'titre' => "Attestation {$demande['numero']} prête",
  'message' => 'Votre attestation est prête. Merci de vous présenter au service RH pour récupération.',
  'lien' => '/employe/attestations/',   // renvoie vers la liste des statuts, jamais vers un fichier
]);
```

## 6. Frontend

- `employe/attestations/` : formulaire (type + commentaire uniquement — nom/matricule/société/poste affichés en lecture seule depuis `/auth/me`), liste des demandes avec statut. Pour `READY` : uniquement le message de retrait, **aucun bouton** télécharger/voir/imprimer/envoyer n'existe dans le DOM (pas seulement masqué en CSS — absent du rendu).
- `rh/attestations/` : file RH avec filtres (société pour SYSTEM_ADMIN, département, collaborateur, statut, type), actions du workflow, historique des versions.

## 7. Ce qui est explicitement hors périmètre de cette livraison

- Écran de navigation du Coffre-Fort par catégorie (upload libre de contrats/bulletins/avertissements) — les tables existent, l'écran suit dans une prochaine livraison.
- Dashboard CEO Groupe consolidé — prochaine livraison, sur le modèle anonymisé déjà tranché.
- Signature électronique qualifiée (prestataire tiers) — hors périmètre technique actuel, le champ `signature_method` documente une validation RH interne uniquement.
