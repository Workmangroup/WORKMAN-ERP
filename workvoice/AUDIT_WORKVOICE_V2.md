# AUDIT_WORKVOICE_V2.md

**Phase 0 — Audit.** Aucun fichier de code n'a été modifié pour produire ce document (lecture seule : schéma SQL, backend PHP et Node, frontend Next.js, configuration, documentation existante).

Date de l'audit : 2026-09-28.

---

## 1. Architecture actuelle

WorkVoice RH & ISO est aujourd'hui une application **mono-société, mono-tenant**, à trois rôles plats (EMPLOYE / RH / DIRECTION), avec **deux implémentations backend en parallèle** partageant la même base MySQL :

```
Next.js 16 (export statique)
        │
        ▼
   Nginx / FTP statique
        │
   ┌────┴─────┐
   │           │
PHP API     Node API        ← les deux exposent EXACTEMENT les mêmes routes/contrats
(OVH,       (VPS,             et lisent/écrivent la même base MySQL
 en prod)    non déployé
             en prod)
        │
        ▼
   MySQL 8.x — base unique « workmagrh » (prod) / « workvoice » (schéma)
```

- **Seul le backend PHP tourne réellement en production** (`https://rh.workman-stid.com`, hébergement mutualisé OVH, pas d'accès SSH/process manager).
- Le backend Node existe en parité fonctionnelle complète, prêt pour un déploiement VPS futur, mais n'est jamais utilisé en prod aujourd'hui.
- Il n'existe **aucune notion de société/tenant** dans le code : l'application gère une seule population d'utilisateurs, un seul jeu de rôles, une seule base.
- Un champ texte libre `users.societe` (ajouté au Module 4 « Fiche collaborateur ») stocke un nom d'entité juridique (ex. « MB Confection », « STID Export ») **à titre informatif uniquement** — il n'est utilisé dans **aucune clause de filtrage, aucune jointure, aucun contrôle d'accès**. Un RH voit et gère aujourd'hui tous les collaborateurs, quelle que soit la valeur de ce champ.

## 2. Stack technique

| Couche | Technologie |
|---|---|
| Frontend | Next.js 16 (`output: "export"`, site 100 % statique), React, Tailwind CSS v4, shadcn/ui (style « base-nova », primitives Base UI) |
| Backend prod | PHP 8.2 « from scratch » (pas de framework), routeur maison par regex (`bootstrap.php`), PDO/MySQL |
| Backend parité | Node.js + Express, `mysql2/promise`, zod pour la validation |
| Base de données | MySQL 8.0.16+ (attesté 8.4.11 en prod), InnoDB, utf8mb4 |
| Auth | JWT HS256 maison (pas de lib externe), cookie `httpOnly` + cookie CSRF « double-submit » |
| Hébergement prod | OVH mutualisé (FTP uniquement, pas de shell, pas de queue/process, PHP + MySQL seulement) |
| Emails | fonction `mail()` PHP native (pas de SMTP dédié) |

**Aucun framework RBAC**, **aucun ORM**, **aucune lib multi-tenant** (pas de Prisma/TypeORM row-level-security, pas de package « tenant » quelconque). Tout est écrit à la main.

## 3. Structure frontend

```
frontend/src/app/
├── login/
└── (portal)/
    ├── employe/           (+ conges, sorties, retards, nouvelle-demande, nouvelle-reclamation, suggestion, questionnaire, historique, ticket)
    ├── rh/                (+ collaborateurs, conges, sorties, retards, demandes, reclamations, suggestions, questionnaire, ticket)
    ├── direction/         (+ reclamation, reclamations, questionnaire)
    └── profil/
```

- Le routage par dossier **encode déjà le rôle** (`employe/`, `rh/`, `direction/`) mais **rien n'encode la société**. Il n'existe pas de `[company]/` dans l'arborescence, pas de sélecteur de société, pas de header affichant une société active.
- `lib/auth.tsx` : contexte React `AuthProvider` très simple — un `GET /auth/me` au montage, pas de notion de `companyId`/`companyScope` dans le state. Le `User` renvoyé par `/auth/me` ne contient ni `company_id` ni liste de sociétés accessibles.
- `lib/api.ts` (implicite) : client fetch avec gestion CSRF/401 globale (`wv:unauthorized` event) — c'est le bon point d'insertion pour propager un futur header/contexte tenant, mais actuellement aucun identifiant de société n'y transite.
- Le frontend n'est **jamais** la barrière de sécurité (conforme à l'exigence §8/§36) : tous les filtrages métier observés sont bien côté API. Mais comme l'API elle-même n'a aucune notion de tenant, il n'y a rien à répercuter côté frontend pour l'instant.

