# DATABASE_MULTI_TENANT.md

**Phase 2 — Modèle base de données** (livrée avec la migration réelle, Phase 3). Basé sur les décisions validées dans [ARCHITECTURE_WORKVOICE_V2.md](ARCHITECTURE_WORKVOICE_V2.md) le 2026-09-28.

---

## 1. Nouvelle table : `companies`

| Colonne | Type | Notes |
|---|---|---|
| `id` | INT UNSIGNED PK | |
| `company_code` | VARCHAR(20) UNIQUE | `WORKMAN`, `STID`, `MBCONF`, `SOMICO` |
| `company_name` | VARCHAR(120) | nom d'usage |
| `legal_name` | VARCHAR(180) NULL | raison sociale complète |
| `address`, `city`, `country` | | `country` par défaut `'Tunisie'` |
| `phone`, `email`, `tax_number` | NULL | matricule fiscal |
| `logo` | VARCHAR(255) NULL | nom de fichier stocké (même mécanisme que les pièces jointes) |
| `status` | ENUM('ACTIVE','INACTIVE') | `INACTIVE` bloque toute nouvelle opération RH sur cette société |
| `settings` | JSON NULL | paramètres extensibles par société, sans migration future |
| `deleted_at` | DATETIME NULL | réservé — une société ne se supprime jamais physiquement |

4 sociétés initiales insérées (id 1 à 4) : Workman, STID Export, MB Confection, Somico.

## 2. `users` — extension

- `role` : ENUM étendu avec `SYSTEM_ADMIN` (les 3 valeurs existantes `EMPLOYE`/`RH`/`DIRECTION` sont conservées à l'identique — aucune ligne existante affectée).
- `company_id INT UNSIGNED NULL` → `companies.id`, `ON DELETE RESTRICT`.
  - `NULL` = portée globale (`SYSTEM_ADMIN`, `DIRECTION`/CEO Groupe).
  - Renseigné = société unique de l'utilisateur (`RH`, `EMPLOYE`).
  - Tous les comptes `EMPLOYE`/`RH` déjà en production sont rattachés par défaut à **WORKMAN** (décision validée) — réaffectables individuellement ensuite sans risque (simple `UPDATE`, déjà exposable via l'écran Collaborateurs).

## 3. Propagation de `company_id` (dénormalisé depuis l'auteur)

Tables suivantes : `demandes`, `reclamations`, `suggestions`, `conges_demandes`, `sorties_demandes`, `retards_declarations`, `notifications`.

- `company_id INT UNSIGNED NULL` → `companies.id`, `ON DELETE RESTRICT`.
- Renseigné à la création à partir de `users.company_id` de l'auteur (jamais recalculé après coup : si un collaborateur change de société plus tard, son historique reste rattaché à sa société d'origine).
- Backfill sur les données existantes : `UPDATE <table> x JOIN users u ON u.id = x.user_id SET x.company_id = u.company_id`.

`audit_logs` reçoit également `company_id`, mais avec `ON DELETE SET NULL` (comme son `user_id` existant) puisqu'une action système peut ne pas avoir d'auteur.

## 4. Référentiels de paramétrage — préparés, pas encore activés

`conges_types`, `sorties_motifs`, `retards_motifs` reçoivent un `company_id INT UNSIGNED NULL` (`ON DELETE SET NULL`) :
- `NULL` (valeur actuelle de toutes les lignes existantes) = gabarit **partagé par toutes les sociétés**.
- La bascule vers un paramétrage réellement propre à chaque société (RH de STID qui ajoute son propre motif de sortie sans que WORKMAN le voie) est une fonctionnalité applicative à construire dans l'écran RH « Paramétrage » (Phase 6/7) — **la colonne existe déjà, mais aucune règle ne l'exploite pour l'instant.** Tant que cette fonctionnalité n'est pas construite, le comportement est strictement identique à aujourd'hui (tout le monde voit les mêmes types/motifs).

`jours_feries` **reste global**, sans `company_id` (jours légaux nationaux, identiques pour les 4 sociétés).

## 5. Ce qui n'a PAS de `company_id`

- `commentaires` : hérite de son ticket parent (`demande_id`/`reclamation_id`/`suggestion_id`), déjà scoppé par jointure — pas de dénormalisation nécessaire.
- `conges_mouvements` : hérite de son `user_id` → `company_id`, pas dénormalisé (historique interne au solde d'un utilisateur, jamais listé indépendamment de son propriétaire).
- `questionnaire_*` : hors périmètre de cette migration (anonymisation stricte déjà en place, non demandée explicitement par le cahier des charges Multi-Tenant).
- `sequences` : reste global (numérotation partagée DEM/REC/SUG/CNG/SOR/RET, décision non remise en cause — aucun des deux cahiers des charges ne demande une numérotation par société).

## 6. Fichiers livrés (Phase 2 + Phase 3)

| Fichier | Rôle |
|---|---|
| [`database/01_schema.sql`](database/01_schema.sql) | Schéma de référence à jour (installation neuve) |
| [`database/06_migration_multi_tenant.sql`](database/06_migration_multi_tenant.sql) | Migration manuelle pour une base déjà installée (phpMyAdmin) |
| [`api-php/lib/schema.php`](api-php/lib/schema.php) | `SCHEMA_VERSION = 4`, `migrate_v4_multi_tenant()` — application automatique au premier appel API |
| [`api-php/lib/services.php`](api-php/lib/services.php) | Constante `ROLE_SYSTEM_ADMIN` |
| [`api-php/lib/bootstrap.php`](api-php/lib/bootstrap.php) | `/api/health` vérifie désormais aussi la table `companies` |

Vérification effectuée : lint syntaxique PHP (`php-parser`) sur les 21 fichiers de `api-php/` — 0 erreur.

## 7. Ce qui reste à faire (Phase 4 à 9 — non inclus dans cette livraison)

Cette livraison est **uniquement le modèle de données et sa migration**. Rien n'est encore isolé par société côté application :
- Aucune route API ne filtre encore par `company_id` (Phase 5-6 — Tenant Isolation / API).
- Aucun écran `SYSTEM_ADMIN` (gestion des sociétés/utilisateurs) n'existe encore côté frontend (Phase 7).
- Aucun dashboard CEO Groupe / comparatif sociétés / organigramme groupe n'existe encore (Phase 8-9).
- `notify_role()` diffuse encore à tous les RH, toutes sociétés confondues (à restreindre en Phase 5).

**Tant que ces phases suivantes ne sont pas faites, la présence de `company_id` en base ne change rien au comportement observable de l'application** : c'est le point important de cette étape — le modèle de données est posé, sans aucune régression, avant de brancher la logique d'isolation dessus.

## Prochaine étape proposée

Phase 4-6 : `require_company_scope()`, filtrage de chaque route RH existante par `company_id`, restriction de `notify_role()`, nouvelles routes `/admin/societes` et `/ceo/*`. C'est le chantier le plus large et le plus sensible (il touche la quasi-totalité des routes des deux backends) — je le découperai en sous-livraisons testables plutôt qu'un seul bloc, en commençant par le backend PHP (celui réellement en production).
