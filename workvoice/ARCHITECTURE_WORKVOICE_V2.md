# ARCHITECTURE_WORKVOICE_V2.md

**Phase 1 — Architecture cible.** Ce document ne contient aucune migration ni code à exécuter : il décrit la cible et présente les décisions structurantes à valider avant la Phase 2 (modèle base de données) et la Phase 3 (migration). Basé sur [AUDIT_WORKVOICE_V2.md](AUDIT_WORKVOICE_V2.md).

---

## 1. Vue d'ensemble

```
Frontend (Next.js)
        │  cookies httpOnly (JWT) + cookie CSRF — inchangés
        ▼
Authentication (JWT HS256 — inchangé)
        │
        ▼
Authorization / RBAC  (NOUVEAU : rôle + société)
        │
        ▼
Tenant Context  (NOUVEAU : reconstruit côté serveur à CHAQUE requête)
        │
        ▼
API  (routes existantes + nouvelles routes /admin/societes, /ceo/*)
        │
        ▼
Business Services  (fonctions PHP/Node existantes, + clause company_id systématique)
        │
        ▼
Database  (tables existantes + colonne company_id + table companies)
```

Principe directeur : **on n'ajoute jamais un nouveau système à côté de l'ancien, on étend l'existant**. Le routeur, le modèle JWT, le pattern `current_user()`, le mécanisme `ensure_schema()` restent strictement les mêmes objets, complétés.

## 2. Rôles — de 3 à 4, sans rien casser

Aujourd'hui : `role ENUM('EMPLOYE','RH','DIRECTION')`.

Cible :

| Rôle cible | Rôle actuel correspondant | Scope |
|---|---|---|
| `SYSTEM_ADMIN` | **nouveau** | `ALL_COMPANIES` (technique, pas RH) |
| `CEO_GROUPE` | `DIRECTION` (renommage logique, pas de perte) | `ALL_COMPANIES` (lecture) |
| `RH_SOCIETE` | `RH` (renommage logique) | `ONE_COMPANY` |
| `COLLABORATEUR` | `EMPLOYE` (renommage logique) | `SELF` |

**Décision de compatibilité : je recommande de NE PAS renommer les valeurs de l'ENUM** (`EMPLOYE`/`RH`/`DIRECTION` restent les valeurs stockées en base et dans le JWT), pour ne rien casser dans le code existant (49 appels `require_role()` côté PHP, autant côté Node, plus tout le frontend qui teste déjà `user.role === "RH"` etc.). On ajoute seulement la valeur `SYSTEM_ADMIN` à l'ENUM. `DIRECTION` devient simplement le rôle qui *porte* le concept CEO Groupe — aucune migration de données sur les comptes existants (DG001/DG002 restent `DIRECTION`, RH001/RH002 restent `RH`).

```sql
ALTER TABLE users MODIFY COLUMN role
  ENUM('EMPLOYE','RH','DIRECTION','SYSTEM_ADMIN') NOT NULL DEFAULT 'EMPLOYE';
```

C'est un `ALTER` non destructif (ajout d'une valeur à un ENUM existant) : aucune ligne existante n'est affectée.

## 3. Modèle de données — décision structurante n°1

### Option A — `users.company_id` simple (FK directe)

```
users
  id
  company_id  INT UNSIGNED NULL  → companies.id   (NULL = SYSTEM_ADMIN ou CEO_GROUPE, portée globale)
```

- ✅ Simple, une seule jointure, migration légère.
- ✅ Suffit à 100 % des besoins décrits dans les deux cahiers des charges (chaque RH/Collaborateur appartient à *une* société).
- ❌ Un utilisateur ne peut jamais avoir un rôle dans deux sociétés (cas explicitement écarté comme "futur" dans le cahier des charges détaillé, mais mentionné).

### Option B — table de jonction `user_company_roles`

```
user_company_roles
  id
  user_id      → users.id
  company_id   → companies.id
  role         ENUM('RH_SOCIETE', ...)     -- rôle *dans cette société*
  UNIQUE (user_id, company_id)
```

