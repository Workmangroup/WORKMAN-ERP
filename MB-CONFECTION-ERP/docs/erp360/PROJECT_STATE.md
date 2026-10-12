# PROJECT_STATE — WORKMAN ERP 360

Registre d'avancement. Mis à jour à chaque lot. Un lot n'est « terminé » que si ses critères sont démontrés par des tests réellement exécutés.

Dernière mise à jour : 12 octobre 2026.

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
| L1 | Sociétés (4), sites, rattachement des droits par société, sélection de société active, séparation des droits prix/marge/paie/banque/export/approbation | ORG-001, ORG-002, 9.2, 9.3 | **Structure préparée** (migration 0032, §6bis). Bloqué par OPEN-01 et OPEN-02 pour les données (sociétés et sites réels), ainsi que pour l'écran, le journal et les tests multi-sociétés |
| L2 | ~~Réconciliation des migrations 0028–0031~~ (fait), ~~rôle PostgreSQL minimal pour l'API~~ (fait, migration 0033), CORS | Architecture (ADR-001) | Réconciliation et rôle **faits** ; CORS : pas requis tant que le navigateur n'appelle pas l'API directement (voir §6ter) |
| L3 | Entrepôts par site, périmètre responsable entrepôt sur tous les canaux | 3.4, 9.2 | Après L1 |

## 5. Décisions prises
- Stack : Laravel 12 API uniquement, Next.js 15 frontend, Supabase Auth, PostgreSQL avec RLS (ADR-001).
- Migration progressive, module par module ; pilote : clients (terminé côté API et écran).
- Aucune migration destructive ; tout changement de schéma est additif et versionné.
- Le commit `572026b` est local ; aucun push tant que le remote n'est pas fourni.

## 6. Tests réellement exécutés (lot L0)
- `npx tsc --noEmit` (web) : sans erreur, exécuté après le renommage du produit.
- `api/tests/smoke/clients.sh` : 41/41 réussis (la suite compte 41 contrôles ; une première version de ce registre annonçait « 45 », erreur de comptage corrigée), exécuté pendant le lot clients et de nouveau au §6ter après le passage au rôle `workman_api`.
- Vérification navigateur : titre « WORKMAN ERP 360 » et marque affichés (après renommage).
- Requêtes d'inspection sur la base locale : décompte des sociétés, tables, rôles, permissions, registre des migrations.
- Aucun test de sécurité négative multi-société : **non réalisé**, dépend de L1.

