# PROJECT_STATE — WORKMAN ERP 360

Registre d'avancement. Mis à jour à chaque lot. Un lot n'est « terminé » que si ses critères sont démontrés par des tests réellement exécutés.

Dernière mise à jour : 21 octobre 2026 (ajout du programme Sales Bot, §9, et de ADR-002).

## 1. Objectif
Construire WORKMAN ERP 360 pour WORKMAN, STID EXPORT, MB CONFECTION et SOMICO, à partir du dépôt existant, sans réécriture générale et sans perte de capacités utiles.

## 2. Constat de l'existant (audit AUD-001 à AUD-003, partiel)

### 2.1 Dépôt
- Git : dépôt à la racine `remotion`. Le projet `MB-CONFECTION-ERP` est suivi depuis le commit `572026b` (branche `master`).
- Aucun remote configuré : rien n'est poussé.
- Changements non commités d'autres projets présents dans le même dépôt (workvoice, stid-crm…). Non traités ici.
- `CLAUDE.md` absent avant ce lot ; créé à la racine du projet.

### 2.2 Base locale (`supabase_db_mb-confection-erp`)
- 130 tables dans `public`.
- Sociétés : **1** (`MB Confection`, colonnes `id, name, legal_id, country, created_at`). WORKMAN, STID EXPORT et SOMICO ne sont pas créées.
- Sites : table `sites` **absente**.
- Entrepôts : `warehouses`, `stock_locations`, `warehouse_locations`, `user_warehouses` présents.
- Rôles : 8 (`admin, direction, commercial, qualite, achat, production, magasin, finance`).
- Permissions : 79.
- Registre des migrations (`supabase_migrations.schema_migrations`) : versions **0001 à 0027** seulement.

### 2.3 Migrations
- Fichiers présents : **0001 à 0031** (`supabase/migrations/`).
- **Écart de réconciliation** : 0028 (hook de jeton), 0029 (règle TVA export), 0030 (taux de TVA versionnés), 0031 (grand livre) ne sont pas dans le registre. Leurs effets ont été vérifiés par les tests du projet, mais le registre n'a pas été mis à jour. À réconcilier par un lot dédié, après vérification de chaque effet.

### 2.4 Capacités existantes (conservées)
- Clients : liste, fiche, création, modification, archivage, restauration, suppression, contacts, adresses. **Migré vers l'API** (commit `572026b`).
- Auth Supabase, RLS, fonctions `private.*`, journal d'audit (`private.write_audit`), numérotation (`private.next_seq`).
- Modules web précédemment livrés : ventes, achats, stocks, production/MRP, qualité, expédition, finance, grand livre, copilote, administration.
- Écart global connu : `docs/MATRICE_ECARTS_CDC.md` — 169 exigences : 13 conformes, 79 partielles, 58 absentes, 7 non vérifiées, 12 non réalisées.

### 2.5 Écarts d'architecture (ADR-001, toujours ouverts)
- Redis (cache), MinIO (stockage des fichiers), PWA et hors ligne, CORS pour les appels navigateur.
- Rôle PostgreSQL à privilèges minimaux pour l'API (aujourd'hui : compte `postgres` en développement).
- Tests PHPUnit ; image de production sans dépendances de développement ; OpenAPI généré depuis le code.
- ShadCN, TanStack Query, Zustand non adoptés.
- Les onglets 360° des autres modules (commandes, factures, GED, articles, nomenclatures, réclamations, performance, marge) lisent encore la base directement.

## 3. Points ouverts (CDC §12.13 et données manquantes)
Ces points bloquent les paramètres concernés, pas l'audit.

| ID | Point | Bloque |
|---|---|---|
| OPEN-01 | Raison sociale, identifiant légal, pays et devise de WORKMAN, STID EXPORT, SOMICO | Création des sociétés (lot 1) |
| OPEN-02 | Sites, ateliers, boutiques et entrepôts par société | Table `sites` et rattachements (lot 1) |
| OPEN-03 | Fiscalité, régimes douaniers et conventions RH par société | Règles TVA/douane/paie (lots ultérieurs) |
| OPEN-04 | Flux intersociétés et devise fonctionnelle de chaque société | Documents réciproques (V2) |
| OPEN-05 | ~~Accord sur la réconciliation du registre des migrations 0028–0031~~ | **Clos** : accord du propriétaire, réconciliation effectuée (§6) |
| OPEN-06 | Jeu de données anonymisé pour la référence de non-régression (AUD-004) | Preuves avant/après |

## 4. Plan de lots