- ✅ Évolutif : un utilisateur pourrait un jour être RH de WORKMAN et lecteur de STID EXPORT sans nouvelle migration.
- ❌ Complexifie *chaque* requête de scope (jointure supplémentaire partout), pour un besoin non exprimé aujourd'hui par le client (aucun des deux cahiers des charges ne donne d'exemple concret d'un utilisateur multi-sociétés).
- ❌ `SYSTEM_ADMIN`/`CEO_GROUPE` (accès global) devraient quand même être gérés hors de cette table (cas particulier), ce qui complique le modèle sans bénéfice immédiat.

### Recommandation

**Option A**, avec une nuance : je propose de créer `users.company_id` **NULL** (pas NOT NULL au départ, conformément à la méthode de migration en 11 étapes déjà demandée), NULL signifiant *portée globale* pour `SYSTEM_ADMIN` et `CEO_GROUPE`, et obligatoire (contrainte applicative, pas SQL) pour `RH`/`EMPLOYE`. Si un besoin réel de multi-société par utilisateur apparaît plus tard, on pourra ajouter `user_company_roles` en complément sans rien casser (Option A n'empêche pas d'ajouter Option B ensuite).

*Cette décision vous revient : dites-moi si vous validez l'Option A, ou si vous savez déjà qu'un utilisateur devra un jour gérer plusieurs sociétés (ex. un RH groupe qui couvre 2 filiales) — auquel cas on part direct sur l'Option B.*

## 4. Table `companies`

```sql
CREATE TABLE companies (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_code  VARCHAR(20)   NOT NULL,           -- ex. 'WORKMAN', 'STID', 'MBCONF', 'SOMICO'
  company_name  VARCHAR(120)  NOT NULL,            -- nom d'usage
  legal_name    VARCHAR(180)  NULL,                -- raison sociale complète
  address       VARCHAR(255)  NULL,
  city          VARCHAR(80)   NULL,
  country       VARCHAR(80)   NOT NULL DEFAULT 'Tunisie',
  phone         VARCHAR(30)   NULL,
  email         VARCHAR(150)  NULL,
  tax_number    VARCHAR(40)   NULL,                -- matricule fiscal
  logo          VARCHAR(255)  NULL,                -- fichier stocké, comme les pièces jointes
  status        ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  -- paramètres par société (§40 du cahier des charges), extensibles sans migration :
  settings      JSON          NULL,                -- ex. {"jours_travailles": [...], "conges_annuels_defaut": 18}
  created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at    DATETIME      NULL,                 -- soft delete (§35) : désactivation ≠ suppression
  PRIMARY KEY (id),
  UNIQUE KEY uq_companies_code (company_code)
) ENGINE=InnoDB;
```

`status = INACTIVE` bloque toute nouvelle opération RH sur cette société (vérification ajoutée dans `require_role()`/`tenant_scope()`), sans supprimer ses données — conforme à la règle §35.

Sociétés initiales insérées par la migration : `WORKMAN`, `STID`, `MBCONF`, `SOMICO`.

## 5. Propagation de `company_id`

Tables recevant `company_id INT UNSIGNED NULL` (nullable dans un premier temps, cf. §7 Plan de migration) :

| Table | Origine de `company_id` |
|---|---|
| `users` | colonne directe (décision §3) |
| `demandes`, `reclamations`, `suggestions` | dénormalisé depuis `users.company_id` de l'auteur, au moment de la création (évite une jointure sur chaque lecture, et fige la société même si l'utilisateur change de société plus tard) |
| `conges_demandes`, `sorties_demandes`, `retards_declarations` | idem, dénormalisé à la création |
| `notifications` | dénormalisé (déjà par `user_id`, on ajoute `company_id` pour permettre le filtrage RH sans jointure) |
| `audit_logs` | dénormalisé, pour permettre un audit "par société" (§33 exige de pouvoir répondre à *"qui a modifié quoi, quand, sur quelle société"*) |
| `jours_feries`, `conges_types`, `sorties_motifs`, `retards_motifs` | **décision à valider** : paramétrage global (partagé par toutes les sociétés) ou par société ? Voir §6 ci-dessous |
| `commentaires` | pas de `company_id` propre : hérite de son ticket parent (déjà scoppé par jointure) |
| `questionnaire_*` | **hors périmètre immédiat** — anonymisation déjà stricte, à traiter séparément si le questionnaire doit un jour être lancé par société (non demandé explicitement) |