## 4. Structure backend

### PHP (`api-php/`, seul backend en production)

```
lib/
  bootstrap.php   routeur regex, gestion d'erreurs, CORS/headers sécurité, dispatch
  auth.php        JWT HS256, cookie httpOnly, CSRF double-submit, current_user() relu en base à chaque requête
  db.php          PDO, connexion "app" + connexion "direction" (moindre privilège)
  services.php    constantes de rôles/labels, helpers upload, notify_users()/notify_role(), audit()
  schema.php      migrations idempotentes auto-exécutées (ensure_schema(), SCHEMA_VERSION = 3)
  validate.php    classe Validator maison (required/string/int/enum/bool/date…)
routes/
  auth.php, me.php, notifications.php, tickets.php, rh.php, direction.php,
  questionnaire.php, collaborateurs.php, conges.php, sorties.php, retards.php
```

Points clés :
- **`ensure_schema()` s'exécute à chaque requête** (via `bootstrap.php`) et applique des migrations idempotentes additives — c'est le mécanisme déjà en place pour déployer des évolutions de schéma sur un hébergement mutualisé sans accès shell. **C'est directement réutilisable pour la migration Multi-Tenant** (§20).
- `current_user()` relit systématiquement le rôle en base (pas seulement dans le JWT) : un changement de rôle ou une désactivation de compte est immédiat. Bon point d'ancrage pour y ajouter demain `company_id`/`company_scope`.
- Chaque route appelle `require_role(ROLE_RH)` (ou EMPLOYE/DIRECTION) mais **aucune route n'a de second paramètre de scope** — il n'existe pas de fonction `require_scope()` ou équivalent.
- `notify_role(ROLE_RH, …)` diffuse à **tous** les RH de la base, sans filtre de société — confirme qu'il n'y a qu'un seul pool RH global aujourd'hui.

### Node (`backend/src/`, parité fonctionnelle, non déployé en prod)

Structure en modules (`modules/<domaine>/<domaine>.routes.js`), middlewares `authenticate`/`authorize`/`csrfProtection`, `config/db.js` (pool `mysql2`), `config/env.js`. Même absence totale de notion de tenant.

## 5. Structure base de données

21 tables + 2 vues (`database/01_schema.sql`, migrations `02` à `05`) :

| Domaine | Tables |
|---|---|
| Identité/organisation | `users` (matricule, nom, service, département, site, role, + fiche RH étendue Module 4) |
| Tickets RH génériques | `demandes`, `reclamations`, `suggestions`, `commentaires`, `sequences` |
| Notifications/audit | `notifications`, `audit_logs` |
| Questionnaire satisfaction | `questionnaire_campagnes`, `questionnaire_questions`, `questionnaire_participations`, `questionnaire_reponses`, `questionnaire_reponses_detail` |
| Congés (Module 1) | `jours_feries`, `conges_types`, `conges_demandes`, `conges_mouvements` |
| Sorties (Module 2) | `sorties_motifs`, `sorties_demandes` |
| Retards (Module 3) | `retards_motifs`, `retards_declarations` |
| Vues anonymisées Direction | `v_direction_reclamations`, `v_direction_demandes` |