### Réconciliation du registre des migrations (OPEN-05, exécutée)
- Vérification avant insertion, sur la base locale : chaque objet créé par 0028, 0029, 0030 et 0031 existe (fonctions, tables, triggers, colonnes de `vat_rates`, garde `client_id` du hook). Résultat : aucun objet manquant.
- Insertion additive de 4 lignes dans `supabase_migrations.schema_migrations` (0028 `access_token_hook_fix`, 0029 `export_vat_rule`, 0030 `vat_rates_versioned`, 0031 `general_ledger`), en une transaction, `ON CONFLICT DO NOTHING`. Le champ `statements` contient le texte complet du fichier.
- Résultat : registre à **31 lignes**, pour 31 fichiers de migration. Aucune ligne existante modifiée, aucun schéma modifié.
- Retour arrière : supprimer les 4 lignes 0028 à 0031 du registre (le schéma n'est pas touché).
- Limite : la vérification porte sur l'existence des objets, pas sur le corps de chaque fonction ; les tests SQL du lot 0031 ont été exécutés lors de son développement.

### 6bis. Migration 0032 — structure des sites (lot L1, préparation)
- Fichier : `supabase/migrations/0032_sites.sql`. Additive : table `public.sites` (société, code, nom, ville, adresse, archivage), colonne `warehouses.site_id` nullable, sans reprise de données.
- Règles en base : code unique par société et au format `^[A-Z0-9][A-Z0-9_-]{1,19}$` ; un entrepôt ne peut être rattaché qu'à un site de sa société (erreur `SITE_COMPANY_MISMATCH`).
- Droits : lecture avec `stock.read`, écriture avec `warehouses.manage` (droits existants). Refus par défaut : pas de grant pour `anon`, RLS par société.
- Application : sauvegarde du schéma avant application (`scratchpad/pre_0032_schema.sql`, 40 114 lignes) ; application dans une transaction ; ligne de registre 0032 ajoutée. Le registre compte maintenant **32 lignes** pour **32 fichiers**.
- Tests réellement exécutés (transaction annulée, base locale) : 8 contrôles réussis — normalisation, doublon refusé, code invalide refusé, rattachement même société, site d'une autre société refusé, rattachement intact après refus, aucun site visible sans session, `anon` refusé. Après annulation : 0 site, 1 société (aucune donnée résiduelle).
- Entrepôts existants : 10, tous sans site (`site_id` vide). Aucun entrepôt n'a été réaffecté.
- Non fait dans ce lot : écran et API des sites, journal d'audit des sites, rattachement des utilisateurs à une société, tests PGlite du fichier, mise à jour du bundle de déploiement `deploy/`.
- Retour arrière : procédure documentée dans l'en-tête de la migration (suppression des nouvelles structures uniquement).
- Décision à valider : le droit `warehouses.manage` sert aussi à gérer les sites. Si le propriétaire veut un droit dédié (`sites.manage`), il faut l'ajouter au catalogue des droits.

### 6ter. Migration 0033 — compte PostgreSQL de l'API (lot L2)
- Fichier : `supabase/migrations/0033_api_role.sql`. Crée le rôle `workman_api` (connexion, sans superutilisateur, sans création de rôle ni de base, sans contournement de la RLS, `noinherit`), membre de `authenticated`, avec `connect` sur la base. Aucun objet existant modifié.
- Mot de passe : généré aléatoirement, défini par `alter role`, écrit dans `api/.env` (ignoré par git). Aucun mot de passe dans le dépôt ni dans ce registre.
- `api/.env` : `DB_USERNAME=workman_api`. `api/.env.example.workman` mis à jour (mot de passe vide).
- Application : transaction avec ligne de registre 0033 (registre : 33 lignes pour 33 fichiers). Une première tentative a échoué à cause d'une instruction `execute` hors bloc : transaction annulée, rien appliqué, puis réappliqué.
- Tests réellement exécutés :
  - `GET /api/v1/health` avec le nouveau compte : `ok` / base `up`.
  - `api/tests/smoke/clients.sh` : **41/41 réussis** (la suite compte 41 contrôles).
  - Droits du rôle (transaction annulée, administrateur `supabase_admin`) : lecture directe de `clients` refusée ; création de table refusée ; passage par `authenticated` sans session : 0 ligne visible.
- CORS : non appliqué. L'écran Next.js appelle l'API côté serveur (server actions, `apiGet`/`apiWrite`) ; le navigateur n'appelle pas l'API directement. À ouvrir avec les premiers appels navigateur, avec une liste d'origines explicite.
- Limite : le mot de passe local est dans `api/.env` ; la production exigera un coffre de secrets (non traité ici).
- Note technique : dans la stack locale, `postgres` n'est pas superutilisateur ; les tests d'administration utilisent `supabase_admin`.

## 7. Limites connues
- Une seule société existe en base ; les règles multi-sociétés ne sont pas testables tant que L1 n'est pas livré.
- Les environnements de recette, sauvegardes et PRA ne sont pas vérifiés ici.
- Les résultats de la matrice d'écarts (169 exigences) ne sont pas recalculés dans ce lot.

## 8. Prochain lot
**L0 finalisation, puis L1** :
1. Obtenir OPEN-01 et OPEN-02 (données de sociétés et sites). Sans elles, aucune société n'est créée.
2. Préparer la structure de L1 de façon additive (table `sites`, colonnes de société sur les rattachements utilisateur) et la tester sur la base locale.
3. Décider OPEN-05 : réconcilier le registre des migrations maintenant.

## 9. Lot P001 — Inventaire réel du dépôt (lecture seule)
- Livrable : `docs/erp360/inventaire/INVENTAIRE_P001.md` (modules, routes, services, tables, droits, tests, écarts P0/P1/P2, inconnues).
- Mesures : 139 pages web, 27 dossiers de domaine, 18 routes API protégées, 125 tables, 290 politiques RLS, 79 permissions, 8 rôles.
- Constat P0 principal : 544 appels `.from(` et 171 `.rpc(` dans le frontend ; une seule route API métier (clients). Aucune tâche planifiée. Pas de MFA ni de SSO. Pas de sélecteur de société.
- Tests exécutés : web SQL 1 808/1 808 ; web unitaires 168/168 ; API PHPUnit 1 échec sur 2 (test par défaut de Laravel).
- Absence de mutation : aucun fichier source modifié ; requêtes de catalogue en `SELECT` uniquement.
- Lot P003 (backlog) suspendu ; ses fichiers de travail restent non suivis dans `docs/erp360/backlog/`.

## 10. Lot P002 — Démarrage sur socle existant
- Constat : ERP existant (Next.js, Laravel API seule, Supabase). Pile conservée ; aucun remplacement ; NestJS non introduit (décision Laravel, ADR-001).
- Ajouts : `docker-compose.dev.yml` (API en conteneur, healthcheck), `scripts/check-health.sh` (5 contrôles), `docs/erp360/DEMARRAGE.md` (variables sans valeurs, environnements, démarrage, preuves).
- Preuves : API conteneur `healthy` ; `/api/v1/health` = ok / base up ; web `/login` = 200 ; `check-health.sh` = 5/5 PASS (code 0) ; test négatif avec API absente = 3 FAIL (code 1).
- Sécurité : aucune clé réelle dans les fichiers ajoutés ni dans les fichiers suivis ; `SUPABASE_SERVICE_ROLE_KEY` lue seulement côté serveur.
- Environnements test, préproduction et production : non créés (décision à prendre).

## 11. Lot P003 — Backlog exécutable et traçabilité (cadrage)
- Livrables : `docs/erp360/backlog/` (BACKLOG.csv, BACKLOG.md, PLAN_P003.md, guide_mapping.tsv, enrichment_1..4.tsv, extract_matrix.mjs, build_backlog.mjs).
- Mesures : 169 lignes de la matrice extraites (réconciliées avec sa synthèse) + 12 critères ACC + 1 user story = **181 éléments** ; **89 P0** tous tracés ; **126/126** identifiants du CDC couverts.
- Contrôles (`build_backlog.mjs`) : 0 doublon d'identifiant, 0 acteur/responsable/lot/estimation/Given-When-Then manquant, 0 dépendance invalide, 0 P0 non relié au guide, 0 identifiant cité par le guide inconnu. Code de sortie 0.
- Doublons : 19 relevés (PLAN_P003 §4), aucun supprimé ; chacun a un propriétaire.
- Décisions à obtenir : 14 (PLAN_P003 §6), dont périmètre V1 et pilote (D-01) et traitement de 11 P0 planifiés hors V1 (D-02).
- Non produit faute de données : planning 36 mois, budget révisable, business case, dossier G0, pilote. Estimations en jours-personnes = hypothèses non validées.
- Non commité.

## 12. Référence de non-régression (AUD-004)
- `scripts/non-regression.sh` rejoue les suites et contrôles et compare à `docs/erp360/non-regression/baseline.json` (référence du 12 octobre 2026 : 1 808 SQL, 168 unitaires, 5 santé, 41 smoke, 125 tables, 290 politiques, 0 table sans RLS, 33 migrations).
- Preuves : comparaison contre la référence = aucune régression (code 0). Référence volontairement faussée = 6 régressions détectées (code 1).
- Constat au passage : un jeton de test expiré faisait échouer le smoke ; le script signale désormais un jeton expiré comme état non vérifié, pas comme échec applicatif.
- Limite : les jeux anonymisés de référence (AUD-004) ne sont pas constitués (aucune copie autorisée).

## 13. Lot P004 — Architecture et contrats de domaines
- Livrables : `docs/erp360/architecture/ARCHITECTURE_P004.md` (frontières, sources de vérité, contrats, événements, BI/IA, décisions ADR-002 à ADR-006, diagrammes Mermaid), `ownership.json`, `domain-deps.baseline.json`, `scripts/check-domain-deps.mjs`.
- Mesures : 27 modules, 70 dépendances entre modules, 125 tables attribuées à un seul domaine (0 orpheline, 0 double).
- Constat : 1 cycle de module connu (`auth` ↔ `rbac`, décision D-P004-01, non traité) ; un cycle de domaine `Ventes ↔ Production` non visible au niveau des modules.
- Preuves : garde-fou conforme sur l'état actuel ; test négatif (2 arêtes, 1 cycle, 1 module introduits dans une copie) détecté, code 1.
- Aucun code métier, schéma ni donnée modifié. Non commité.

## 14. Lot P005 — Référence de non-régression métier
- Livrables : `docs/erp360/non-regression/SCENARIOS.md` (10 scénarios obligatoires du cahier avec statut réel ; 24 scénarios métier ; 6 défauts connus marqués comme défauts), `snapshot-local.json` (photographie lecture seule).
- Vérifié : chaque libellé et code d'erreur cité existe dans son fichier de test (11 libellés et 7 codes contrôlés).
- Statuts : 4 scénarios obligatoires vérifiés (dont 1 rejoué au lot précédent), 2 défauts (quarantaine non bloquante au picking ; accord après changement de devis), 4 non implémentés (mobile hors ligne, webhook paiement, IA avec PDF, rollback).
- Limites : données de développement, pas de copie de production ni anonymisée autorisée ; attendus finance et paie **non signés** ; paie non implémentée.
- Aucun historique effacé : seule une photographie est ajoutée. Non commité.