| Lot | Contenu | CDC | Statut |
|---|---|---|---|
| L0 | Audit, registre, règles (`CLAUDE.md`) | AUD-001 à AUD-003 (partiel), 12.12 | **En cours** : registre et règles créés ; table des données et jeu de référence restent à faire |
| L1 | Sociétés (4), sites, rattachement des droits par société, sélection de société active, séparation des droits prix/marge/paie/banque/export/approbation | ORG-001, ORG-002, 9.2, 9.3 | **Structure préparée** (migration `0032_company_structure`, tests `company-structure.test.mjs`) ; **reste ouvert** : données des 4 sociétés (OPEN-01), sites réels (OPEN-02), sélection de société active (ORG-001), séparation des droits prix/marge/paie/banque/export/approbation, API et écrans |
| L2 | ~~Réconciliation des migrations 0028–0031~~ (fait), rôle PostgreSQL minimal pour l'API, CORS | Architecture (ADR-001) | Réconciliation **faite** ; rôle et CORS restent à faire |
| L3 | Entrepôts par site, périmètre responsable entrepôt sur tous les canaux | 3.4, 9.2 | Après L1 |

## 5. Décisions prises
- Stack : Laravel 12 API uniquement, Next.js 15 frontend, Supabase Auth, PostgreSQL avec RLS (ADR-001).
- Migration progressive, module par module ; pilote : clients (terminé côté API et écran).
- Aucune migration destructive ; tout changement de schéma est additif et versionné.
- Le commit `572026b` est local ; aucun push tant que le remote n'est pas fourni.

## 6. Tests réellement exécutés (lot L0)
- `npx tsc --noEmit` (web) : sans erreur, exécuté après le renommage du produit.
- `api/tests/smoke/clients.sh` : 45/45 réussis, exécuté pendant le lot clients (avant ce lot).
- Vérification navigateur : titre « WORKMAN ERP 360 » et marque affichés (après renommage).
- Requêtes d'inspection sur la base locale : décompte des sociétés, tables, rôles, permissions, registre des migrations.
- Aucun test de sécurité négative multi-société : **non réalisé**, dépend de L1.