**Aucune table `companies` n'existe. Aucune colonne `company_id` n'existe sur aucune table**, y compris `users`. Le seul signal de société est `users.societe VARCHAR(80) NULL`, non contraint, non indexé pour du filtrage métier (il a un usage d'affichage uniquement dans la fiche collaborateur).

`organisation` (service/département/site) est déjà un triplet texte libre par utilisateur — c'est un référentiel plat, non normalisé (pas de table `departements`/`services`/`sites`), ce qui devra être pris en compte si l'on souhaite une hiérarchie organisationnelle par société (§27 Organigramme).

### Relations actuelles
- Toutes les tables métier (`demandes`, `reclamations`, `suggestions`, `conges_demandes`, `sorties_demandes`, `retards_declarations`) référencent `users.id` en FK, jamais de société.
- `users.manager_id` est une auto-FK déjà en place (ajoutée au Module 4) — utile telle quelle pour l'organigramme (§27), mais ne porte aucune notion de périmètre société (un manager pourrait aujourd'hui être rattaché à un collaborateur d'une autre « société » textuelle sans qu'aucun contrôle ne s'y oppose).
- `sequences` (numérotation DEM/REC/SUG/CNG/SOR/RET) est clé par `(prefixe, annee)` — global, pas par société. Un futur cloisonnement par société nécessiterait soit un système de numérotation par société (si les numéros doivent rester lisibles par société), soit un maintien du système global (acceptable si les numéros n'ont pas de valeur légale par société).

## 6. API — surface actuelle

~49 appels `require_role()` recensés côté PHP, répartis sur les familles suivantes (mêmes contrats côté Node) :

- `POST /auth/login`, `/auth/logout`, `GET /auth/me`, `POST /auth/password`
- `GET/POST /me/*` (dashboard, profil, notifications, solde-conges)
- CRUD générique tickets : `/{kind}/...` où `kind ∈ {demandes, reclamations, suggestions}`
- `/rh/*` (gestion collaborateurs, dashboards, tickets tous statuts)
- `/direction/*` (dashboard, stats, réclamations anonymisées — **lecture seule, via vues**)
- `/questionnaire/*`
- `/conges/*`, `/rh/conges/*`, `/sorties/*`, `/rh/sorties/*`, `/retards/*`, `/rh/retards/*`

Aucune route n'a de préfixe de version (`/api/v1/...`) : une évolution non rétrocompatible n'a aujourd'hui aucun mécanisme de coexistence prévu (§37 demande explicitement de prévoir `/api/v1` → `/api/v2` si nécessaire).

## 7. Authentification

- JWT HS256 **signé maison** (pas de lib type `firebase/php-jwt`), payload minimal `{sub, role, iss, iat, exp}` — **le JWT ne contient pas d'identifiant de société**. Toute stratégie multi-tenant devra soit l'y ajouter (avec revalidation serveur obligatoire, jamais de confiance aveugle — cf. §36), soit ne pas s'appuyer dessus et tout dériver de `current_user()` en base à chaque requête (ce qui est déjà le pattern actuel et le plus sûr).
- Cookie `httpOnly` + `Secure` (si HTTPS) + `SameSite=Lax` pour le token ; cookie CSRF séparé, non-`httpOnly`, vérifié en double-submit sur toute requête modifiante. C'est un design déjà solide, à conserver tel quel.
- Pas de refresh token : durée de session fixe (8h), renouvelée par re-login.
- `mdp_temporaire` force un changement de mot de passe avant tout autre accès — bon pattern déjà en place, réutilisable si un futur SYSTEM_ADMIN crée un utilisateur RH d'une nouvelle société.

## 8. Rôles actuels

```sql
role ENUM('EMPLOYE','RH','DIRECTION') NOT NULL DEFAULT 'EMPLOYE'
```

Correspondance approximative avec la cible demandée (§12-16) :

| Rôle demandé | Existe aujourd'hui ? | Écart |
|---|---|---|
| SYSTEM_ADMIN | ❌ absent | RH a aujourd'hui les pleins pouvoirs de gestion des comptes ; aucun rôle n'est dédié à la création de sociétés/admin plateforme |
| GROUP_CEO | ⚠️ partiel (`DIRECTION`) | `DIRECTION` a déjà un scope « vision consolidée + anonymisation forcée », mais il n'y a qu'**une seule société à consolider** aujourd'hui — le concept de comparatif inter-sociétés (§26) n'existe pas |
| COMPANY_HR | ⚠️ partiel (`RH`) | `RH` existe et a déjà toutes les permissions listées en §15 (créer/gérer collaborateurs, congés, retards, sorties, exports…), mais son scope est `ALL` (toute la base), pas `ONE_COMPANY` |
| EMPLOYEE | ✅ équivalent (`EMPLOYE`) | Scope déjà `SELF` de fait (un employé ne voit que ses propres tickets/congés) |

**Le `role` ENUM stocké en colonne (au lieu d'une table de rôles) est une limitation structurelle** : passer à un modèle RBAC avec scope nécessite soit d'étendre l'ENUM (rapide mais rigide), soit d'introduire une vraie table `roles`/`permissions` (plus lourd mais aligné avec §12 « Créer et documenter » une matrice de permissions, et avec le besoin futur de permissions fines par société).

## 9. Permissions — état actuel vs matrice cible (§17)

| Fonction | RH aujourd'hui | Cible `COMPANY_HR` |
|---|---|---|
| Collaborateurs | CRUD sur **toute la base** | CRUD limité à `company_id = sa société` |
| Congés/Retards/Sorties | CRUD sur **toute la base** | idem, limité à la société |
| Documents/Exports | Génère et exporte pour **tout le monde** | idem, limité |
| Audit | Aucun accès dédié (tables `audit_logs` alimentées mais pas d'écran de consultation) | Lecture limitée à la société |

**Aucun contrôle IDOR n'est nécessaire aujourd'hui car il n'y a qu'un seul périmètre.** C'est précisément ce que la transformation doit changer : chaque `require_role(ROLE_RH)` actuel devra devenir `require_role(ROLE_RH); require_scope($ressource->company_id)`.

## 10. Stockage fichiers

- Upload physique dans `api-php/uploads/`, noms de fichiers randomisés (UUID), **jamais servis par une URL directe** : `.htaccess` bloque tout accès direct au dossier (`Require all denied`), et un helper `download_stored_file()` sert le contenu uniquement depuis une route API authentifiée.
- Le contrôle d'autorisation avant téléchargement est fait **au cas par cas dans chaque route** (propriétaire du ticket OU rôle RH) — il n'y a pas de fonction centrale `can_download($file, $user)`.
- **Bonne base pour §32** (téléchargement authentifié + vérif permission) mais il faudra y ajouter systématiquement la vérification de société, ce qui n'existe pas.

## 11. Notifications

Table `notifications` simple (`user_id`, `type`, `titre`, `message`, `lien`, `lu`). Deux helpers : `notify_users(array $userIds, …)` (ciblé) et `notify_role(string $role, …)` (diffusion à tout un rôle). **`notify_role('RH', …)` alerte aujourd'hui tous les RH de toutes les sociétés** — c'est un point de fuite à corriger explicitement dès l'introduction du multi-tenant (§28 l'exige : RH WORKMAN ne doit recevoir que les notifications WORKMAN).

## 12. Risques identifiés pour la transformation Multi-Tenant

1. **Hébergement OVH mutualisé** : pas de shell, pas de process manager, une seule base MySQL par plan d'hébergement typique. Une architecture « une base par société » serait très difficile à opérer sur cet hébergement (chaque société nécessiterait une base + des identifiants distincts, gérés uniquement via phpMyAdmin/FTP). **Un schéma partagé avec `company_id`** est bien plus réaliste dans ce contexte et s'aligne avec le mécanisme de migration additive déjà en place (`ensure_schema()`).
2. **Double backend à maintenir en parité** : toute règle de scope devra être portée identiquement en PHP (prod) et Node (parité), doublant l'effort et le risque de divergence — déjà observé dans ce projet par le passé (ex. bug de race condition sur la numérotation Node, corrigé récemment).
3. **`role` en ENUM colonne** plutôt qu'en table : ajouter `SYSTEM_ADMIN`/`GROUP_CEO` est un `ALTER TABLE … MODIFY COLUMN role ENUM(...)`, une opération relativement lourde sur une table `users` en production avec des lignes existantes — à tester avant application (cf. §46/§47).
4. **Données de production déjà peuplées** avec un seul « rôle DIRECTION » anonymisé et des `users.societe` textuels incohérents/vides pour une partie des comptes existants (aucune contrainte NOT NULL, aucune validation de valeurs). Le mapping initial "quel `company_id` pour quel utilisateur existant" (§19 étape 1-3) devra être fait manuellement avec le client, pas de règle automatique fiable puisque `societe` est un champ libre non normalisé.
5. **`sequences` et notifications globales** : plusieurs mécanismes actuels supposent un pool unique (numérotation, diffusion RH) — ils doivent être audités individuellement pour décider s'ils restent globaux ou deviennent scoppés par société (impact fonctionnel à valider avec le client : les numéros de tickets doivent-ils rester unifiés ou redevenir `DEM-2026-0001` par société ?).
6. **Aucun test automatisé existant** (pas de dossier `tests/`, pas de CI détectée) : tout le testing du projet a été fait jusqu'ici manuellement (build, `tsc --noEmit`, vérifications navigateur ponctuelles) et via un serveur mock lors des sessions précédentes. §44-47 exigent des suites de tests fonctionnels, IDOR, régression — **ceci est un chantier à part entière**, actuellement inexistant, qu'il faudra construire from scratch (aucun framework de test n'est configuré dans `package.json`/`composer.json` — d'ailleurs il n'y a pas de `composer.json` du tout côté PHP, aucune dépendance externe).
7. **Documentation demandée (14 fichiers .md)** est un livrable en soi, disjoint du code — à produire au fil des phases, pas en une fois.

## 13. Dépendances

- **PHP** : zéro dépendance externe (pas de Composer). Tout est « vanilla PHP 8.2 + PDO ». Avantage : rien à mettre à jour ; inconvénient : pas de lib RBAC/multi-tenant prête à l'emploi, tout est à coder à la main (cohérent avec l'existant, donc pas un problème en soi).
- **Node** : Express, mysql2, zod, bcrypt, jsonwebtoken (à confirmer), cors, helmet, morgan, cookie-parser.
- **Frontend** : Next.js 16, Tailwind v4, Base UI (`@base-ui-components`), lucide-react, zod (partagé avec les formulaires).

## 14. Points sensibles à ne pas casser (rappel express)

- Le mécanisme d'anonymisation Direction (vues SQL + compte MySQL à privilège réduit) est une exigence de confidentialité déjà en production — toute évolution du rôle DIRECTION/GROUP_CEO **doit** continuer de passer exclusivement par des vues, jamais par un accès direct aux tables `users`/`reclamations` avec les colonnes d'identité.
- `ensure_schema()` tourne sur **chaque requête HTTP** en production — toute nouvelle migration ajoutée ici doit rester rapide (vérifications `information_schema` déjà utilisées, pattern à conserver) et strictement idempotente, car elle s'exécutera des milliers de fois avant qu'une contrainte NOT NULL puisse être posée en toute sécurité.
- `config.php` (secrets réels de prod) n'est jamais dans Git ni dans les zips de livraison — cette règle reste absolue pour toute nouvelle variable de config multi-tenant (ex. clés par société, si jamais nécessaire).
- Les 30 pages Next.js existantes, les ~49 routes API existantes et les 21 tables existantes doivent rester strictement fonctionnelles à l'identique pour un utilisateur EMPLOYE/RH/DIRECTION d'aujourd'hui pendant toute la transformation (règle « zéro régression » déjà appliquée avec succès lors des 4 modules précédents de cette session).

## 15. Stratégie Multi-Tenant proposée (à valider avant Phase 1 détaillée)

Recommandation de départ, à confirmer/discuter en Phase 1 (avec options A/B comme l'exige la règle 55 du cahier des charges) :

- **Schéma partagé, `company_id` sur les tables métier** (pas de base par société) — seule option réaliste sur l'hébergement OVH mutualisé actuel, et cohérente avec le mécanisme `ensure_schema()` déjà en place.
- **Table `companies` + table de jonction `user_company_roles`** (plutôt que `users.company_id` simple) dès le départ, comme demandé en §11 — évite une seconde migration plus tard si un utilisateur doit un jour appartenir à plusieurs sociétés (ex. RH groupe).
- **Tenant Context reconstruit côté serveur à chaque requête**, jamais depuis le frontend ni depuis un `company_id` du JWT sans revérification — en cohérence directe avec le pattern déjà utilisé par `current_user()`.
- **Migration en plusieurs étapes non destructives** (`company_id` nullable d'abord → mapping manuel avec le client → contrôle → NOT NULL ensuite), exactement comme demandé en §19-20, et réutilisant le pattern de migration additive `05_migration_*.sql` déjà établi dans ce projet.

---

## Ce qui n'a **pas** été fait dans cette phase (volontairement)

Conformément à la consigne « PHASE 0 — NE MODIFIER AUCUN FICHIER » : aucun fichier de code, de schéma ou de configuration n'a été créé ou modifié. Ce document est purement analytique.

## Prochaine étape proposée

Passer à la **Phase 1 — Architecture cible** (`ARCHITECTURE_WORKVOICE_V2.md`) : je présenterai le schéma cible détaillé (tables, flux Tenant Context, RBAC) avec, sur les points structurants (notamment le modèle `users`/`companies`/`user_company_roles` et le devenir de la numérotation/notifications globales), les options A/B demandées par la règle de validation (§55) avant toute écriture de migration.

Étant donné l'ampleur du projet (17 phases, 14 documents livrables, transformation d'une base de production réelle), je recommande de **valider cette Phase 0 et les grandes orientations de la Phase 1 avec vous avant d'écrire la moindre ligne de migration SQL** — c'est cohérent avec la méthode de travail que vous avez vous-même définie dans le cahier des charges.