Toutes les FK `company_id → companies.id` sont ajoutées `ON DELETE RESTRICT` (une société avec des données ne peut pas être supprimée physiquement — seul `status = INACTIVE` est permis, cohérent avec le soft delete).

## 6. Décision structurante n°2 — paramétrage partagé ou par société

Les référentiels `jours_feries`, `conges_types`, `sorties_motifs`, `retards_motifs` sont aujourd'hui globaux (un seul jeu pour toute l'entreprise).

### Option A — rester global (partagé par les 4 sociétés)
- ✅ Zéro changement de schéma sur ces 4 tables, zéro risque de régression.
- ❌ Ne respecte pas littéralement §40 (*"chaque société peut avoir ses propres... types d'absence"*) si jamais WORKMAN et SOMICO veulent des jours fériés ou des types de congés différents.

### Option B — dupliquer par société (`company_id` ajouté, chaque société gère sa propre liste)
- ✅ Conforme à la lettre du cahier des charges.
- ❌ Sur un groupe textile tunisien, les jours fériés légaux sont **identiques pour toutes les sociétés** (même pays) — dupliquer ce référentiel 4 fois créerait une maintenance inutile et un risque de désynchronisation (RH WORKMAN ajoute le jour férié mais oublie de le faire pour SOMICO → paie de congés fausse).

### Recommandation
**Jours fériés → restent globaux** (Option A) : ce sont des jours légaux nationaux, identiques pour toutes les sociétés tunisiennes du groupe.
**Types de congés / motifs de sortie / motifs de retard → passent par société** (Option B), avec une astuce : à la création d'une société, on **copie automatiquement** les types "système" existants (`ANNUEL`, `MALADIE`, etc.) pour cette nouvelle société, pour qu'elle démarre avec un paramétrage prêt à l'emploi sans ressaisie (conforme à §7 *"une nouvelle société doit avoir immédiatement congés, workflows..."*).

*Décision à valider avec vous : confirmez-vous que les jours fériés doivent rester communs aux 4 sociétés ?*

## 7. Plan de migration (11 étapes, conforme §19-20)

1. **Backup complet** de `workmagrh` (mysqldump via phpMyAdmin, export SQL complet) — je vous fournirai la procédure exacte en Phase 3.
2. Création de `companies` + insertion des 4 sociétés initiales.
3. Ajout de `company_id` **nullable** sur `users` et les 6 tables métier listées en §5.
4. **Mapping des données existantes** : ici, un point bloquant nécessite votre arbitrage — `users.societe` (texte libre, Module 4) contient déjà des valeurs pour une partie des comptes, mais n'est pas fiable à 100 % (champ facultatif, non contraint, une partie des comptes de démo/production ne l'ont probablement pas renseigné). **Je ne peux pas déterminer automatiquement, de façon fiable, quelle société réelle correspond à chaque compte existant.** Deux sous-options :
   - **4a.** Vous me fournissez la liste réelle (ou je génère un export `users` actuel pour que vous l'annotiez société par société), je fais le mapping exact.
   - **4b.** Par défaut, **tous les comptes existants sont rattachés à `WORKMAN`** (société "historique", celle sous laquelle l'app tourne aujourd'hui), et vous les réaffectez ensuite manuellement via l'écran RH (un `PATCH` simple, déjà prévu dans le modèle) pour ceux qui appartiennent en réalité à STID/MB Confection/SOMICO.
   - Je recommande **4b** : c'est réversible, ne bloque pas le projet, et correspond à la réalité actuelle (l'app ne gère qu'une société de fait aujourd'hui).