### Réconciliation du registre des migrations (OPEN-05, exécutée)
- Vérification avant insertion, sur la base locale : chaque objet créé par 0028, 0029, 0030 et 0031 existe (fonctions, tables, triggers, colonnes de `vat_rates`, garde `client_id` du hook). Résultat : aucun objet manquant.
- Insertion additive de 4 lignes dans `supabase_migrations.schema_migrations` (0028 `access_token_hook_fix`, 0029 `export_vat_rule`, 0030 `vat_rates_versioned`, 0031 `general_ledger`), en une transaction, `ON CONFLICT DO NOTHING`. Le champ `statements` contient le texte complet du fichier.
- Résultat : registre à **31 lignes**, pour 31 fichiers de migration. Aucune ligne existante modifiée, aucun schéma modifié.
- Retour arrière : supprimer les 4 lignes 0028 à 0031 du registre (le schéma n'est pas touché).
- Limite : la vérification porte sur l'existence des objets, pas sur le corps de chaque fonction ; les tests SQL du lot 0031 ont été exécutés lors de son développement.

### Lot L1 — structure (21 octobre 2026)
- Fichiers : `supabase/migrations/0032_company_structure.sql` (nouveau), `web/tests/sql/company-structure.test.mjs` (nouveau), `web/package.json` (script `test:sql` complété).
- Contenu additif : `companies.currency` (vide), table `sites` (RLS, audit, pas de suppression physique), table `user_companies` (reprise des profils actuels, trigger de cohérence avec `profiles.company_id`), `warehouses.site_id` nullable avec clé composite (site et entrepôt de la même société), permissions `sites.read` et `sites.manage`.
- Ce qui n'a pas changé : `private.current_company()`, `profiles.company_id`, politiques existantes, données existantes.
- Tests exécutés (PGlite, `npm run test:sql`) : **1 839 PASS, 0 FAIL** (1 808 existants + 31 nouveaux). Avant la migration : 1 808 PASS, 0 FAIL.
- `npx tsc --noEmit` (web) : sans erreur.
- API `sites` ajoutée : `api/app/Http/Controllers/Api/V1/SiteController.php`, `api/app/Http/Requests/SiteRequest.php`, routes `/api/v1/sites` (liste, fiche, création, modification, archivage, restauration). La société vient de `private.current_company()`, jamais du corps de la requête. Vérification : `php -l` sans erreur sur les 3 fichiers.
- Non réalisé : application de la migration sur la base locale `supabase_db_mb-confection-erp` (port 54322 injoignable depuis cet environnement) ; démarrage de l'API et smoke test `sites` (Docker arrêté ; l'API exige PHP 8.4, l'environnement a PHP 8.3, `composer install` refusé) ; contrat OpenAPI des sites.
- Limites : `sites` ne porte pas encore de type de site (à confirmer, OPEN-02) ; la devise reste vide (OPEN-04) ; un utilisateur ne peut encore être rattaché qu'à une seule société active (`profiles.company_id`) tant que ORG-001 n'est pas livré.
- Retour arrière : la migration est additive ; retirer les objets créés (`warehouses.site_id`, `sites`, `user_companies`, colonne `companies.currency`, permissions `sites.*`) si elle doit être annulée avant toute donnée saisie.

## 7. Limites connues
- Une seule société existe en base ; les règles multi-sociétés ne sont pas testables tant que L1 n'est pas livré.
- Les environnements de recette, sauvegardes et PRA ne sont pas vérifiés ici.
- Les résultats de la matrice d'écarts (169 exigences) ne sont pas recalculés dans ce lot.

## 8. Prochain lot
**L0 finalisation, puis L1** :
1. Obtenir OPEN-01 et OPEN-02 (données de sociétés et sites). Sans elles, aucune société n'est créée.
2. Préparer la structure de L1 de façon additive (table `sites`, colonnes de société sur les rattachements utilisateur) et la tester sur la base locale.
3. Décider OPEN-05 : réconcilier le registre des migrations maintenant.

## 9. Programme WORKMAN Sales Bot AI (ADR-002, proposé le 21 octobre 2026)

Source : `WORKMAN_SALES_BOT_AI_Blueprint.md` v1.0. Le programme est **proposé, non accepté** : D2 à D4 de l'ADR doivent être tranchées avant B1. D1 (backend) est tranchée : Laravel 12.

| Lot | Contenu | Dépend de | Statut |
|---|---|---|---|
| B0 | Cadrage : décisions D1 à D8, glossaire, jeu de cas FR/AR/EN, inventaire des données, mémo juridique | L0 | **Non démarré** |
| B1 | MVP : conversations, consentements, demande de devis sans prix ferme, boîte commerciale et escalade, FAQ RAG approuvée, widget Web, WhatsApp, audit | L1, L2, B0, D3 pour le pilote public | **Bloqué** pour l'activation publique. Bulle d'accueil (script autonome, inactive par défaut) livrée côté interface, voir ci-dessous |

### Bulle « Assistant Workman » (21 octobre 2026)
- Fichiers : `web/public/assistant/workman-assistant.js`, `web/public/assistant/README.md`.
- Cible : www.workman-stid.com (domaine non résolu depuis l'environnement de développement ; plateforme du site non vérifiée).
- Inactive par défaut (`enabled: false`), aucun appel réseau, aucune conversation : elle n'affiche qu'un message d'information et un lien de contact configurable. Français, anglais et arabe (RTL). Shadow DOM.
- Vérifications : 16 contrôles navigateur (Chromium headless, pages de test hors dépôt) réussis, 0 échec. Captures vérifiées.
- Activation publique interdite tant que D9 (moteur IA, modèle à choisir) et D3 (transferts de données) ne sont pas tranchés.
- Non fait : branchement à `POST /v1/conversations`, consentement, file de reprise humaine, hébergement du dossier `assistant/` (à confirmer).
| B2 | Smart Sales : CRM limité, déduplication, scoring explicable, Outlook et Teams | B1, D6 | Non démarré |
| B3 | Commerce IA : tarifs, disponibilité, adaptateurs ERP et BAT | B2, L3, migration Articles et prix vers l'API, D2 | Non démarré |
| B4 | Plateforme IA : Insight réconcilié, quotas, ROI mesuré, audit indépendant | B3 | Non démarré |

Points bloquants pour B1 : D2 (ERP cible), D3 (transferts hors Tunisie, juridique), D4 (Product Owner), D5 (= OPEN-01 et OPEN-02), D6 (comptes Meta et Microsoft), D7 (règles EPI pilotes), D8 (budget), D9 (moteur IA).

Règle de départ : aucun code de bot avant L1. Les modèles IA ne sont pas choisis (« à confirmer »). Aucun engagement autonome (devis ferme, commande, remise exceptionnelle) : validation humaine.

**Prochain lot réel : L1 suite** (sélection de société active ORG-001, séparation des droits, API `sites` et `user_companies`), une fois OPEN-01 et OPEN-02 fournis pour les données. Application de `0032` sur la base locale à faire dès que la base est joignable.