5. Application du mapping (`UPDATE users SET company_id = ...`), puis des 6 tables dénormalisées (`UPDATE ... JOIN users ...`).
6. Contrôle : `SELECT COUNT(*) FROM users WHERE company_id IS NULL AND role IN ('EMPLOYE','RH')` doit renvoyer 0 avant de continuer.
7. Ajout des clés étrangères `company_id → companies.id`.
8. Ajout des index (`idx_<table>_company`).
9. Ajout de contraintes (`CHECK` applicatif : un `SYSTEM_ADMIN`/`DIRECTION` peut avoir `company_id NULL`, un `RH`/`EMPLOYE` non — contrainte gérée en PHP/Node à la création/modification d'utilisateur, MySQL ne supportant pas de `CHECK` conditionnel inter-lignes simple ici).
10. Passage à `NOT NULL` uniquement sur les tables métier (`demandes`, `conges_demandes`, etc.) une fois le mapping validé — `users.company_id` reste NULL-able en permanence (à cause de `SYSTEM_ADMIN`/`DIRECTION`).
11. Validation finale + `MIGRATION_VALIDATION_REPORT.md` (comparatif avant/après des comptages par table, comme demandé en §21).

Ce plan réutilise exactement le mécanisme déjà en production : une nouvelle version `SCHEMA_VERSION = 4` dans `api-php/lib/schema.php` (`migrate_v4_multi_tenant()`), + un fichier `06_migration_multi_tenant.sql` en secours FTP, sur le modèle de `05_migration_modules_rh.sql`.

## 8. Tenant Context — reconstruction serveur

Extension de `current_user()` (PHP) / son équivalent Node, **sans changer sa signature externe** (le reste du code qui appelle `current_user()` continue de fonctionner à l'identique) :

```php
function current_user(): array {
    // ... logique JWT existante, inchangée ...
    $row = q1('SELECT id, ..., role, company_id FROM users WHERE id = ? AND actif = 1', [...]);
    // Le JWT ne transporte PAS company_id : il est relu en base à CHAQUE requête,
    // exactement comme le rôle l'est déjà aujourd'hui — aucune confiance dans un
    // company_id qui viendrait du frontend ou d'un jeton (règle §36 / §9).
    return $user;
}

/** Nouvelle fonction, appelée en plus de require_role() sur les routes scopées société. */
function require_company_scope(int $resourceCompanyId): void {
    $user = current_user();
    if (in_array($user['role'], [ROLE_SYSTEM_ADMIN, ROLE_DIRECTION], true)) {
        return; // accès global
    }
    if ($user['company_id'] !== $resourceCompanyId) {
        throw forbidden(); // jamais 200, jamais de fuite d'information sur l'existence de la ressource
    }
}
```

**Chaque route RH existante** (`/rh/collaborateurs`, `/rh/conges`, etc.) reçoit un ajout de clause `WHERE company_id = ?` (paramétrée avec `current_user()['company_id']`) **et** un appel `require_company_scope()` sur les routes à ressource unique (`/rh/conges/{id}`, etc.) pour bloquer l'accès direct par ID à une ressource d'une autre société (protection IDOR, §10).

**Le frontend ne détermine jamais le périmètre** : il continue d'appeler les mêmes endpoints qu'aujourd'hui, sans paramètre `company_id` dans les requêtes (ou si un `company_id` est présent dans le body/query d'un `SYSTEM_ADMIN`/`CEO_GROUPE` qui filtre, il n'est utilisé qu'en lecture et n'élargit jamais l'accès d'un RH_SOCIETE/EMPLOYE — cf. §9 du cahier des charges).

## 9. Compatibilité API — pas de `/v1` → `/v2`

Toutes les routes existantes gardent exactement le même chemin, la même méthode, le même contrat de réponse. Le filtrage par société est **invisible** pour un utilisateur RH/EMPLOYE qui n'a qu'une société : il continue de voir exactement ce qu'il voit aujourd'hui (puisqu'aujourd'hui, de fait, tout le monde est dans la même société implicite). **Aucun `/api/v2` n'est nécessaire** pour cette transformation — c'est un ajout de filtrage, pas un changement de contrat (conforme à la préférence de §37 : ne créer une version que si un breaking change est indispensable).

Nouvelles routes (additives) :
- `POST/GET/PATCH /admin/societes` — réservé `SYSTEM_ADMIN`
- `GET /admin/utilisateurs`, `POST /admin/utilisateurs` (création RH/CEO/rattachement société) — réservé `SYSTEM_ADMIN`
- `GET /ceo/dashboard`, `GET /ceo/comparatif`, `GET /ceo/organigramme` — réservé `DIRECTION` (renommé conceptuellement CEO_GROUPE), lecture seule, **via des vues anonymisées étendues** (voir §10)
- Les routes `/rh/*` existantes restent identiques dans leur forme, augmentées du filtre société en interne.

## 10. Anonymisation Direction → cohabitation avec CEO Groupe

Point sensible identifié dans l'audit (§14) : la Direction actuelle n'a accès qu'à des **vues anonymisées** (`v_direction_reclamations`, `v_direction_demandes`), sans identité. Le cahier des charges Multi-Tenant demande au contraire que le CEO Groupe puisse consulter *"tous les collaborateurs, tous les congés..."* avec filtres par société/département/manager — ce qui suppose de voir des identités.

**Ces deux exigences sont en tension** et nécessitent un arbitrage de votre part :

- **Option A** : le CEO Groupe garde le même niveau d'anonymisation que la Direction actuelle (statistiques + filtres organisationnels, jamais de nom/prénom/matricule) — on étend les vues `v_direction_*` avec `company_id` et on ajoute des vues équivalentes pour congés/retards/sorties, toutes anonymisées. C'est la continuité stricte de la politique de confidentialité déjà en place.
- **Option B** : le CEO Groupe voit les identités complètes (comme un RH), sur les 4 sociétés — ce qui correspond littéralement au texte du cahier des charges (*"consulter tous les collaborateurs"*), mais représente un changement de politique de confidentialité majeur par rapport à ce qui existe aujourd'hui pour la Direction.

*Je recommande l'Option A par défaut (cohérence avec l'existant + principe de moindre privilège), sauf si vous confirmez explicitement que le CEO Groupe doit voir les identités nominatives — dans ce cas je le fais, mais je voulais m'assurer que ce n'est pas un effet de bord non voulu du copier-coller de la matrice de permissions.*

## 11. Notifications, audit, organigramme — résumé

- `notify_role(ROLE_RH, ...)` devient `notify_role(ROLE_RH, $companyId, ...)` : diffusion restreinte aux RH de la société concernée. `notify_role(ROLE_DIRECTION, ...)` reste global (consolidé), conforme à la demande.
- `audit_logs` reçoit `company_id` (dénormalisé) — permet un futur écran "Audit par société" pour `SYSTEM_ADMIN`/`RH_SOCIETE` (actuellement, `audit_logs` est alimenté mais n'a aucun écran de consultation — ceci reste vrai sauf si vous demandez cet écran explicitement, hors périmètre des deux cahiers des charges fournis).
- Organigramme groupe : construit à partir de `companies` + `users.manager_id` (déjà en place) + `company_id` — aucune nouvelle table nécessaire, une seule requête récursive (`WITH RECURSIVE`, disponible en MySQL 8+, confirmé en prod : 8.4.11).

## 12. Ce qui reste strictement inchangé

- JWT, cookies, CSRF double-submit, `bcrypt`/`password_verify` : identiques.
- Les 30 pages Next.js existantes : aucune n'est supprimée ni renommée. Les nouvelles pages (`/admin/societes`, `/ceo/*`) s'ajoutent sous de nouveaux segments de route.
- `ensure_schema()` : même mécanisme, nouvelle version `v4`.
- `config.php`, exclusion de Git/zips : inchangé.
- Dual-backend PHP/Node : la parité continue d'être maintenue (chaque règle de scope PHP est répliquée en Node), sans fusion des deux backends.

---

## Décisions à valider avant la Phase 2 (modèle base de données)

1. **§3** — Modèle `users.company_id` simple (Option A, recommandée) ou table de jonction `user_company_roles` (Option B) ?
2. **§6** — Jours fériés communs aux 4 sociétés (recommandé) ou dupliqués par société ?
3. **§7 étape 4** — Rattacher par défaut tous les comptes existants à `WORKMAN` puis réaffecter manuellement (recommandé), ou me fournir un mapping exact avant migration ?
4. **§10** — CEO Groupe reste anonymisé comme la Direction actuelle (recommandé), ou doit voir les identités nominatives complètes ?

Dès vos réponses (ou votre accord sur les recommandations par défaut), je rédige les migrations SQL (`06_migration_multi_tenant.sql` + `schema.php` v4) et j'enchaîne sur la Phase 2.
