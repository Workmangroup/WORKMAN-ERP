# PROJECT_STATE — WORKMAN ERP 360

Registre d'avancement. Mis à jour à chaque lot. Un lot n'est « terminé » que si ses critères sont démontrés par des tests réellement exécutés.

Dernière mise à jour : 12 octobre 2026 (lots L1 et P011).

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
| L1 | Sociétés (4), sites, rattachement des droits par société, sélection de société active, séparation des droits prix/marge/paie/banque/export/approbation | ORG-001, ORG-002, 9.2, 9.3 | **En cours** : structure des sites préparée (migration 0032, tests PGlite 26/26). Données bloquées par OPEN-01/02. Restent : sociétés multiples par utilisateur, sélecteur de société active, séparation des droits prix/marge/paie/banque/export/approbation |
| L2 | ~~Réconciliation des migrations 0028–0031~~ (fait), rôle PostgreSQL minimal pour l'API, CORS | Architecture (ADR-001) | Réconciliation **faite** ; rôle et CORS restent à faire |
| L3 | Entrepôts par site, périmètre responsable entrepôt sur tous les canaux | 3.4, 9.2 | Après L1 |
| P011 | Délégations datées et bornées ; séparation des tâches (paiement, dérogation, lot critique) ; dérogations à second contrôle | SEC-03, matrice 8.10 et 9 | **Livré côté base et écrans, à valider en navigateur** (voir §6) |

## 5. Décisions prises
- Lot L1 (structure des sites, migration 0032) :
  - Types de site : `site`, `workshop` (atelier), `shop` (boutique) ; les entrepôts restent dans `warehouses`, rattachés optionnellement à un site (`warehouses.site_id`). Choix technique, à confirmer par le propriétaire avec OPEN-02.
  - Clé composite `(company_id, site_id)` : un entrepôt ne peut être rattaché qu'à un site de sa propre société.
  - Pas de suppression physique des sites (archivage seulement). Code `SIT-nn` généré et immuable pour le client (privilèges par colonne).
  - Permissions `sites.read` et `sites.manage` : admin = lecture + gestion, direction = lecture seule.
  - Aucun site n'est créé par la migration (OPEN-02 non fourni).
- Stack : Laravel 12 API uniquement, Next.js 15 frontend, Supabase Auth, PostgreSQL avec RLS (ADR-001).
- Migration progressive, module par module ; pilote : clients (terminé côté API et écran).
- Aucune migration destructive ; tout changement de schéma est additif et versionné.
- Le commit `572026b` est local ; aucun push tant que le remote n'est pas fourni.

## 6. Tests réellement exécutés

### Lot P011 — délégations et séparation des tâches (migration 0033)
- Fichiers : `supabase/migrations/0033_delegations_sod.sql` (additive, sauf `create or replace` de `quality_inspection_decide`, reprise de 0020 avec les contrôles ajoutés) ; `web/tests/sql/delegations.test.mjs` (51 assertions) ; `web/tests/sql/rbac.test.mjs` (liste de migrations complétée jusqu'à 0033, 63/63) ; `web/src/features/governance/` (erreurs, actions, lecture, formulaires) ; `web/src/app/(erp)/governance/page.tsx` ; entrée de menu (groupe Finance) ; catalogue `web/src/lib/rbac/permissions.ts` (+ `sites.*`, `delegations.*`, `payments.*`, `derogations.*`).
- Critères demandés, tous démontrés par `delegations.test.mjs` : délégation expirée refusée (`DELEGATION_EXPIRED`, après attente réelle de 3 s) ; délégation pas encore active refusée ; auto-approbation bloquée (préparateur d'un ordre de paiement, demandeur d'une dérogation, approbateur ou demandeur ne contrôlent pas la dérogation, contrôleur qui a ouvert ou saisi les défauts d'un lot critique) ; décisions auditées (`payment_order.*`, `derogation.*`, `delegation.*`, `quality.mark_critical`, `quality.inspection_decide`).
- Défense en profondeur : contraintes CHECK en base (`decided_by <> prepared_by`, `approved_by <> requested_by`, `control_by` distinct) vérifiées par écriture directe refusée.
- `npm run test:sql` (suite complète, 30 fichiers) : **1885 assertions réussies, 0 échec, code de sortie 0**. Comparaison avant/après : 1834 avant ce lot (fin de L1), 1885 après.
- `npm run test:unit` : OK (dont le contrôle de navigation et du menu).
- `npx tsc --noEmit` (web) : sans erreur.
- Non exécuté : vérification navigateur des écrans (pas de base locale : Docker absent) ; ESLint (la configuration du dépôt ignore ces fichiers, y compris le code existant : aucun résultat exploitable) ; application de 0033 sur la base Supabase locale.

### Lot L1 — structure des sites (migration 0032)
- Fichiers : `supabase/migrations/0032_sites.sql` (additive : table `sites`, colonne `warehouses.site_id`, permissions, RLS, audit, privilèges), `web/tests/sql/sites.test.mjs` (26 assertions), ajout dans le script `test:sql` de `web/package.json`.
- `node tests/sql/sites.test.mjs` (PGlite) : **26/26 réussis**. Couvre : aucune donnée créée ; permissions et rôles ; codes SIT-01/02 ; types et noms refusés ; code immuable ; refus par défaut (commercial, direction en lecture seule) ; archivage sans suppression physique ; isolation entre sociétés (lecture et écriture) ; rattachement d'entrepôt refusé hors société ; journal `site.create/update/archive/restore`.
- `npm run test:sql` (suite complète, 29 fichiers, dont le nouveau) : **1834 assertions réussies, 0 échec**, code de sortie 0.
- `npm run test:unit` : OK, code de sortie 0.
- Non exécuté : `npx tsc --noEmit` (aucun fichier TypeScript modifié) ; `api/tests/smoke/clients.sh` (pas de changement d'API) ; application de la migration sur la base locale Supabase (Docker absent dans cet environnement, port 54322 fermé).
- Retour arrière : la migration est additive. Pour la retirer : supprimer `warehouses.site_id` et la contrainte `warehouses_site_fk`, puis la table `sites` et les deux permissions (aucune donnée n'existe).

### Lot L0 (avant ce lot)
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

### P011 — suite : paiement par ordre approuvé, visibilité par délégation, lot critique (migration 0034)
- Décisions confirmées par le propriétaire et appliquées :
  1. `supplier_payment_record` refuse désormais (`PAYMENT_REQUIRES_APPROVED_ORDER`). Un règlement passe par `payment_order_execute` : ordre approuvé, exécutant ≠ préparateur (contrainte en base), droit `payments.execute`, solde et surpaiement revérifiés à l'exécution. Le corps d'origine est repris dans `private.supplier_payment_apply`.
  2. Délégués : `payment_orders` et `derogations` sont visibles par délégation active (RLS). L'écran est accessible à qui a un droit de gouvernance ou une délégation active (`governance_access`) ; la page refuse les autres.
  3. Lot critique : seul le responsable qualité (`quality.approve`) marque un contrôle critique ; l'écran liste les contrôles ouverts pour ce marquage.
- Fichiers : `supabase/migrations/0034_payment_execution.sql` ; tests `finance.test.mjs`, `general-ledger.test.mjs`, `multicurrency.test.mjs` (règlements via ordres approuvés, chargement de toutes les migrations) ; `delegations.test.mjs` (61 assertions, dont visibilité, accès et marquage critique) ; `rbac.test.mjs` (toutes les migrations) ; `web/src/features/governance/*`, `web/src/app/(erp)/governance/page.tsx`, `web/src/features/finance/actions.ts`, catalogue `permissions.ts`, menu.
- Tests : `npm run test:sql` complet : **1899 assertions réussies, 0 échec, code de sortie 0**. `npx tsc --noEmit` : sans erreur après la dernière modification web. `npm run test:unit` : OK.
- Non exécuté : vérification navigateur des écrans ; application de 0032–0034 sur la base locale.

### Application des migrations 0001–0034 sur PostgreSQL 16 réel (hors Supabase)
- Serveur PostgreSQL 16.15 local (binaires du système, cluster dans `/opt/pgreal`, hors dépôt), base vierge `erp360_real`.
- Bouchons `auth` et `storage` identiques à ceux du harnais PGlite (rôles anon / authenticated / service_role, `auth.uid()`, `auth.jwt()`).
- Les 34 fichiers appliqués dans l'ordre avec `ON_ERROR_STOP=1` : **aucune erreur**, 134 tables dans `public`.
- Objets vérifiés : `delegations`, `payment_orders` (contraintes de statut, de décision, d'exécution et de séparation des tâches), `derogations` (contrainte approved_by ≠ requested_by), `supplier_payment_record` (refus explicite), `payment_order_execute`, `governance_access`, permission `payments.execute`, table `sites`.
- Limite : ce n'est pas la stack Supabase (pas de GoTrue, pas de PostgREST) ; les comportements (refus, RLS par rôle) restent validés par les tests PGlite, pas sur ce serveur.

### P012 — journal d'audit et historisation (migration 0035)
- Socle conservé : `audit_logs` en ajout seul (triggers 0003), `write_audit` (signature inchangée, 254 appels), historiques par module (politiques RLS), versions figées (articles, nomenclatures, GED), journal d'authentification.
- Ajouts : `correlation_id` (une action = un identifiant ; en-tête `x-correlation-id` accepté), `actor_kind` (user / delegate / system), `delegation_id` et `on_behalf_of` (acteur réel = `actor_id`), `entity_version` (rang par entité, verrouillé), `significant`, `reason`, `scope`.
- Minimisation : secrets, IBAN, paie et clés API masqués à l'écriture ; actions de prix et de coût visibles seulement avec `costs.read` (politique RESTRICTIVE, en plus des politiques par module) ; prix masqués dans les autres actions à la lecture de `audit_search` ; IP et navigateur seulement dans l'export auditeur.
- Export auditeur : `audit_export` (permission `audit.export`, admin et direction), journalisé comme action `audit.export`. L'écran n'affiche le lien que pour ce droit.
- Protection : modification et suppression refusées à tous (privilèges et trigger AUDIT_IMMUTABLE, y compris propriétaire) ; insertion directe refusée ; IP et navigateur non lisibles directement.
- Fichiers : `supabase/migrations/0035_audit_traceability.sql` ; `web/tests/sql/audit.test.mjs` (32 assertions) ; `web/src/features/rbac/services/audit-query.service.ts`, `audit-columns.ts`, `types.ts` ; route `admin/audit/export` ; écran `admin/audit` ; `ged.service.ts` (colonnes explicites) ; catalogue `permissions.ts` ; `rbac.test.mjs` (toutes les migrations).
- Tests : `npm run test:sql` complet : **1931 assertions réussies, 0 échec, code de sortie 0** ; `npm run test:unit` OK ; `npx tsc --noEmit` sans erreur. Migrations 0001–0035 appliquées sans erreur sur PostgreSQL 16 réel (8 colonnes de traçabilité, politique restrictive présente).
- Non exécuté : vérification navigateur de l'écran et de l'export ; application sur la stack Supabase.
- Limites : les refus ne sont pas journalisés (transaction annulée, comme avant) ; le motif n'est pas obligatoire pour les approbations existantes (seulement pour les nouvelles décisions P011) ; `entity_version` est un rang de ligne (pas un numéro métier de version) ; le masquage des secrets est au niveau des clés de premier niveau ; les historiques par module lisent encore la table directement (lecture filtrée par RLS) ; les actions de prix d'autres modules dont le nom ne contient pas « price », « cost » ou « costing » ne sont pas couvertes par la politique restrictive.

### P013 — interface commune et expérience utilisateur (migration 0036)
- Existant conservé : shell et barre latérale, navigation par droits (`NAV_TREE`), recherche rapide des écrans, table de données (tri, filtres, colonnes, pagination, exports), composants UI.
- Ajouts : fil d'Ariane (`breadcrumbTrail`, dérivé de la navigation, sans modifier les écrans) ; lien d'évitement « Aller au contenu » ; société active affichée dans la barre (nom lu sous `companies_select`) ; pages `loading`, `error` (message en français, sans détail technique, « Réessayer » et retour à l'accueil) et `not-found` pour la zone authentifiée ; recherche rapide étendue aux fiches clients, fournisseurs et articles (`global_search`, permission par type, société active, archives exclues quand elles existent, caractères spéciaux échappés) ; recherche rapide visible sur mobile.
- Filtres sauvegardés : `saved_views`, par utilisateur, par table, en base (RLS « propriétaire seul », contenu validé : objet JSON, 4 Ko au plus). Les vues créées dans le navigateur sont reprises une seule fois, puis effacées.
- Fichiers : `supabase/migrations/0036_ui_views_search.sql` ; `web/src/lib/navigation/tree.ts` (fil d'Ariane) ; `web/src/components/layout/{breadcrumbs,app-shell,quick-search}.tsx` ; `web/src/components/data/data-table.tsx` (vues en base) ; `web/src/app/(erp)/{layout,loading,error,not-found}.tsx` ; tests `web/tests/sql/ui.test.mjs` (19 assertions) et `web/tests/unit/breadcrumbs.test.mjs` (7 assertions).
- Tests : `npm run test:sql` complet : **1950 assertions réussies, 0 échec, code de sortie 0** ; `npm run test:unit` OK ; `npx tsc --noEmit` sans erreur ; migrations 0001–0036 appliquées sans erreur sur PostgreSQL 16 réel (tables `saved_views`, fonction `global_search`).
- Non vérifié : parcours navigateur, clavier réel, contraste mesuré, rendu mobile ; le serveur web n'a pas été démarré (pas de base locale).
- Décision : anglais et arabe non implémentés, faute de confirmation ; les libellés restent en français dans les composants (à extraire dans un catalogue si la localisation est confirmée).
- Limites : les écrans à liste propre (tables ad hoc) n'utilisent pas encore la vue en base ; `global_search` ne couvre pas commandes, factures, ni documents GED ; la recherche de fiches n'est pas journalisée (lecture courante) ; le fil d'Ariane ne connaît pas le nom des fiches (libellé « Fiche »).

### P014 — fichiers et documents partagés (migration 0037)
- Socle conservé : GED (0005) : dossiers, documents, versions immuables, bucket privé `ged` (25 Mo), contrôle des signatures de fichiers à l'envoi, journal d'accès, corbeille.
- Types : liste blanche MIME au niveau du bucket. **SVG exclu** (contenu actif) : décision à confirmer par le propriétaire.
- Analyse antivirus : table `ged_version_scans` (les versions restent immuables). Toute nouvelle version est « pending » : quarantaine explicite, aucun téléchargement ni lien. Seul le service d'analyse (`ged_record_scan`, service_role) passe une version à « clean » ou « infected » ; une empreinte annoncée différente de celle calculée donne « error ». **Aucun moteur antivirus n'est installé ici** : aucune version nouvelle ne sera publiée tant qu'il n'est pas branché. Les versions antérieures au lot sont « legacy_unscanned » : publiées, signalées comme non analysées.
- Téléchargement : `ged_download_check` revérifie à chaque appel les droits sur le document parent, la fiche client et l'état de publication. La route `ged/files` l'utilise.
- Liens temporaires : `ged_share_links`, jeton de 128 caractères hexadécimaux affiché une fois, seule son empreinte est stockée, 1 à 168 heures, révocables. `ged/link/[token]` revérifie à chaque ouverture les droits de la personne qui ouvre, l'expiration et la révocation.
- Rétention : `ged_retention_rules` par catégorie ; durée et base légale saisies par `documents.retention` ; une catégorie sans durée validée reste « à confirmer » et n'est jamais comptée en échéance. **Aucune suppression automatique.** Les durées sont à valider par le propriétaire (non inventées).
- Fichiers : `supabase/migrations/0037_documents_security.sql` ; `web/src/features/ged/services/download.ts` ; routes `ged/files/[versionId]` et `ged/link/[token]` ; action `createShareLinkAction` ; bouton « Lien 24 h » sur la page document ; page `ged/quarantaine` ; `ged.service.ts` (statut joint) ; `types.ts` ; permission `documents.retention` dans le catalogue ; test `web/tests/sql/documents_security.test.mjs` (36 assertions).
- Tests : `npm run test:sql` complet : **1986 assertions réussies, 0 échec, code de sortie 0** ; `npm run test:unit` OK ; `npx tsc --noEmit` sans erreur ; RBAC 63/63 ; migrations 0001–0037 appliquées sans erreur sur PostgreSQL 16 réel.
- Non vérifié : routes et pages dans un navigateur ou un serveur web (pas de base locale) ; téléversement réel vers le stockage ; antivirus réel.
- Limites : pas d'interface de rétention (la saisie se fait par la fonction) ; pas d'écran de gestion des liens (révocation par fonction) ; la version la plus récente est indisponible pendant son analyse, même si une version précédente est propre ; `ged_quarantine_list` n'est relié à aucun menu ; l'empreinte annoncée par le client n'est comparée qu'à l'analyse du service, qui doit calculer l'empreinte sur l'objet.

### P015 — tiers clients et fournisseurs groupe (migration 0038)
- Existant conservé : clients et fournisseurs restent des fiches par société (conditions de paiement, plafond, devise, incoterm, TVA, archivage, contacts, documents GED). Aucune donnée déplacée.
- Ajouts : `parties` (identité partagée : raison sociale, identifiant fiscal normalisé, pays ; aucune condition locale) ; `clients.party_id` et `suppliers.party_id` (chaque fiche existante reçoit son tiers, sans fusion automatique ; chaque nouvelle fiche crée le sien).
- Dédoublonnage : `party_duplicate_candidates` (identifiant fiscal normalisé identique = « fort » ; même raison sociale normalisée et même pays = « à vérifier »), limité aux tiers visibles pour la société active.
- Fusion : proposition (`party_propose_merge`), décision par un steward distinct de l'auteur (`party_decide_merge`, permission `tiers.steward`), choix de la raison sociale par champ. La fusion ne change que `party_id` ; le tiers source devient « merged » et pointe vers le tiers cible (`party_resolve` pour les anciens identifiants) ; documents et fiches inchangés. Journal `party_merge_log` immuable (avant, après, choix, décideur). Refus si fiche archivée ou tiers partagé avec une autre société (`MERGE_CROSS_COMPANY`, `MERGE_ARCHIVED_ROW`).
- Correction d'identité partagée : `party_update_identity` (steward), tracée.
- Fichiers : `supabase/migrations/0038_parties.sql` ; `web/src/features/parties/` (actions, formulaires, service) ; page `web/src/app/(erp)/tiers/doublons/page.tsx` ; permission `tiers.steward` dans le catalogue ; tests `web/tests/sql/parties.test.mjs` (41 assertions) ; `rbac.test.mjs` (toutes les migrations).
- Tests : `npm run test:sql` complet : **2027 assertions réussies, 0 échec, code de sortie 0** ; `npm run test:unit` OK ; `npx tsc --noEmit` sans erreur ; RBAC 63/63 ; migrations 0001–0038 appliquées sans erreur sur PostgreSQL 16 réel.
- Non vérifié : page des doublons dans un navigateur (pas de base locale) ; fusion inter-sociétés (refusée volontairement) ; la fiche de steward n'est pas reliée au menu.
- Limites : une société ne peut pas avoir deux fiches clients au même identifiant fiscal brut (contrainte existante) : le doublon « fort » vient donc d'une écriture différente du même identifiant (normalisée) ; la correction d'identité ne propage pas le nom aux fiches locales (elles gardent leur libellé) ; les conditions locales ne sont jamais fusionnées : chaque fiche garde les siennes ; le rattachement entre sociétés (tiers réellement groupe) n'est pas créé par l'application : les données de groupe sont à fournir (OPEN-01/02).
- Décision : fusion intra-société seulement ; fusion inter-sociétés à décider par le propriétaire.

### P016 — articles, variantes et unités (migration 0039)
- Existant conservé : tailles, couleurs, variantes avec SKU unique par société (insensible à la casse), statut produit (draft / active / archived), composants avec unité (0008), verrou d'unité quand le composant est utilisé, stock de variantes en pièces.
- Unités : référentiel `measurement_units` (pc, cm, m, m2, g, kg, roll) ; `bom_materials.unit` devient une clé étrangère vers ce référentiel (valeurs existantes inchangées).
- Tissus en rouleaux et en mètres : `roll_length_m`, `width_m`, `grammage_g_m2` saisis explicitement sur le composant. Rouleau ↔ mètre exige la longueur du rouleau ; m² ↔ kg exige le grammage ; m ↔ kg exige largeur et grammage. Sans ces caractéristiques : `UNIT_CONVERSION_MISSING`. Aucune conversion kg/m n'est inventée.
- Conversions explicites : `material_unit_conversions`, saisies par `material_conversion_set` (droit bom.write, facteur > 0, source obligatoire, audit `material.conversion_set`). Conversions métriques exactes (cm↔m, g↔kg) dans `unit_conversions_standard`.
- SKU : `sku_history` garde tout SKU jamais attribué (même après suppression ou désactivation de la variante) ; un SKU déjà attribué ne peut plus être réattribué (`SKU_HISTORICAL`) ; un SKU attribué est immuable (`SKU_IMMUTABLE`).
- Écran : `web/src/app/(erp)/bom/conversions/page.tsx` (unités, caractéristiques, conversions saisies, formulaire).
- Fichiers : `supabase/migrations/0039_units_variants.sql` ; `web/src/features/units/` ; `web/tests/sql/variants_units.test.mjs` (28 assertions) ; `rbac.test.mjs` (toutes les migrations).
- Tests : `npm run test:sql` complet : **2055 assertions réussies, 0 échec, code de sortie 0** ; `npm run test:unit` OK ; `npx tsc --noEmit` sans erreur ; RBAC 63/63 ; migrations 0001–0039 appliquées sans erreur sur PostgreSQL 16 réel (7 unités).
- Non vérifié : écran des unités dans un navigateur ; conversions réelles des fiches fournisseurs (aucune donnée fournie).
- Limites : le stock de variantes reste en pièces entières (les rouleaux et mètres ne sont pas stockés par variante) ; les lignes de nomenclature n'ont pas d'unité propre : elles utilisent l'unité du composant, donc cohérentes par construction ; la conversion saisie n'est pas recalculée dans les coûts déjà figés (comportement existant) ; pas d'écran de correction de SKU (immuable par décision).
- Décision : SKU immuable et historique non réattribuable, y compris après suppression.

### P017 — tarifs, taxes et devises (migration 0040)
- Correction : `vat_rate_at` ne lit plus que les taux **signés par la finance** (avant : tout taux saisi, dont « à valider »). Les taux de TVA seedés (19 %, 13 %, 7 %, 0 %) restent « à valider » : aucun calcul ne les utilise tant que la finance ne les a pas signés.
- Taux de change : `exchange_rates` reçoit une source obligatoire, un statut, et une signature distincte de la saisie. `fx_rate_at` prend le dernier taux signé à la date ; sans taux signé : refus.
- Tarifs datés : `price_lists` (devise de la liste, canal) et `price_list_items` (article, date d'effet, sans chevauchement) ; rattachement client par période (`client_price_assignments`) ; remise maximale signée par client (`client_discount_rules`). Signature finance (`price_validate`), auteur exclu.
- Calcul : `price_resolve` : refus si aucun rattachement, aucun tarif, aucune remise ou aucun taux signé ; arrondis à la décimale de la devise (`currencies.minor_units`) ; montant devise et montant fonctionnel séparés ; trace immuable `price_snapshots` (si demandée).
- Fichiers : `supabase/migrations/0040_pricing_fx_tax.sql` ; `web/tests/sql/pricing.test.mjs` (38 assertions) ; permissions `pricing.read` / `pricing.manage` dans le catalogue.
- Tests : `npm run test:sql` complet : **2093 assertions réussies, 0 échec, code de sortie 0** ; RBAC 63/63 ; `npm run test:unit` OK ; `npx tsc --noEmit` sans erreur. Migrations 0001–0040 appliquées sans erreur sur PostgreSQL 16 réel.
- Limites : pas d'écran tarifs/taux (API et fonctions seulement) ; `price_resolve` n'est pas branché sur les devis existants (les lignes de devis gardent leur prix saisi) ; `product_variants.price` n'est plus utilisé pour la valorisation, il reste une donnée saisie ; la devise de base est posée à 'EUR' par défaut dans les réglages existants (0027) et doit être confirmée par la finance ; les taux TVA et de change réels ne sont pas fournis (aucune valeur inventée).

### P017 (suite) — FODEC sur les articles confectionnés (migration 0041)
- Règle confirmée par le propriétaire : FODEC s'applique à tout article confectionné. Hypothèse à confirmer : tous les produits du module Articles/PDM sont confectionnés.
- Modèle : `fodec_parameters` (taux, base HT ou TTC, période d'effet sans chevauchement, statut `a_valider` / `valide`, signature finance distincte de la saisie). Saisie `fodec_set` (`finance.write`), signature `fodec_validate` (auteur exclu par CHECK et par fonction). Aucun taux ni base codés en dur.
- Calcul : `price_resolve_fodec` refuse (`FODEC_NOT_CONFIGURED` ou `FODEC_NOT_VALIDATED`) avant tout calcul ou snapshot tant qu'aucune ligne signée ne couvre la date. Le total de prix existant n'est pas modifié ; le montant FODEC est ajouté à part.
- Fichiers : `supabase/migrations/0041_fodec.sql` ; `web/tests/sql/fodec.test.mjs` (22 assertions, taux 2 % et 4 % = valeurs de test uniquement).
- Tests : suite `npm run test:sql` complète : **2115 PASS, 0 FAIL, code de sortie 0** (incluant le test FODEC). Migrations 0001–0041 appliquées sur PostgreSQL 16 réel : à confirmer avant de déclarer le lot terminé.
- Limites : taux, base, dates d'effet et signataire FODEC réels non fournis par la finance ; le périmètre « tout article confectionné » n'est pas encore relié à un champ de type d'article ; FODEC n'est pas encore branché sur les devis ni les factures ; pas d'écran FODEC.

### P018 — imports qualité et référentiels techniques (migration 0042)
- Objectif : import simulable, validation ligne à ligne, rejets exportables, clé d'idempotence ; référentiels sites, emplacements, calendriers et centres analytiques avec responsables ; détection des doublons et orphelins sans nettoyage automatique.
- Réutilisé sans modification : sites (0032, avec leurs garde-fous et codes SIT-nn), emplacements d'entrepôt `warehouse_locations` (0017, garde `wh_can`), profils (0001).
- Ajouté : `cost_centers` (code immuable, responsable actif de la même société obligatoire), `calendars` (jours ISO 1–7 normalisés, site optionnel, responsable obligatoire), `import_batches`, `import_rows`.
- Fonctions : `import_batch_create` (reprise par clé, même lot, refus si la clé change de fichier, lot réservé à son auteur), `import_rows_load` (une seule fois ; lignes rejetées avec motifs), `import_simulate` (aucune écriture métier ; doublon dans le fichier : les deux lignes rejetées), `import_commit` (validation par une personne différente du chargeur ; tout ou rien ; relance sans écriture), `import_rejects_export`, `reference_integrity_report` (lecture seule : doublons de libellé et de nom de zone, responsable inactif, site ou entrepôt archivé).
- Droits : `imports.read`, `imports.write`, `imports.commit`, `referentials.read`, `referentials.manage` (admin ; direction en lecture). La validation des sites exige `sites.manage`.
- Audit : création de lot, simulation, validation, et audit des centres et calendriers par trigger.
- Fichiers SQL : `supabase/migrations/0042_imports_reference.sql` ; `web/tests/sql/imports_reference.test.mjs`.
- Fichiers web : `web/src/lib/imports/csv.ts` (lecture CSV, empreinte SHA-256, clé d'idempotence, export des rejets) ; `web/src/features/imports/actions.ts` (actions serveur : préparer, simuler, valider, rejets ; garde de permission et journal d'accès refusé) ; `web/src/features/imports/services/imports.service.ts` (lots et rapport d'intégrité, en lecture) ; `web/src/features/imports/components/import-panel.tsx` (charger, simuler, voir les rejets, exporter, valider) ; `web/src/app/(erp)/admin/imports/page.tsx` ; `web/tests/unit/imports-csv.test.mjs`.
- Parcours : le fichier est lu dans le navigateur, puis la clé est `type + empreinte` : même fichier = même lot. Une reprise continue le lot existant sans recharger les lignes.
- Limites : pas de calendrier d'exceptions (jours fériés, fermetures) ; le CSV est lu côté navigateur (2 Mo, 5 000 lignes) ; les doublons existants ne sont signalés que pour les cas listés ; les responsables sont identifiés par e-mail, sans annuaire externe ; l'écran n'est pas encore ajouté au menu (accès par l'adresse `/admin/imports`) ; écrans non vérifiés dans un navigateur (pas de base locale ni d'API lancée).
- Décisions : séparation des tâches (chargeur ≠ validateur) appliquée par la fonction ; une validation en erreur annule tout le lot ; le rapport d'intégrité ne modifie rien.

## 7. Limites connues
- Suite P011 : les écrans n'ont pas été vérifiés dans un navigateur (pas de base locale).
- Suite P011 : le formulaire de paiement dans le module finance affiche désormais une consigne (redirection vers l'écran des contrôles) ; il n'a pas été réécrit en parcours complet.
- Suite P011 : les refus de la base ne sont pas écrits dans `audit_logs` (transaction annulée) ; seules les décisions acceptées sont auditées.
- Suite P011 : une personne sans droit ni délégation voit l'entrée de menu mais l'écran refuse (non trouvé).
- P011 : la vérification navigateur des écrans « Délégations et contrôles » n'a pas été faite ; seuls les tests SQL et `tsc` le couvrent.
- P011 : les refus (délégation expirée, auto-approbation) lèvent une erreur, donc la transaction est annulée et ne peuvent pas être écrits dans `audit_logs` ; seules les décisions acceptées sont auditées. Les refus d'accès passent par le journal existant d'accès refusé côté application.
- P011 : le paiement fournisseur direct (`supplier_payment_record`, droit `finance.write`) court-circuite encore l'ordre de paiement approuvé. Décision à prendre : restreindre ce chemin ou le relier à l'ordre approuvé.
- P011 : une personne qui n'a qu'une délégation, sans permission directe, n'accède pas à la page par le menu (la règle de menu exige une permission). Ouvrir l'accès aux délégués demande une décision.
- P011 : les dérogations ne bloquent encore ni la commande, ni l'expédition (BR-CER-003, ADV-03) ; la fonction `derogation_is_effective` est prête pour cela.
- P011 : le « lot critique » est un indicateur posé par `quality_inspection_mark_critical`, ou la présence d'un défaut critique. Ce choix de définition est à valider par le propriétaire.
- P011 : pas d'API dédiée ; les écrans appellent les fonctions SQL, comme les modules existants.
- Lot L1 : la migration 0032 n'est pas appliquée à la base locale ni à aucune autre base ; elle n'est validée que par PGlite (Postgres en mémoire), pas par la stack Supabase réelle.
- Lot L1 : le modèle « un utilisateur, plusieurs sociétés » n'est pas décidé : `profiles.company_id` reste unique. Le sélecteur de société active (ORG-002) et le rattachement des droits par société ne sont pas livrés.
- Lot L1 : aucune donnée de site ; l'écran de gestion des sites n'existe pas encore (API et écran à faire dans un lot suivant).- Une seule société existe en base ; les règles multi-sociétés ne sont pas testables tant que L1 n'est pas livré.
- Les environnements de recette, sauvegardes et PRA ne sont pas vérifiés ici.
- Les résultats de la matrice d'écarts (169 exigences) ne sont pas recalculés dans ce lot.

## 8. Prochain lot
**Lot P011 : décisions à prendre** puis validation navigateur :
1. Relier ou restreindre `supplier_payment_record` (contournement de l'ordre approuvé).
2. Ouvrir la page aux délégués sans permission directe, ou non.
3. Valider la définition de « lot critique ».
4. Vérification navigateur avec une base locale (Docker à rétablir).
5. Appliquer 0032 et 0033 sur la base locale, puis réconcilier le registre des migrations.

**Lot L1 suite** (dépend de OPEN-01/02) : voir plus haut.
**L1 suite** (dépend des décisions du propriétaire) :
1. Obtenir OPEN-01 et OPEN-02 (données de sociétés et sites). Sans elles, aucune société ni site n'est créé.
2. Décider le modèle « utilisateur multi-sociétés » (table de rattachement utilisateur–société, ou société unique par compte) avant d'ajouter le sélecteur de société active.
3. Lancer l'API et l'écran des sites (liste, fiche, création, archivage) avec les permissions `sites.read` / `sites.manage`.
4. Appliquer 0032 sur la base locale dès que Docker est disponible, puis réconcilier le registre des migrations.
L0 : table des données et jeu de référence (AUD-004, OPEN-06) restent à faire.

### P019 — états, validations et approbations (migration 0043)
- Objectif : moteur d'états et de transitions, seuils, délégations, délais, escalades, refus motivé ; accord lié au hash du contenu, invalidé après changement substantiel ; workflows 8.2 à 8.9 décrits en Mermaid.
- Existant conservé, non réécrit : achats à un niveau (0011, `purchase_request_decide`), mouvements de stock à deux niveaux (0018), paiements, dérogations et contrôles qualité (0033). Le moteur est une couche additive : il n'a aucune politique par défaut.
- Modèle : `approval_policies` (1 ou 2 niveaux, seuil du second niveau, permissions par FK, délai, permission d'escalade) ; `approval_requests` (version par objet, hash SHA-256 du contenu canonique, état, délai, motif de refus) ; `approval_decisions` (journal ajout seul, avec délégant éventuel, états avant/après) ; `approval_delegations` (90 jours au plus, bornée par type d'objet et montant, révocable).
- Fonctions : `approval_policy_set`, `approval_request_create`, `approval_decide` (approuver ou refuser ; transition interdite ou auto-approbation = résultat `ok = false` journalisé), `approval_escalate` (délai dépassé seulement), `approval_cancel`, `approval_object_changed` (invalide les accords et demandes ouvertes liés à un autre hash), `approval_assert_current` (garde : lève `APPROVAL_NOT_APPROVED` ou `APPROVAL_STALE`), `approval_delegation_grant` / `approval_delegation_revoke`.
- Droits : `approvals.read`, `approvals.request`, `approvals.decide`, `approvals.decide_high`, `approvals.escalate`, `approvals.manage` (admin ; direction en lecture et décision ; finance en lecture et demande ; commercial en demande).
- Fichiers SQL : `supabase/migrations/0043_approvals_engine.sql` ; `web/tests/sql/approvals_engine.test.mjs`.
- Fichiers web : `web/src/features/approvals/actions.ts` ; `web/src/features/approvals/services/approvals.service.ts` ; `web/src/features/approvals/components/approval-actions.tsx` ; `web/src/app/(erp)/admin/approvals/page.tsx` ; permissions `approvals.*` alignées dans `web/src/lib/rbac/permissions.ts`.
- Documents : `docs/erp360/WORKFLOWS.md` (Mermaid des workflows 8.2 à 8.9 et diagramme d'états du moteur ; pas de BPMN, le moteur n'est pas BPMN).
- Limites : aucun circuit existant n'appelle encore `approval_assert_current` (la garde est prête, les actions métier ne l'appellent pas) ; la décision du détenteur d'escalade n'est testée qu'avec un utilisateur qui détient aussi la permission de décision (le cas « escalade seule » n'a pas de fixture) ; les refus d'accès (RBAC) et les erreurs de saisie lèvent une erreur, donc la transaction est annulée et ne sont pas écrits dans `audit_logs` (journal d'accès refusé côté application) ; pas de notification (délai et escalade sont enregistrés, personne n'est prévenu) ; écrans non vérifiés dans un navigateur ; workflows 8.2 à 8.9 : écarts listés dans la matrice, aucun n'est implémenté de bout en bout dans ce lot.
- Décisions : séparation demandeur ≠ décideur et premier ≠ second niveau appliquée en base et en fonction ; politique figée dans chaque demande (une modification n'affecte pas les demandes ouvertes) ; une seule demande ouverte par objet ; le hash porte sur le contenu canonique (`jsonb::text`) ; les délégations ne réutilisent pas `delegations` (0033) qui est limitée à trois types d'objets.

### P020 — API événements et notifications (migrations 0044, 0045)
- Objectif : outbox après commit, consommateurs idempotents, échecs visibles, replay ; notifications internes dédupliquées ; canaux externes désactivés ; API documentée (OpenAPI, pagination, erreurs, ETag, clés d'idempotence).
- Outbox : `event_outbox` (immuable) est écrite dans la transaction du fait. Source actuelle : chaque décision d'approbation (`approval_decisions`, 0043) via trigger ; une transaction annulée n'écrit aucun événement (testé). Clé d'idempotence unique par société : un même fait ne produit qu'un événement.
- Consommateurs : `event_consumers` (un seul : `notify_internal`) ; `event_deliveries` par couple (événement, consommateur) avec états `done` / `failed` / `dead`. Un consommateur déjà traité renvoie `already_done`. Au-delà de 5 tentatives : `dead`.
- Échecs : `event_failures()` (droit `events.read`) donne la cause et les tentatives. Replay : `event_replay()` (droit `events.replay`), sans effet double.
- Notifications internes : `notifications` dédupliquées par (destinataire, clé d'événement). Lecture réservée au destinataire (RLS) ; marquage lu par `notification_mark_read`.
- Canaux externes : `notification_channels` désactivés par défaut ; activation exige une référence d'autorisation et une personne (`notifications.external`) ; désactivation possible ; aucun envoi externe n'est implémenté. La porte `notification_external_allowed` est là pour un futur expéditeur.
- Idempotence de l'API : table `api_idempotency` (0045), lisible seulement par le serveur. Même acteur, même clé, même requête : réponse rejouée (`Idempotent-Replayed: true`). Même clé, autre requête : 422 `IDEMPOTENCY_KEY_REUSED`. Seules les réponses réussies sont enregistrées.
- API Laravel : `api/app/Http/Controllers/Api/V1/NotificationController.php` (liste paginée avec ETag et 304, marquage lu) ; `EventController.php` (échecs, dispatch, replay avec Idempotency-Key obligatoire) ; `api/app/Support/Idempotency.php` ; routes dans `api/routes/api.php`.
- Documentation : `docs/api/openapi.yaml` (5 chemins ajoutés, schémas `Notification`, `NotificationPage`, `EventFailure`, réponse `Invalid`).
- Écrans : `/notifications` (mes notifications, marquage lu), `/admin/events` (échecs, traitement de la file, relance).
- Fichiers SQL : `supabase/migrations/0044_events_notifications.sql`, `0045_api_idempotency.sql`, `web/tests/sql/events_notifications.test.mjs` (45 assertions).
- Test de bout en bout : `api/tests/smoke/events.sh` (15 contrôles : authentification, 401/403/404, 304, 204 idempotent, pas de doublon à la relance, échec visible, replay avec et sans clé, 422 de réutilisation et de consommateur inconnu).
- Limites : seul l'événement d'approbation est émis ; les autres modules n'émettent pas encore d'événements ; aucun canal externe n'envoie quoi que ce soit ; le contrat OpenAPI couvre les routes ajoutées, pas l'ensemble de l'API ; la cible PHP est 8.4 (Dockerfile) mais le test a tourné sur PHP 8.3.6 avec `--ignore-platform-reqs` (versions Symfony 8 verrouillées) ; la base de test locale (`erp360_real`, port 54400) a reçu 0041–0045 sans sauvegarde préalable (une sauvegarde a été faite après), à noter pour toute reprise ; l'écran n'est pas vérifié dans un navigateur ; l'API n'a pas été testée dans le conteneur Docker (absent).
- Décisions : l'outbox est écrite dans la transaction du fait (pas de publication avant commit possible, car elle est en base) ; un événement en échec n'est jamais effacé, il reste visible ; la clé d'idempotence de l'API est liée à l'acteur ; le corps reçu (et non le corps normalisé) fait foi pour détecter la réutilisation d'une clé.

### P021 — prospects, leads et qualification (migration 0046)
- Objectif : source, segment, coordonnées, responsable, qualification, consentements, tâches, conversion lead → tiers et opportunité ; historique conservé ; dédoublonnage assisté ; recherche bornée aux droits.
- Existant conservé et réutilisé : prospects, étapes, activités, devis et conversion de 0012 ; clients (0004) ; annuaire et `private.permission_holders` (0044).
- Scope commercial (correction) : avant, tout utilisateur avec `prospects.read` voyait tous les prospects de la société. Désormais un commercial ne voit et ne modifie que ses prospects ; `prospects.read_all` (admin, direction) voit tout. Les activités et tâches suivent le prospect. Les politiques générées de 0012 sur `prospects` sont remplacées.
- Qualification : `prospect_qualify` enregistre budget, besoin, décideur, échéance. L'étape « qualifié » exige les trois confirmations (`PROSPECT_NOT_QUALIFIED`). Règle proposée — à valider par le propriétaire.
- Responsable : `prospect_assign` ; le nouveau responsable doit détenir `prospects.write` et être actif.
- Consentements : `prospect_consents` (ajout seul) par finalité ; statut courant = dernier enregistrement ; preuve obligatoire (5 caractères minimum) ; défaut « unknown ».
- Tâches : `prospect_tasks` (échéance obligatoire, responsable qui doit pouvoir travailler le prospect) ; fermeture par le responsable ou un profil qui voit le prospect.
- Doublons : `prospect_duplicates` renvoie les clients (même e-mail ou nom) et les prospects visibles. Aucune fusion automatique.
- Conversion : `lead_convert(prospect, client?)` : sans client choisi, refus si un client au même e-mail ou nom existe (`LEAD_DUPLICATE_CANDIDATE`) ; avec client choisi, rattachement à cette fiche ; création d'une opportunité (`opportunities`, unique par prospect) ; devis passés au client et prospect d'origine gardé dans `quotes.origin_prospect_id` (la contrainte `quotes_one_party` interdit les deux liens à la fois) ; relance idempotente (mêmes identifiants, rien de nouveau). `prospect_convert` (signature inchangée) passe par `lead_convert` et refuse de reconvertir, comme avant.
- Correction trouvée par le test : l'ancienne conversion mettait `quotes.prospect_id` à nul, donc effaçait le lien devis-prospect. Corrigé.
- Droits : `prospects.read_all` (ajouté au catalogue TypeScript).
- Fichiers SQL : `supabase/migrations/0046_leads_qualification.sql` ; `web/tests/sql/leads_qualification.test.mjs` (56 assertions).
- Fichiers web : `web/src/features/commercial/actions.ts` (actions lead ajoutées) ; `web/src/features/commercial/errors.ts` (messages) ; `web/src/features/commercial/components/lead-panel.tsx` ; `web/src/app/(erp)/commercial/prospects/[id]/page.tsx` (panneau intégré à la fiche).
- Tests : `leads_qualification` 56 PASS ; `rbac` 63/63 ; `tsc` sans erreur. Suite SQL complète : voir le résultat ci-dessous.
- Dette de test préexistante (non causée par ce lot) : `commercial.test.mjs` ne charge que les migrations jusqu'à 0030 ; avec l'ensemble complet, il s'arrête sur `VAT_RATE_NOT_VALIDATED` (règle TVA de P017). Il n'est donc pas une preuve complète du module commercial dans sa version actuelle.
- Limites : opportunité sans devise (la valeur est celle du prospect) ; pas d'écran de tâches séparé ; les devis ne sont pas filtrés par commercial (les devis d'un prospect hors périmètre restent lisibles par qui a `quotes.read`) ; le panneau n'est pas vérifié dans un navigateur ; la règle « trois confirmations pour qualifier » reste à valider par le propriétaire ; pas d'API REST pour les leads (accès par les actions web et les fonctions SQL).
- Décisions : le scope est appliqué par la base (politiques RLS et fonction `prospect_visible`), pas seulement par l'interface ; la conversion refuse les doublons plutôt que de les fusionner ; l'historique passe par `origin_prospect_id`, pas par la suppression de lien.

### P022 — opportunités et pipeline (migration 0047)
- Objectif : étapes paramétrables, montant et devise, probabilité, date attendue, produits, concurrents, prochaine action, motifs de gain et de perte ; vues Kanban et liste ; historique des étapes ; trois chiffres distincts : pondéré, commandes, CA.
- Existant conservé : `opportunities` (0046) et leur périmètre commercial ; `prospects` et leur pipeline (déplacé, voir ci-dessous) ; factures, avoirs et commandes (0010, 0012) ; devises et taux validés (0027, 0040).
- Étapes paramétrables : `pipeline_stages` par société (codes, libellés, genre ouvert/gagné/perdu, ordre unique, probabilité). Graine : cinq étapes (qualification, proposition, négociation, gagnée, perdue). **Probabilités des étapes ouvertes non seedées** : la société les saisit (`pipeline_stage_set`, `pipeline.configure`). Gagnée = 100 %, perdue = 0 % (définitions).
- Étapes autorisées : `pipeline_transitions` (par société). Graine : toutes les transitions entre étapes ouvertes et de chaque étape ouverte vers gagnée ou perdue. Une étape fermée ne se rouvre pas. Un passage absent de la table est refusé (`PIPELINE_TRANSITION_FORBIDDEN`).
- Opportunité : montant et devise obligatoires (`opportunity_create`), probabilité figée à l'entrée dans l'étape (`opportunity_stage_history`), date attendue, prochaine action, motif de perte obligatoire (3 caractères), dates de gain et de perte. Produits (`opportunity_products`, indicatifs) et concurrents (`opportunity_competitors`, un par nom). `prospect_id` devient facultatif (opportunité créée sans prospect).
- Pondéré (`pipeline_summary`) : opportunités ouvertes visibles ; montant converti en devise de base au taux **validé** du jour ; arrondi à la décimale de la devise par opportunité ; probabilité × montant converti. Une opportunité sans probabilité, sans devise ou sans taux validé est **exclue et comptée à part**, jamais supposée.
- Commandes : nombre de commandes confirmées et quantités ; **aucun montant** (le modèle n'a pas de prix sur les lignes de commande).
- CA : factures émises (`issued`, `partially_paid`, `paid`, `credited`), sous-total HT, converti au taux validé de la date d'émission, moins les avoirs émis. Le pipeline n'entre jamais dans le CA.
- Écrans : `/commercial/pipeline` (synthèse, Kanban par étape, vue liste, création, changement d'étape avec motif) ; `/commercial/pipeline/prospects` (l'ancien kanban de prospects, conservé).
- Correction : `STAGE_INFO` ne contient plus de probabilité codée en dur ; la ligne « Probabilité » de la fiche prospect a été retirée. Le pondéré de l'ancien kanban (valeurs codées 10/20/40/60/80 %) n'existe plus.
- Droits : `opportunities.read` (commercial, direction, admin), `opportunities.write` (commercial, admin), `pipeline.configure` (admin). Périmètre commercial : même règle que les prospects (`prospect_visible`).
- Fichiers SQL : `supabase/migrations/0047_opportunities_pipeline.sql` ; `web/tests/sql/pipeline.test.mjs` (49 assertions).
- Fichiers web : `web/src/app/(erp)/commercial/pipeline/page.tsx` (réécrit) ; `.../pipeline/prospects/page.tsx` (ancien kanban, sans pondéré) ; `web/src/features/commercial/services/pipeline.service.ts` ; `web/src/features/commercial/opportunity-actions.ts` ; `web/src/features/commercial/components/pipeline-forms.tsx` ; `web/src/features/commercial/errors.ts` ; `web/src/features/commercial/status.ts` ; `web/src/app/(erp)/commercial/prospects/[id]/page.tsx`.
- Tests : `pipeline` 49 PASS (calcul pondéré recalculé à la main : 4 000 + 4 000 + 1 050 = 9 050 EUR ; CA net 1 000 EUR = 1 000 + 150 − 150 ; taux non signé = exclusion) ; `rbac` 63/63 ; `tsc` sans erreur.
- Limites : opportunités créées avant ce lot sans devise ou sans étape restent hors pondéré et ne peuvent pas changer d'étape tant qu'elles n'ont pas d'étape (affichées dans « Sans étape ») ; les lignes de produits ne sont pas reliées au montant (indicatives) ; pas de devis ni de commande rattachés aux opportunités ; les étapes ont une position unique : réordonner demande de changer les positions une à une ; les écrans ne sont pas vérifiés dans un navigateur ; le CA ne déduit pas les avoirs partiels autrement que par le montant de l'avoir ; les factures sont émises à la date du jour (règle existante).
- Décisions à valider par le propriétaire : les probabilités de chaque étape ouverte ; les transitions autorisées (graine permissive) ; le périmètre du pondéré (opportunités visibles par l'utilisateur, donc pondéré personnel pour un commercial).

### P023 — Client 360 et activités (migration 0048)
- Objectif : fiche client complète selon les droits ; visites, adresses courriel autorisées, tâches liées aux pièces originales, chronologie, encours ; séparation marge/finance et lecture CRM ; pièces étrangères masquées ; historique conservé.
- Existant conservé et réutilisé : fiche client 360 (onglets, contacts, commandes, factures, GED, articles, nomenclatures, réclamations, historique, performance, marge, activité) ; `client_contacts`, `client_complaints`, devis, commandes, factures, avoirs, expéditions (BL), BAT (`customer_validations`), GED (contrats = dossier « Contrats »), `copilot_client_profit`.
- Ajouts (migration 0048) :
  - `client_visits` (visites, appels, rencontres ; journal ajout seul ; contact du même client) — `client_visit_record`.
  - `client_email_channels` : adresses courriel autorisées par finalité (commercial, facturation, technique), avec preuve ; retrait tracé, adresse et preuve jamais modifiées ni effacées ; `client_email_allowed` est la porte d'envoi (aucun envoi implémenté) — `client_email_authorize`, `client_email_withdraw`.
  - `client_tasks` et `client_task_links` : tâches avec responsable et échéance ; liens vers devis, commande, facture, réclamation, BL, visite, document GED ou BAT. Un lien n'est accepté que si la pièce est du même client, existe, et est lisible par la personne — `client_task_create`, `client_task_complete`.
  - `client_timeline(client)` : chronologie unifiée ; chaque source n'apparaît que si la personne a le droit de la lire (commandes, devis, factures, BL, BAT, réclamations, visites, courriels, tâches).
  - `client_balance(client)` : encours TTC par devise (jamais additionné entre devises), échu séparé ; droit `invoices.read`.
- Droits : aucune permission nouvelle ; lecture client par `clients.read`, écriture par `clients.write`, chaque type de pièce par son droit propre. La marge reste sous `costs.read` (commercial : sans marge ; finance : avec marge, droit séparé).
- Web : onglets « Suivi (visites, tâches, chronologie) » et « Encours » dans la fiche client ; panneau `web/src/features/clients/components/follow-up-panel.tsx` ; actions `web/src/features/clients/follow-up-actions.ts` ; service `web/src/features/clients/services/follow-up.service.ts`.
- Fichiers SQL : `supabase/migrations/0048_client360_activities.sql` ; `web/tests/sql/client360_activities.test.mjs` (39 assertions).
- Tests : `client360_activities` 39 PASS ; `rbac` 63/63 ; `tsc` sans erreur. Suite SQL complète : voir le résultat ci-dessous.
- Limites : pas de module « contrat » distinct (les contrats restent des documents GED) ; pas d'onglets dédiés aux devis, BL et BAT sur la fiche (ils figurent dans la chronologie, avec un lien vers la pièce originale) ; pas d'envoi de courriel ; encours sur factures émises sans rapprochement bancaire ; la fixture de test place un projet à l'étape BAT par le drapeau interne du module (les étapes réelles passent par ses fonctions) ; les écrans ne sont pas vérifiés dans un navigateur ; SAV = onglet réclamations existant (pas de nouveau workflow).
- Décisions : une pièce étrangère ou illisible est refusée avec le même message (pas de fuite sur son existence) ; la chronologie omet silencieusement les sources sans droit ; l'historique (visites, courriels autorisés, tâches terminées, liens) n'est jamais effacé.

### P024 — devis, tarifs et PDF (migration 0049)
- Objectif : devis avec lignes SKU, variantes (tailles, couleurs), personnalisation, prix, remise, taxe, validité, délai ; remise hors seuil bloquée par un accord ; versions immuables ; PDF ; conversion en commande sans ressaisie et unique.
- Identifiants CDC : devis (`quotes`, `quote_lines`), commande (`sales_orders`), accord (`approval_requests`, moteur de 0043).
- Existant conservé : `quote_send`, `quote_decide`, `quote_duplicate`, `quote_to_order` (même URL et même action d'interface, désormais passée par la conversion idempotente) ; règles de remise client (0040) ; moteur d'approbation (0043) ; calcul de ligne et de totaux (`doc_recalc`, inchangé).
- Ajouts (0049) :
  - Colonnes : `quotes.family_id`, `version_no`, `superseded_by`, `requires_approval`, `conversion_key` (unique) ; `quote_lines` et `sales_order_lines` : `variant_id`, `customization` (1 à 300 caractères). Index unique `sales_orders_quote_uq` : un devis ne donne qu'une commande.
  - Remise hors seuil : `requires_approval` vaut vrai si une ligne dépasse la remise maximale de la règle client validée à la date du devis (sans règle : 0 %). `quote_request_approval` crée la demande ; `quote_send`, `quote_decide` et `quote_convert` refusent sans accord valide (`QUOTE_APPROVAL_REQUIRED`). Toute modification après accord rend l'accord caduc (empreinte du contenu).
  - Versions : `quote_versions` (ajout seul, empreinte sha256 et instantané) écrites à l'envoi, à l'acceptation et à la demande d'accord. `quote_revise` crée la version suivante (même famille, validité prolongée) ; l'ancienne passe en « remplacé ». Un devis accepté ne se modifie plus.
  - Conversion : `quote_convert(devis, clé)` copie lignes, variantes et personnalisations ; même clé → même commande ; autre clé après conversion → `QUOTE_ALREADY_CONVERTED`.
  - PDF : `quote_document(devis, version?)` ; route `/commercial/quotes/[id]/pdf[?seq=N]`.
- Droits : `quotes.read` (lecture, PDF, historique des versions), `quotes.write` (édition, accord, révision), `orders.write` en plus pour la conversion. Aucun droit nouveau. Le refus par défaut s'applique à l'historique (`quote_versions`, RLS).
- Fichiers SQL : `supabase/migrations/0049_quotes_pricing_versions.sql` ; `web/tests/sql/quotes_pricing.test.mjs` (45 assertions).
- Fichiers web : `web/src/features/commercial/actions.ts` (`quoteRequestApprovalAction`, `quoteReviseAction`, `quoteConvertAction`) ; `web/src/features/commercial/errors.ts` (5 codes) ; `web/src/features/commercial/services/commercial.service.ts` (`listQuoteVersions`) ; `web/src/app/(erp)/commercial/quotes/[id]/page.tsx` (boutons, alerte hors seuil, panneau des versions) ; `web/src/lib/pdf/quote-pdf.ts` (PDF sans dépendance) ; `web/src/app/(erp)/commercial/quotes/[id]/pdf/route.ts`.
- Tests réellement exécutés :
  - `quotes_pricing` : 45 PASS (totaux exacts : 3 × 33,333 à 10 % = 90,00 ; 2 × 50 = 100,00 ; sous-total 190,00 ; TVA 36,10 ; total 226,10. Remise 10 % au-delà de 5 % bloquée, auto-approbation refusée (`SOD_SELF_APPROVAL`), accord caduc après modification, version 2 après révision, conversion unique et idempotente, commande directe refusée par les droits colonnes, index unique `sales_orders_quote_uq` atteint par le chemin système, historique invisible sans droit).
  - `rbac` : 63/63 PASS (liste des migrations incluant 0049).
  - `tests/unit/quote-pdf.test.mjs` : tous les contrôles PASS (en-tête et fin %PDF, table xref valide, montants en format français, pagination et pied de page, encodage WinAnsi, échappement).
  - `npx tsc --noEmit` : sans erreur.
  - Suite SQL complète (`npm run test:sql`) : exit 0, 2464 PASS, 0 FAIL.
- Corrections trouvées par les tests (P024) : `quote_lines.pos` non insérable (droit ajouté) ; `family_id` obligatoire sur les nouveaux devis (valeur par défaut) ; l'insertion directe de commande n'était pas testée sur l'index (test corrigé : le chemin système est ouvert explicitement).
- Limites :
  - Arrondi à 2 décimales (calcul existant) et non à la précision de la devise.
  - La politique d'approbation `quote` doit être paramétrée par un administrateur ; aucune n'est créée par défaut. Tant qu'elle n'existe pas, la demande d'accord échoue.
  - Un prospect dont une remise est saisie doit obtenir l'accord.
  - Le PDF est en texte seul (Helvetica, sans logo ni mise en page commerciale) ; l'alignement des montants est approximatif (largeur de caractère moyenne).
  - Les brouillons ne sont pas versionnés ; une version est figée à l'envoi, à l'acceptation ou à la demande d'accord.
  - Les écrans et le PDF ne sont pas vérifiés dans un navigateur ; seule la compilation TypeScript et les tests SQL/unitaires ont été exécutés.
  - Le PDF est généré à la demande et non archivé ; seule l'empreinte de la version est conservée.
  - La clé de conversion est dérivée de l'identifiant du devis : une révision (nouveau devis) a sa propre clé.
- Décisions à valider par le propriétaire : seuil de remise par client (règle 0040) et paramétrage de la politique `quote` ; contenu juridique du PDF (mentions obligatoires, conditions générales) ; nombre de décimales de la devise.
- Prochain lot : vérification navigateur des écrans devis (accord, révision, conversion, PDF) ; paramétrage de la politique d'approbation `quote` ; mise en page PDF validée par le propriétaire.

### P025 — contrats, objectifs et visites (migration 0050)
- Objectif : contrats datés avec renouvellement, conditions et pièces signées ; objectifs commerciaux datés et comparables au CA ; agenda des visites, compte rendu, pointage GPS encadré, photos, dictée relue. Une position indisponible ne produit jamais une fausse preuve.
- Identifiants matrice : CRM-04 (visites), CRM-06 (contrats) passent de « Absent » à « Partiel » ; CRM-05 (devis) mis à jour avec P024. Compteurs de `docs/MATRICE_ECARTS_CDC.md` corrigés en conséquence.
- Existant conservé et réutilisé : journal des visites `client_visits` et `client_visit_record` (0048) inchangés ; dossier GED « contrats » du client (0005) pour les pièces signées ; photos liées à la GED existante ; règle de CA du pipeline (0047, `pipeline_summary`) reprise à l'identique pour les objectifs ; `clientOptions`, `commercial-nav`, messages de `errors.ts`.
- Ajouts SQL (0050), additifs, aucune table existante modifiée :
  - Droits : `contracts.read/write`, `objectives.read/write`, `visits.read/write` (admin : tout ; direction : contrats et objectifs, lecture des visites ; commercial : lecture des contrats et objectifs, visites en écriture pour lui-même).
  - Contrats (`client_contracts`) : brouillon → signé (pièce GED du même client, nom du signataire, devise et au moins une condition) → renouvelé ou résilié. Contenu figé une fois signé (verrou `CONTRACT_LOCKED`) ; pas de suppression après signature ; pas de chevauchement entre contrats signés ; un renouvellement commence après la fin effective du contrat remplacé et n'existe qu'une fois. `contract_conditions_at(client, date)` renvoie les conditions valides à la date, ou rien.
  - Objectifs (`sales_objectives`) : périmètre société ou client, devise de base de la société, un objectif par périmètre et période, ajout seul. `objective_progress` calcule le CA avec le même périmètre et la même période (factures émises moins avoirs émis, taux validés ; facture sans taux exclue et comptée).
  - Visites (`visit_plans`, `visit_checkins`, `visit_photos`, `visit_reports`) : seul le responsable de la visite la planifie, la pointe et la rédige (`VISIT_NOT_OWNER`). Pointage une seule fois, dans une fenêtre de ±24 h autour de l'heure prévue. Position enregistrée seulement si capturée, avec précision ; refus ou indisponibilité enregistrés avec motif, sans coordonnée. Compte rendu final unique ; une dictée n'est acceptée qu'après relecture.
- Fichiers SQL : `supabase/migrations/0050_contracts_objectives_visits.sql` ; `web/tests/sql/contracts_objectives_visits.test.mjs` (66 assertions).
- Fichiers web : `web/src/features/commercial/crm-actions.ts` (10 actions) ; `web/src/features/commercial/services/contracts.service.ts`, `objectives.service.ts`, `visits.service.ts` ; `web/src/features/commercial/components/crm-forms.tsx` (formulaires, pointage GPS au clic, dictée) ; pages `web/src/app/(erp)/commercial/contracts/page.tsx`, `objectives/page.tsx`, `visits/page.tsx` ; onglets dans `commercial-nav.tsx` ; messages dans `errors.ts` (30 codes).
- Droits TypeScript : `web/src/lib/rbac/permissions.ts` (6 codes ajoutés, identiques à 0050).
- Tests réellement exécutés :
  - `contracts_objectives_visits` : 66 PASS / 0 FAIL. Contrôles clés : conditions valides à date (15 juin 2026 → C1 ; avant ou après la validité → aucune condition) ; renouvellement : C1 reste valable jusqu'à sa fin, R1 prend le relais ; résiliation : la veille de la date de résiliation reste couverte. Objectifs : CA société 3 000 = client A 1 000 + client B 2 000 (même période, même règle) ; taux 60 % et 50 % recalculés à la main ; objectif sans droit facture : CA absent, jamais zéro. GPS : captured sans précision refusé, imprécis (> 500 m) refusé, indisponible avec coordonnées refusé, indisponible sans motif refusé, pointage d'un autre commercial refusé, indisponible enregistré sans coordonnée.
  - `rbac` : 63/63 PASS (liste des migrations incluant 0050 ; catalogue TypeScript cohérent).
  - `tsc --noEmit` : sans erreur.
  - `npm run test:unit` : tous les tests passent (206 PASS, dont le PDF devis).
  - Suite SQL complète (`npm run test:sql`) : exit 0, 2530 PASS, 0 FAIL.
- Corrections trouvées par les tests (P025) : `objective_create` renvoyait `CLIENT_NOT_FOUND` pour un périmètre « client » sans client (corrigé : `OBJECTIVE_BAD_SCOPE`).
- Limites :
  - Pas de vue calendrier : l'agenda est une liste triée par date.
  - Photos : rattachement de pièces GED existantes uniquement ; pas de téléversement dans ce lot.
  - Pas de périmètre par territoire : un commercial qui a `visits.read` voit les visites de toute la société (comme les devis).
  - Pas de distance entre la position et le site du client (pas de coordonnées de site dans le modèle).
  - Seuils techniques à valider (non issus du CDC) : fenêtre de pointage ±24 h, précision maximale 500 m, un seul pointage par visite.
  - Objectifs : pas de correction après création (ajout seul, unicité par périmètre et période) ; une correction demande une nouvelle période ou un lot dédié.
  - La règle de CA est recopiée de `pipeline_summary` (P022) et non factorisée, pour ne pas modifier un lot déjà validé.
  - Renouvellement automatique : le drapeau est enregistré, mais aucun renouvellement ni rappel de préavis n'est exécuté.
  - Pas de signature électronique : la pièce signée est un document GED, avec le nom du signataire.
  - La dictée dépend de l'API de reconnaissance vocale du navigateur (absente sur certains navigateurs : saisie manuelle prévue).
  - Les écrans ne sont pas vérifiés dans un navigateur, ni sur mobile ; seule la compilation TypeScript et les tests SQL et unitaires ont été exécutés.
  - La migration 0050 n'a pas été appliquée à la base locale réelle `erp360_real` (tests sur PGlite uniquement).
- Décisions à valider par le propriétaire : seuils de pointage (fenêtre, précision) ; règle « un objectif par périmètre et période » ; visibilité des visites à toute la société ; texte des conditions de signature.
- Prochain lot : vérification navigateur des écrans P024 et P025 ; téléversement de photos de visite ; territoires et périmètre commercial des visites et devis ; alerte de préavis de renouvellement.

### P026 — marketing et canaux omnicanaux (migration 0051)
- Objectif : segments, modèles e-mail / SMS / WhatsApp, campagnes brouillons, consentements, désinscription, délivrabilité (webhooks), coûts. Envoi réel impossible tant qu'aucun connecteur officiel n'est homologué et qu'une politique d'envoi n'est pas activée. Critères : désinscrit exclu ; pas d'envoi involontaire ; statut et reprise vérifiables.
- Identifiant matrice : CRM-07 passe de « Absent » à « Partiel » (`docs/MATRICE_ECARTS_CDC.md`, compteurs corrigés).
- Existant conservé et réutilisé : consentements e-mail `client_email_channels` (0048, finalité « commercial », retrait tracé) — utilisés tels quels pour l'audience e-mail ; consentements prospects (0046) inchangés ; journal d'audit (0003/0035) ; garde append-only (0046) ; GED et clients inchangés.
- Ajouts SQL (0051), additifs :
  - Droits : `marketing.read` (commercial, direction, admin), `marketing.write` (commercial, admin), `marketing.send` (admin seul), `marketing.configure` (admin seul).
  - Politique d'envoi (`marketing_policy`) : désactivée par défaut ; aucun connecteur accepté (`MARKETING_CONNECTOR_UNKNOWN`).
  - Tarifs par canal (`marketing_channel_prices`, ajout seul) : aucun tarif par défaut ; sans tarif, le coût estimé est « null ».
  - Modèles (`marketing_templates`) : lien `{{desinscription}}` obligatoire, seules variables `{{client}}` et `{{desinscription}}`, objet obligatoire en e-mail, approbation par une autre personne que l'auteur (`MARKETING_SOD`), modèle approuvé figé.
  - Consentements SMS / WhatsApp (`marketing_phone_channels`) : numéro au format international, preuve, retrait tracé, doublon refusé.
  - Désinscriptions (`marketing_unsubscribes`, ajout seul) et liste de suppression (`marketing_suppressions`, rebonds et plaintes).
  - Segments (`marketing_segments`, ajout seul) : canal, pays facultatif, liste de clients facultative (vide = tous les clients non archivés).
  - Campagnes (`marketing_campaigns`) : brouillon → préparée (→ annulée) ; contenu figé à la création (modèle approuvé, même canal que le segment).
  - Destinataires (`marketing_recipients`) : éligible ou exclu avec motif (`no_consent`, `unsubscribed`, `suppressed`) ; jeton de désinscription conservé lors des préparations rejouées.
  - Envoi (`marketing_campaign_send`) : toujours refusé dans cette version (statut « envoyé » absent du modèle), refus journalisé et renvoyé sans exception pour que l'audit soit conservé.
  - Désinscription publique (`marketing_unsubscribe(jeton)`, accessible sans connexion) : réponse identique que le jeton existe ou non.
  - Webhooks (`marketing_events` + `marketing_ingest_event`) : idempotents sur (fournisseur, identifiant) ; rebond et plainte alimentent la liste de suppression ; plainte → désinscription ; appel réservé au serveur (rôle service).
- Règle de désinscription : un client désinscrit reste exclu du canal tant qu'aucun consentement n'a été enregistré après sa désinscription (reprise par un nouveau consentement).
- Fichiers SQL : `supabase/migrations/0051_marketing_omnichannel.sql` ; `web/tests/sql/marketing_omnichannel.test.mjs` (56 assertions).
- Fichiers web :
  - Routes publiques : `web/src/app/desinscription/page.tsx` et `web/src/features/marketing/unsubscribe.ts` (confirmation explicite, client anonyme) ; `web/src/app/api/webhooks/marketing/route.ts` (signature HMAC-SHA256 du corps brut, comparaison à temps constant, 503 sans configuration, 400 si le corps est invalide, 422 générique si la base refuse).
  - Chemins publics ajoutés dans `web/src/lib/auth/constants.ts` : `/desinscription`, `/api/webhooks/marketing`.
  - Lecture : `web/src/features/commercial/services/marketing.service.ts`.
  - Actions : `web/src/features/commercial/marketing-actions.ts` (8 actions).
  - Page : `web/src/app/(erp)/commercial/marketing/page.tsx` ; onglet « Marketing » dans `commercial-nav.tsx`.
  - Messages d'erreur (`errors.ts`), catalogue de permissions (`permissions.ts`), variables d'environnement documentées (`web/.env.example` : `MARKETING_WEBHOOK_SECRET`, `MARKETING_COMPANY_ID`).
- Tests réellement exécutés :
  - `marketing_omnichannel` : 56 PASS / 0 FAIL. Contrôles clés : jeton invalide ou court sans effet ; désinscrit exclu à la préparation suivante ; reprise après nouveau consentement ; rebond et plainte exclus ; webhook dupliqué ignoré (une seule ligne) ; webhook appelé par un utilisateur refusé ; envoi refusé (POLICY_DISABLED puis NO_CONNECTOR) ; aucun destinataire « envoyé » ; coût = 2 × 0,05 = 0,10 EUR, null sans tarif ; jetons stables après préparation rejouée.
  - `rbac` : 63/63 PASS (liste incluant 0051 ; catalogue TypeScript cohérent).
  - `tsc --noEmit` : sans erreur.
  - Route webhook exécutée sur le serveur Next.js de développement (env factices) : 503 sans configuration ; 401 sans signature ou signature fausse ; 400 corps invalide avec signature valide ; 422 générique quand la base est injoignable. Page de désinscription : 200 sans connexion.
  - Suite SQL complète (`npm run test:sql`) : exit 0, 2586 PASS, 0 FAIL.
- Corrections trouvées par les tests (P026) :
  - La détection de plainte renseignait l'identifiant du canal à la place de celui du client (violation de clé étrangère) — corrigé.
  - Chaque préparation régénérait les jetons de désinscription : les liens déjà diffusés devenaient invalides — corrigé (jetons repris).
  - Le contrôle « modèle sans sujet » était masqué par un refus de droits : test rendu sur la contrainte de table.
- Limites :
  - Aucun connecteur e-mail, SMS ni WhatsApp n'est homologué ni implémenté : aucun message ne part, et il n'existe aucun test contre un fournisseur réel.
  - Les webhooks ne sont pas testés avec un fournisseur réel : seule la signature générique est vérifiée. Le secret et l'identifiant de société doivent être configurés par l'administrateur.
  - Destinataires : clients uniquement (pas de prospects, à arbitrer avec le propriétaire).
  - Un jeton de désinscription est conservé en clair dans la base (choix de conception : il ne révèle que la désinscription d'un destinataire) ; à revoir si un connecteur impose un autre schéma.
  - Pas de consentement de type « double opt-in » ni de preuve horodatée au-delà de la saisie.
  - Coût : estimation seulement (éligibles × dernier tarif du canal) ; pas de facturation fournisseur.
  - La migration 0051 n'est pas appliquée à la base locale réelle (PGlite uniquement).
  - Les écrans marketing ne sont pas vérifiés dans un navigateur connecté (la page exige une session) ; seule la page publique de désinscription et la route webhook ont été exécutées.
- Décisions à valider par le propriétaire : prospects exclus du marketing (à confirmer) ; règle « désinscrit = exclu jusqu'à un nouveau consentement » ; seuil de rebonds (aucun seuil : un rebond ou une plainte suffit) ; choix d'un fournisseur officiel ; tarifs réels (aucun tarif inventé).
- Prochain lot : homologation d'un connecteur officiel par canal (avec politique d'envoi et autorisation écrite) ; tests contre un bac à sable fournisseur ; écrans marketing vérifiés dans le navigateur.

### P027 — commandes et reliquats (migration 0052)
- Objectif : commande depuis devis ou saisie habilitée ; lignes, échéanciers et adresses ; états ; reliquats ; annulation motivée ; engagements versionnés ; une annulation après production ne supprime ni la consommation ni les coûts. Critère : 100 commandées et 60 livrées donnent 40 restantes, historique intact.
- Identifiant matrice : ADV-01 reste « Partiel » (`docs/MATRICE_ECARTS_CDC.md`) ; détail des écarts mis à jour.
- Existant conservé et réutilisé : commandes, lignes, confirmation et statuts (0010, 0012) ; quantités facturées (0012) ; devis → commande (0012 et 0049) ; expéditions, picking, stock et livraison (0021) ; ordres de fabrication rattachés à la commande et saisies de production (0019) ; journal d'audit ; garde append-only (0046).
- Ajouts SQL (0052), additifs :
  - `sales_order_lines` : `qty_delivered`, `qty_cancelled` (contrainte : livré + annulé ≤ commandé) ; garde : ces colonnes ne bougent que par les fonctions de ce lot (`ORDER_FULFILMENT_LOCKED`).
  - `shipment_lines.order_line_id` : chaque ligne d'expédition est rattachée à une ligne de commande (la plus proche échéance disposant de reliquat).
  - `sales_orders.delivery_address` ; `sales_order_schedules` (échéancier par ligne, figé à la confirmation) ; `sales_order_versions` (ajout seul : confirmation, modification, annulation ; empreinte et instantané).
  - Fonctions nouvelles : `order_remaining` (reliquat par ligne et total, état), `order_amend_line` (modification versionnée, plancher livré + annulé + facturé), `order_cancel` (annulation motivée ; refusée s'il y a une expédition ouverte), `order_set_schedule`, `order_set_delivery_address`.
  - Fonctions complétées : `shipment_add_line` (rattachement et contrôle du reliquat disponible), `shipment_deliver` (livré mis à jour une seule fois), `sales_order_set_status` (annulation directe refusée dès qu'il y a de l'activité : `ORDER_HAS_ACTIVITY`).
- Règle d'annulation : brouillon → annulation complète. Commande confirmée → le reliquat est annulé ; la commande reste « confirmée » tant qu'il existe une livraison ou un ordre de fabrication lié, avec son historique.
- Correction de défaut (trouvée par le test) : la garde d'historique des SKU (0039) s'exécutait avant la génération du SKU (0015) : l'ordre alphabétique des déclencheurs BEFORE faisait échouer `variant_generate` dans le schéma complet. Garde recréée sous un nom placé après la génération ; logique inchangée.
- Droits : `orders.read` (reliquats, versions, échéanciers), `orders.write` (modifications, annulation, adresse, échéancier). Aucun droit nouveau.
- Fichiers SQL : `supabase/migrations/0052_orders_backorders.sql` ; `web/tests/sql/orders_backorders.test.mjs` (40 assertions).
- Fichiers web : `web/src/features/orders/order-backorder-actions.ts` (4 actions) ; `web/src/features/orders/order-errors.ts` ; `web/src/features/orders/services/backorders.service.ts` ; `web/src/app/(erp)/orders/[id]/page.tsx` (reliquats, engagements, annulation motivée, modifications de lignes, échéanciers, adresse ; le bouton « Annuler » direct ne reste que pour les brouillons).
- Tests réellement exécutés :
  - `orders_backorders` : 40 PASS / 0 FAIL. Critère : 100 commandées, 60 livrées → 40 restantes, état « livraison partielle », version de confirmation toujours à 100. Historique : livraison et sorties de stock inchangées, annulation motivée tracée, versions en ajout seul. Autres contrôles : livraison comptée une seule fois ; saisie directe du livré refusée (droits colonnes et garde) ; annulation refusée avec expédition ouverte ; reliquat réservé par une autre expédition refusé ; modification versionnée (motif obligatoire, droits) ; échéancier (somme exacte, figé après confirmation, verrou sur la quantité) ; annulation d'un brouillon sans version ; annulation après production : ordre de fabrication et saisies conservés, reliquat annulé.
  - `rbac` : 63/63 PASS (liste incluant 0052).
  - `tsc --noEmit` : sans erreur.
  - Suite SQL complète (`npm run test:sql`) : exit 0, 2626 PASS, 0 FAIL.
- Corrections trouvées par les tests (P027) : garde SKU et génération de variantes (ci-dessus) ; deux assertions de test trop faibles resserrées ; la livraison directe d'une ligne confirmée est refusée par `sales_order_lines_before` (ORDER_LOCKED) avant la garde, ce qui est correct — un test dédié couvre la garde sur brouillon.
- Limites :
  - Les lignes ajoutées après confirmation ne sont pas versionnées (ajout de lignes hors de ce lot) ; les modifications de quantité et d'échéance le sont.
  - Un échéancier fige la quantité de sa ligne après confirmation (pas de modification combinée échéancier + quantité).
  - Les échéanciers sont saisis en brouillon seulement, avec trois livraisons au plus dans l'écran.
  - Le reliquat est calculé à la livraison (et non à l'expédition) ; l'expédition réserve déjà le reliquat disponible.
  - Les ordres de fabrication liés ne sont pas annulés par `order_cancel` : ils restent à traiter par la production (décision à valider).
  - L'état « confirmée » est conservé quand une annulation partielle a eu lieu (pas d'état distinct « annulée partiellement » dans le modèle).
  - Pages commande non vérifiées dans un navigateur connecté ; adresse de livraison non pré-remplie à l'affichage.
  - La migration 0052 n'est pas appliquée à la base locale réelle (PGlite uniquement).
- Décisions à valider par le propriétaire : rattachement d'une expédition à la ligne de commande la plus proche échéance ; ordres de fabrication conservés après annulation ; annulation refusée tant qu'une expédition est ouverte ; état « confirmée » pour une commande partiellement annulée.
- Prochain lot : vérification navigateur des pages commande ; versions des lignes ajoutées après confirmation ; acomptes ; annulation coordonnée des ordres de fabrication.

### P028 — crédit, marge et disponibilité promise (migration 0053)
- Objectif : plafond d'encours bloquant à la confirmation ; contrôles prix et marge ; dérogations datées, bornées et tracées ; positions de stock distinguant utilisable, réservé, bloqué et attendu ; promesse de disponibilité sans double réservation et sans promesse fondée sur du stock bloqué.
- Identifiants matrice : ADV-02 et ADV-03 restent « Partiel » (`docs/MATRICE_ECARTS_CDC.md`) ; écarts détaillés mis à jour.
- Existant conservé et réutilisé :
  - Plafond client `clients.credit_limit` (0004) ; factures, soldes (`total`, `credited_amount`, `paid_amount`, 0012) ;
  - dérogations (0033) : demande, approbation, contrôle indépendant, `derogation_is_effective` ; kinds `credit_limit` et `price` ;
  - taux de change validés (0040, `private.fx_or_null`) ; stock par variante et réservations (0015) ; expéditions (0021) ; reliquats (0052) ; production (0019) ;
  - confirmation de commande (0010) : même comportement, contrôles ajoutés.
- Ajouts SQL (0053), additifs :
  - `credit_derogation_scopes` : plafond total autorisé par dérogation de crédit (ajout seul) ;
  - `variant_costs` (coût daté, ajout seul), `margin_policy` (minimum de marge, vide = aucun contrôle) ;
  - `variant_stock_blocks` : stock bloqué avec motif, levée seulement par une autre personne (`SOD_SELF_APPROVAL`) ;
  - fonctions : `client_credit_status`, `credit_derogation_request`, `stock_block`, `stock_block_release`, `stock_position`, `promise_check`, `margin_policy_set`, `variant_cost_set` ;
  - `sales_order_confirm` (remplacée) appelle `private.order_commitment_check` : crédit, prix net sous coût, marge sous minimum, coût absent quand un minimum existe ; une dérogation effective et tracée lève le blocage.
- Règles :
  - Encours = factures ouvertes (total − avoirs − payé) + commandes confirmées non facturées ni annulées, en devise de base au taux validé du jour (montant sans taux exclu et compté).
  - Blocage si encours après commande > plafond ; une dérogation de crédit élargit le plafond total (plafond + montant autorisé), jamais au-delà.
  - Utilisable = stock − bloqué − réservé − engagé non prélevé, l'engagé étant le reliquat des commandes confirmées moins ce qui est déjà réservé ou expédié et non livré (pas de double réservation).
  - Promesse : seul l'utilisable est promis ; les quantités attendues (production lancée ou planifiée) sont indiquées avec leur date, jamais promises.
- Droits : pas de droit nouveau. Coûts et marge : `costs.read` (lecture) et `finance.write` (minimum de marge). Blocage : `quality.write` ; levée : `quality.approve`. Dérogation : `derogations.request` / `approve` / `control` (0033).
- Fichiers SQL : `supabase/migrations/0053_credit_margin_availability.sql` ; `web/tests/sql/credit_margin_availability.test.mjs` (36 assertions).
- Fichiers web : `web/src/features/commercial/credit-actions.ts` (5 actions) ; `web/src/features/commercial/services/credit.service.ts` ; `web/src/app/(erp)/commercial/credit/page.tsx` (encours, dérogation, marge et coûts, disponibilité promise, stock bloqué) ; onglet « Crédit et stock » ; `web/src/features/orders/order-errors.ts` (5 codes de blocage) ; `web/src/features/orders/actions.ts` (erreurs de confirmation).
- Tests réellement exécutés :
  - `credit_margin_availability` : 36 PASS / 0 FAIL. Crédit : commande de 300 refusée (800 + 300 > 1000) ; dérogation approuvée puis contrôlée ; au-delà du plafond élargi refusé (1250 > 1100) ; commande dans le plafond élargi confirmée et tracée dans l'audit ; plafond élargi dépassé refusé. Prix et marge : marge 20 % sous 30 % refusée ; prix sous coût refusé ; marge 50 % acceptée ; remise prise en compte ; coût absent refusé quand un minimum existe ; dérogation « prix » liée à une seule commande. Stock : utilisable 10 avant picking, 10 après picking (pas de double réservation), 10 après expédition, 10 après livraison ; attendu de production affiché sans être promis ; levée du blocage refusée à son auteur, acceptée à un autre contrôleur ; utilisable 30 après levée.
  - `rbac` : 63/63 PASS (liste incluant 0053).
  - `tsc --noEmit` : sans erreur.
  - Suite SQL complète (`npm run test:sql`) : exit 0, 2662 PASS, 0 FAIL.
- Corrections trouvées pendant les tests (P028) :
  - lecture d'un coût dans une variable de type `record` (invalide en PL/pgSQL) : corrigée ;
  - contrôle de permission de la promesse plus large que la fonction qu'elle appelle : aligné sur `stock.read` ;
  - taux de TVA exonéré non validé dans la fixture : fixture corrigée (tous les taux « à valider » sont validés par la finance, comme la procédure le prévoit) ;
  - insertion de lignes de commande avec variante : faite en superutilisateur (la colonne n'est pas accordée au rôle applicatif, comportement existant).
- Limites :
  - Le blocage s'applique à la confirmation ; il n'est pas encore contrôlé à l'expédition ni à la facturation.
  - La dérogation de crédit élargit un plafond total pour une période ; elle n'est pas découpée par commande.
  - Le minimum de marge est vide tant que la finance ne le fournit pas : aucun seuil n'est inventé, donc aucun contrôle de marge n'est appliqué.
  - Le coût est saisi manuellement par variante (pas de lien automatique avec les nomenclatures).
  - La promesse est calculée par variante, sur l'ensemble des entrepôts ; le stock par entrepôt n'est pas affecté.
  - L'attendu de production est au niveau article ; il n'est pas ventilé par variante, donc jamais promis.
  - Pas de date d'arrivée fournisseur : seule la production lancée donne une date confirmée.
  - Écran non vérifié dans un navigateur connecté ; migration non appliquée à la base locale réelle.
- Décisions à valider par le propriétaire : valeur du minimum de marge ; blocage à l'expédition et à la facturation (non traité ici) ; plafond de dérogation cumulé sur la période (choisi : total autorisé, pas par commande) ; promesse sur tous les entrepôts.
- Prochain lot : blocage à l'expédition et à la facturation ; minimum de marge fourni par la finance ; vérification navigateur de l'écran crédit et stock ; ventilation de la production par variante.

### P029 — BAT, logos et validation client (migration 0054)
- Objectif : logos avec droits d'usage, placement, dimensions, couleurs et technique (broderie, sérigraphie, flocage, impression numérique) ; BAT par version avec PDF et empreinte ; accord client par contact habilité, avec date et preuve ; changement de visuel invalide l'accord ; opération de personnalisation bloquée sans BAT valide.
- Identifiants matrice : BAT-01, BAT-02, BAT-04 passent de « Absent » à « Partiel » ; BAT-03 reste « Partiel » avec des preuves précises (`docs/MATRICE_ECARTS_CDC.md`) ; décompte corrigé.
- Existant conservé : BAT de développement (0014, par projet et type `bat`, décision client) inchangé et distinct ; GED avec dossiers systèmes « logos » et « bat » et empreinte sha256 par document (0005) ; contacts clients (0004) ; lignes de commande et confirmation (0010, 0012, 0049, 0052, 0053) ; journal d'audit (0003, 0035) ; empreinte (0043).
- Ajouts SQL (0054), additifs :
  - Droits : `personalization.read` (commercial, direction, qualité, admin), `personalization.write` (commercial, admin), `personalization.operate` (production, admin).
  - `client_contacts.can_approve_bat` (faux par défaut) et `client_contact_set_bat_approver` (clients.write).
  - `client_logos` : logo = pièce du dossier « logos » du même client, droits (propriété, licence avec date de fin obligatoire, fourni par le client avec preuve écrite) ; retrait tracé (`logo_withdraw`), ajout seul.
  - `personalization_specs` : technique (4 valeurs), placement, dimensions positives, 1 à 12 couleurs ; version courante unique par ligne de commande ; toute modification crée une version et passe l'ancienne en « remplacée » (`personalization_spec_set`) ; impossible après démarrage d'une opération.
  - `bat_proofs` : une version par spécification ; PDF = document du dossier « bat » du client avec empreinte sha256 ; accord par `bat_record_acceptance` (contact habilité du même client, empreinte du PDF saisie égale à celle du BAT, preuve de 10 caractères minimum, date non future et non antérieure à l'émission, auteur du BAT exclu) ; refus par `bat_record_rejection`. Un BAT approuvé ou émis devient « remplacé » dès que le visuel change ou que les droits du logo sont retirés.
  - `personalization_operation_start` : démarre l'opération seulement si la commande est confirmée, le logo a des droits valides, et un BAT approuvé existe pour la version courante.
- Fichiers SQL : `supabase/migrations/0054_bat_logos_validation.sql` ; `web/tests/sql/bat_logos_validation.test.mjs` (46 assertions).
- Fichiers web : `web/src/features/commercial/personalization-actions.ts` (7 actions) ; `web/src/features/commercial/services/personalization.service.ts` ; `web/src/app/(erp)/commercial/personalization/page.tsx` (logos, droits, spécifications, BAT, accord, refus, opération) ; onglet « Logos et BAT » ; `web/src/features/orders/order-errors.ts` (codes LOGO, PERSO, BAT) ; permissions TypeScript (`permissions.ts`).
- Tests réellement exécutés :
  - `bat_logos_validation` : 46 PASS / 0 FAIL. Mauvaise version : accord sur un BAT remplacé refusé (BAT_SUPERSEDED) ; empreinte différente refusée (BAT_VERSION_MISMATCH) ; accord après retrait de droits refusé. Aucun accord implicite : opération refusée sans BAT approuvé, même pour la version émise ; refus d'opération après rejet ; second accord refusé. Preuve exacte : contact, canal, texte de la preuve, date, auteur de la décision et empreinte conservés et tracés dans l'audit. Autres : contact non habilité ou d'un autre client refusé ; auteur du BAT ne peut pas approuver ; logo d'un autre client, logo sans droits ou hors dossier refusés ; technique, dimensions et couleurs invalides refusées ; BAT sans empreinte ou hors dossier refusé ; logo sous licence sans date refusé ; modification directe des BAT refusée ; BAT approuvé non modifiable ; invisibilité sans droit.
  - `rbac` : 63/63 PASS (liste incluant 0054).
  - `tsc --noEmit` : sans erreur.
  - Suite SQL complète (`npm run test:sql`) : exit 0, 2708 PASS, 0 FAIL.
- Corrections trouvées pendant les tests (P029) :
  - le refus de rejet ne vérifiait pas l'habilitation du contact : corrigé dans 0054 ;
  - fixtures : contacts créés en superutilisateur (grant), document « hors logos » placé dans le bon dossier, logo réutilisé — corrections de test ;
  - deux assertions de test formulées avec `await` dans une fonction fléchée : corrigées.
- Limites :
  - Pas de génération du PDF du BAT : le fichier est fourni et ses empreintes sont celles du fichier téléversé dans la GED (l'empreinte est saisie à l'accord, comparée côté base).
  - Pas de signature électronique : la preuve de l'accord est un texte saisi (référence de mail, formulaire signé, réunion).
  - La règle de blocage s'applique à l'opération de personnalisation, pas encore aux ordres de fabrication (OF) ; le lien OF/BAT reste à faire.
  - Pas de validateur de fichier (résolution, format, couleurs) ni d'outil de placement graphique : placement et dimensions sont saisis.
  - Techniques sans paramètres de production (nombre de points, encres, quadrichromie).
  - Pas de relance automatique du client ; le BAT en attente n'expire pas.
  - Écrans non vérifiés dans un navigateur connecté ; migration non appliquée à la base locale réelle.
  - Le BAT de développement (0014) n'est pas remplacé : deux notions coexistent (projet/échantillon, et ligne de commande).
- Décisions à valider par le propriétaire : seuil de droits « fourni par le client » (preuve écrite obligatoire, aucun contrôle de contenu) ; la personnalisation reste bloquée après démarrage (visuel figé) ; le BAT pour une ligne de commande est distinct du BAT de développement.
- Prochain lot : génération du PDF de BAT ; lien opération de personnalisation ↔ ordres de fabrication ; validateur de fichier ; vérification navigateur des écrans.

### P030 — livraisons BL et retours (migration 0055)
- Objectif : BL partiels, colis, lien commande / lot, quantités, confirmation de livraison idempotente ; retours contrôlés avec état et décision qualité ; retour, avoir, remboursement et stock vendable restent des opérations distinctes ; un lot non conforme n'est jamais vendu.
- Identifiants matrice : ADV-05, LOG-03 et QUA-03 restent « Partiel » ; preuves et écarts mis à jour (`docs/MATRICE_ECARTS_CDC.md`) ; décomptes inchangés.
- Existant conservé et réutilisé : expéditions, picking, colisage, émission du BL et sortie de stock unique (0021) ; livraison et quantités livrées par ligne (0021, 0052) ; contrôle qualité et décisions avec séparation des tâches (0020, 0033) ; blocage de stock (0053) ; numérotation des documents (0033) ; avoirs (0012) inchangés.
- Ajouts SQL (0055), additifs. Aucune fonction existante n'est remplacée.
  - `finished_lots` : lots de produits finis (quantité entrée, sortie, statut libéré ou non conforme, origine réception ou retour) ; ajout seul, la sortie n'augmente que sur lot libéré ; `finished_lot_receive` (stock et lot ensemble), `finished_lot_mark_nc` (lot non vendable, stock restant bloqué).
  - `shipment_line_lots` : affectation d'un lot à une ligne d'expédition, dans la limite de la quantité prélevée et du lot disponible (affectations ouvertes comprises), lot libéré et de la bonne variante ; `shipment_line_lot_assign` / `shipment_line_lot_unassign`.
  - Déclencheur à « expédié » : chaque quantité prélevée doit être couverte exactement par des lots ; les lots sont alors consommés une seule fois (`SHIPPING_LOT_REQUIRED`, `LOT_NOT_RELEASED`).
  - `bl_reprint` : relit le BL sans nouvelle sortie ni nouveau numéro (audit `bl.reprint`).
  - `delivery_confirmations` et `delivery_confirm(expédition, clé, réceptionnaire)` : même clé pour la même expédition → même réponse, sans effet ; autre clé sur une expédition déjà confirmée → refus ; clé déjà utilisée ailleurs → refus.
  - `customer_returns` (numéro RET-, état demandé → réceptionné → en inspection → accepté ou refusé, transitions contrôlées) ; `return_request` (quantité ≤ expédié moins les retours déjà faits, lot éventuel affecté à la ligne), `return_receive`, `return_open_inspection` (inspection « finale » sur l'article, décision par le contrôle qualité existant), `return_settle` : décision « acceptée » → entrée en stock vendable et lot de retour libéré ; toute autre décision → lot non conforme, rien en stock vendable.
- Droits : `shipments.read` (BL, lots, retours), `shipments.write` (affectation, confirmation, retour, règlement), `stock.write` (réception de lot), `quality.write` (non-conformité, inspection). Aucun droit nouveau.
- Impact sur les tests existants : les tests qui expédient avec le schéma complet (commandes et reliquats, crédit et disponibilité) affectent désormais un lot à chaque quantité prélevée (lot de test inséré sans mouvement de stock, puis affectation par la fonction officielle). Les tests d'expédition qui chargent un schéma partiel ne sont pas concernés.
- Fichiers SQL : `supabase/migrations/0055_deliveries_returns.sql` ; `web/tests/sql/deliveries_returns.test.mjs` (33 assertions).
- Fichiers web : `web/src/features/shipments/returns-actions.ts` (8 actions) ; `web/src/app/(erp)/shipments/returns/page.tsx` (lots, affectation, confirmation de livraison, retours et règlement) ; messages d'erreur dans `web/src/features/orders/order-errors.ts`.
- Tests réellement exécutés :
  - `deliveries_returns` : 33 PASS / 0 FAIL. BL répété : second envoi refusé ; stock et lot inchangés ; une seule sortie de stock ; reprint sans effet. Livraison confirmée une seule fois (clé rejouée = même confirmation ; autre clé refusée ; quantité livrée comptée une fois). Lot non conforme : marquage sans motif refusé ; stock restant bloqué ; affectation refusée ; jamais consommé (qty_out 0). BL partiel : 20 livrées sur 30, reliquat 10. Retour : quantité excessive refusée ; lot étranger refusé ; règlement refusé avant réception, avant décision ; accepté → 123 en stock dont 50 bloqués (90 + 50 − 20 + 3) ; refusé → lot non conforme, stock inchangé ; aucun avoir créé par les retours ; second règlement refusé.
  - `orders_backorders` : 40/40 PASS et `credit_margin_availability` : 36/36 PASS, après mise à jour des fixtures d'expédition décrite ci-dessus.
  - `rbac` : 63/63 PASS (liste incluant 0055).
  - `tsc --noEmit` : sans erreur.
  - Suite SQL complète (`npm run test:sql`) : exit 0, 2741 PASS, 0 FAIL.
- Corrections trouvées pendant les tests (P030) : deux attentes de test (reliquat compté sur ce qui est livré, stock comprenant le lot non conforme) ; un `await` dans une fonction fléchée ; une fixture de retour (quantité) — toutes corrigées côté test, aucune correction de règle nécessaire.
- Limites :
  - Le picking peut encore réserver du stock bloqué : le refus intervient à l'expédition (affectation de lot libéré exigée). Un blocage au picking reste à faire (QUA-03).
  - Le remboursement n'est pas implémenté : un retour n'a aucun lien automatique avec un avoir ou un paiement.
  - Colis : seul le nombre de colis est enregistré (pas d'étiquette ni de numéro par colis).
  - Un lot non conforme dont une partie est réservée à une expédition ouverte ne peut pas être bloqué tant que cette réservation existe (le blocage refuse le stock non libre).
  - Retour : la décision « conditionnel » est traitée comme refus (lot non conforme), sans voie de réparation.
  - Lots de produits finis : pas de lien automatique avec l'ordre de fabrication ni de génération de la numérotation de lot.
  - Écran non vérifié dans un navigateur connecté ; migration non appliquée à la base locale réelle.
- Décisions à valider par le propriétaire : un retour « conditionnel » est-il vendable après reprise ; le picking doit-il refuser le stock bloqué ; un lot de retour accepté prend-il un code distinct (choisi : RET-numéro) ; le remboursement fait-il l'objet d'un lot dédié.
- Prochain lot : blocage du stock au picking ; remboursement et lien retour ↔ avoir ↔ paiement (opérations distinctes) ; colis individualisés ; vérification navigateur.

### P031 — facturation commerciale et avoirs (migration 0056)
- Objectif : facturation selon contrat (commande) ou selon livraison (BL), acomptes imputés sur facture, avoirs bornés et liés à leur facture, idempotence à la reprise, facture émise immuable, régularisation traçable.
- Identifiants matrice : ADV-04 reste « Partiel » (facturation sur livré et acomptes ajoutés, flux export inchangé) ; écarts mis à jour dans `docs/MATRICE_ECARTS_CDC.md`.
- Existant conservé et réutilisé : factures et lignes, émission, annulation de brouillon, encaissements, avoirs (0012) inchangés dans leur comportement ; `doc_recalc` (totaux) inchangé ; verrouillage des documents non brouillon (`COMMERCIAL_LOCKED`) ; numérotation `private.next_seq` ; expéditions et BL (0021) ; contrôle de crédit (0053).
- Ajouts SQL (0056), additifs :
  - Colonnes : `invoices.kind` (`standard` | `deposit`, défaut `standard`) ; `invoice_lines.shipment_line_id` (lien ligne de facture ↔ ligne de BL).
  - `commercial_idempotency` : clé par société et par portée (`invoice-deposit`, `invoice-shipment`), avec la requête mémorisée ; même clé et même requête = même document ; clé réutilisée pour une autre requête = refus.
  - `invoice_deposit_create(commande, montant HT, clé)` : facture d'acompte brouillon, une ligne hors commande (ne consomme pas `qty_invoiced`) ; somme des acomptes (hors annulés et crédités) ≤ sous-total HT de la commande.
  - `invoice_deposit_apply(facture finale, acompte, montant TTC)` : facture finale standard émise, acompte émis, même client et même commande ; montant ≤ solde de l'acompte ET ≤ solde de la facture ; trace dans `invoice_deposit_applications` ; l'acompte et la facture sont tous deux mis à jour (`paid_amount`, statut recalculé).
  - `invoice_from_shipment(expédition, clé)` : BL expédié ou livré → facture brouillon ; quantité = expédié − facturé net (factures émises moins avoirs) − brouillons ; l'article doit figurer une seule fois dans la commande ; la quantité brouillons compris ne dépasse pas le reste de la ligne de commande.
  - `shipment_billing_status(expédition)` : par ligne de BL, quantité expédiée, facturée nette, en brouillon (rapprochement BL / facture).
  - Déclencheur `credit_notes_bound_bu` : avoir émis refusé (`CREDIT_OVER_BALANCE`) si son total dépasse le solde de la facture ; pour un acompte, le solde est diminué de ce qui est déjà imputé sur des factures.
- Droits : aucun nouveau. Création d'acompte et facturation par BL : `invoices.write` ; imputation d'acompte : `invoices.write` ET `payments.write` ; lecture du rapprochement : `invoices.read` ou `shipments.read`.
- Fichiers SQL : `supabase/migrations/0056_invoicing_deposits_bl.sql` ; `web/tests/sql/invoicing_deposits.test.mjs`.
- Fichiers web : `web/src/features/commercial/actions.ts` (trois actions : `createDepositInvoiceAction`, `applyDepositAction`, `invoiceFromShipmentAction`) ; `web/src/features/commercial/errors.ts` (messages des nouveaux codes).
- Enregistrements de tests : `web/package.json` (`test:sql`) et liste de migrations de `web/tests/sql/rbac.test.mjs` (incluant 0056).
- Tests réellement exécutés :
  - `invoicing_deposits` : 35 assertions, toutes PASS. Couvre : reprise d'acompte avec la même clé ; clé réutilisée refusée ; dépassement du sous-total refusé ; droits ; facturation par BL refusée sur expédition non expédiée ; reprise de facture BL sans doublon ; même BL refacturé refusé ; rapprochement avant et après émission ; imputation refusée (brouillon, autre commande, droits, montant nul, au-delà du solde) ; imputation réussie avec acompte soldé ; facture émise non modifiable hors fonction ; avoir sur acompte au-delà du solde refusé et resté en brouillon ; avoir total sur facture ; second avoir refusé ; émission répétée refusée ; numéro stable.
  - Non-régression, exécutées dans cette session : `rbac`, `credit_margin_availability`, `deliveries_returns`, `commercial`, `orders_backorders` : aucun FAIL.
  - `tsc --noEmit` (web) : sans erreur.
  - Suite SQL complète (`npm run test:sql`) : exit 0, 2774 PASS, 0 FAIL (log de la session, `SUITE_EXIT=0`).
- Limites :
  - Aucune règle d'arrondi validée par la finance n'est présente dans le dépôt. Les totaux restent ceux de `doc_recalc` (arrondi par ligne à 2 décimales, TVA arrondie sur le HT du document). Ce choix n'est pas une règle validée ; aucune valeur n'est introduite.
  - Acompte : montant saisi HT à la création ; imputation exprimée en TTC (unité des totaux de facture). La TVA d'un acompte suit le taux de la commande à la création ; une règle fiscale spécifique de l'acompte n'est pas tranchée.
  - Pas d'annulation d'une imputation d'acompte : une imputation est définitive ; la régularisation passe par avoir sur facture finale, et l'acompte ne se rembourse que par avoir sur acompte (borné).
  - Facturation par BL et facturation par commande (`invoice_from_order`, inchangée) partagent la borne `sales_order_lines.qty_invoiced` ; la facturation par commande ne considère pas les brouillons par BL (ni l'inverse, hors brouillons déjà pris en compte par chaque chemin). Le second chemin ne vérifie les brouillons qu'à l'émission (`INVOICE_OVER_INVOICED`).
  - Un avoir remettant un BL en facturation : la quantité BL redevient facturable en net, mais la borne de commande (`qty_invoiced`, gross des avoirs sans `reopen`) l'empêche sauf si l'avoir est émis avec réouverture de commande. Comportement cohérent avec 0012, à valider.
  - Clé d'idempotence : fournie par le formulaire. Une clé nouvelle à chaque rendu de formulaire crée une nouvelle tentative, bornée par les quantités : aucune double facturation possible, mais pas de dédoublonnage par document.
  - Écrans : seules les actions serveur sont livrées. Aucune page ni formulaire n'expose encore l'acompte, l'imputation ou la facturation par BL. Non vérifié dans un navigateur.
  - Migration non appliquée à la base locale réelle (`erp360_real`).
- Décisions à valider par le propriétaire : règle d'arrondi finance (à fournir, aucune valeur inventée) ; TVA applicable à l'acompte ; imputation d'acompte réversible ou non ; acompte remboursable seulement par avoir ; facturation par BL et par commande : laquelle est la voie par défaut pour chaque client.
- Prochain lot : écrans acompte / imputation / facturation par BL (liste, détail, formulaires) ; règle d'arrondi validée ; vérification navigateur.

### P032 — demandes d'achat et budget (migration 0057)
- Objectif : demande d'achat avec société, centre de coût, article, unité, quantité, date et motif ; budget par centre et période ; engagé et réalisé séparés ; contrôle à la soumission ; workflow de seuils ; demandeur sans auto-approbation ; délégation bornée.
- Identifiants matrice : ACH-01 reste « Partiel » (`docs/MATRICE_ECARTS_CDC.md`) ; écarts mis à jour.
- Existant conservé et réutilisé : demandes et lignes d'achat, commandes, réceptions, retours (0011) ; centres de coût (0042) ; moteur d'approbation, politiques par seuil, délégations, journal, escalade (0043) ; prix matière (0008, `bom_material_prices`) pour l'estimation.
- Ajouts SQL (0057), additifs :
  - `purchase_requests.cost_center_id` (clé composite avec `cost_centers`) ; `purchase_request_lines.est_unit_cost` (estimation) ; droits d'écriture de colonne ajoutés.
  - `purchase_budgets` : montant par centre et période, sans chevauchement, période fixe après création, montant jamais inférieur à l'engagé + le réalisé (`purchase_budget_set`, droit `finance.write`) ; lecture `purchase_budget_summary` (droit `purchases.read`).
  - Engagé = lignes de demandes soumises ou approuvées non converties + reste à recevoir des commandes ouvertes (brouillon, envoyée, partielle) rattachées à une demande. Réalisé = quantités reçues nettes des retours, au prix de commande.
  - Soumission (`purchase_request_submit`, remplacée) : estimation reprise du prix catalogue si absente ; si un centre est renseigné : motif obligatoire, estimation obligatoire, budget défini pour la date, montant ≤ disponible (`BUDGET_EXCEEDED`, `BUDGET_NOT_DEFINED`, `PURCHASE_REASON_REQUIRED`, `PURCHASE_ESTIMATE_REQUIRED`) ; verrou par centre pour éviter deux soumissions concurrentes sur le même reliquat.
  - Si une politique `purchase_request` existe : une demande d'approbation est ouverte (moteur 0043) ; le montant sert au seuil ; le demandeur ne peut pas décider, et le niveau 2 doit être un autre approbateur.
  - Retour d'approbation vers la demande : approuvée, refusée (motif visible sur la DA), ou revenue en brouillon si annulée ou invalidée (trigger `approval_requests_purchase_sync_au`).
  - Décision directe (`purchase_request_decide`, remplacée) : refusée (`PURCHASE_USE_APPROVAL`) quand une demande d'approbation est ouverte ; sans politique, le comportement est inchangé.
  - Annulation (`purchase_request_cancel`, remplacée) : ferme la demande d'approbation ouverte (journalisée) et libère l'engagé ; l'annulation n'enregistre pas de décideur.
- Droits : aucun nouveau. Budget : `finance.write` ; lecture : `purchases.read` ; demande : `purchases.request` (ou écriture) ; décision : `purchases.approve` (niveau 1, selon la politique) et `approvals.decide_high` (niveau 2, selon la politique).
- Fichiers SQL : `supabase/migrations/0057_purchase_budget_approval.sql` ; `web/tests/sql/purchase_budget_approval.test.mjs`.
- Enregistrements : `web/package.json` (`test:sql`) ; liste de migrations de `web/tests/sql/rbac.test.mjs` (incluant 0057).
- Tests réellement exécutés :
  - `purchase_budget_approval` : 36 PASS, 0 FAIL, exit 0. Couvre : budget (droits, période, chevauchement, lecture) ; soumission (motif, estimation catalogue, budget dépassé, centre sans budget, estimation absente) ; séparation des tâches (auto-approbation refusée et journalisée, décision directe refusée, droits) ; seuil de niveau 2 (SOD d'indépendance, approbateur distinct) ; refus visible et engagé libéré ; motif de refus trop court refusé sans changement d'état ; annulation libère l'engagé ; délégation bornée (au-delà de la limite refusée, dans la limite acceptée et tracée au nom du délégant) ; transformation en commande sans double comptage ; réception partielle : réalisé 340 et engagé diminué d'autant ; journal et audit.
  - Non-régression : `rbac` 63/63 ; `purchases` 99/99 ; `approvals_engine` 63/63 ; `events_notifications` 45/45.
  - Suite SQL complète (`npm run test:sql`) : exit 0, 2810 PASS, 0 FAIL (log de la session, `SUITE_EXIT=0`).
- Corrections trouvées pendant les tests : l'annulation par le demandeur écrivait le demandeur comme décideur, refusé par la contrainte `decided_by <> requested_by` (0043) — corrigée dans la migration (l'annulation n'est pas une décision) ; un test appliquait la décision de niveau 1 à la mauvaise demande — corrigé côté test ; la réception exige un bon de commande envoyé — ajouté au test.
- Limites :
  - Écrans livrés en complément (voir « Compléments écrans » ci-dessous) ; non vérifiés dans un navigateur connecté : la vérification visuelle reste à faire.
  - Une commande fournisseur saisie sans demande d'achat n'est rattachée à aucun centre : elle n'est pas budgétée (ni engagée, ni réalisée).
  - Pas de budget par article, pas de budget sur plusieurs périodes (un montant par centre et période, sans chevauchement).
  - Le niveau 2 n'est pas conditionné au budget : un dépassement est refusé à la soumission, sans voie de dérogation budgétaire.
  - Un retour fournisseur réduit le réalisé mais ne rétablit pas l'engagé du reliquat déjà reçu.
  - Migration non appliquée à la base locale réelle (`erp360_real`).
- Décisions à valider par le propriétaire : voie de dérogation budgétaire (niveau 2 ou refus définitif) ; rattachement des commandes manuelles à un centre ; budget par article ou par famille ; estimation de référence : dernier prix catalogue (choisi) ou prix saisi par le demandeur.
- Compléments écrans (même lot) :
  - `web/src/features/purchases/services/purchases.service.ts` : `costCenterOptions`, `budgetState` (appel `purchase_budget_summary`), `budgetRows`, `requestApproval` (demande d'approbation la plus récente), `getRequest` expose `cost_center_id`.
  - `web/src/features/purchases/actions.ts` : `createRequestAction` (centre de coût), `addRequestLineAction` (coût unitaire estimé, optionnel), `decideApprovalAction` (appel `approval_decide` : approbation ou refus avec motif, messages dédiés aux refus de séparation des tâches), `setBudgetAction` (`purchase_budget_set`, droit `finance.write`).
  - `web/src/features/purchases/components/request-forms.tsx` : champ centre de coût, estimation par ligne, `ApprovalDecideDialog` (niveau 1 ou 2 selon l'état).
  - `web/src/features/purchases/components/budget-forms.tsx` : création d'un budget ; révision du seul montant d'un budget existant.
  - `web/src/app/(erp)/purchases/budgets/page.tsx` : tableau des budgets avec engagé, réalisé, disponible ; formulaire réservé à `finance.write`.
  - `web/src/app/(erp)/purchases/requests/[id]/page.tsx` : panneau budget du centre, état du workflow (niveau 1, niveau 2, refus avec motif), décision selon le niveau ; `requests/new` passe la liste des centres.
  - `web/src/features/purchases/components/purchases-nav.tsx` : onglet « Budgets ».
  - `web/src/features/purchases/errors.ts` : messages des codes budget et approbation ; le message de `PURCHASE_REASON_REQUIRED` couvre désormais la demande budgétée.
- Tests complémentaires : `web/tests/unit/purchase-budget-messages.test.mjs` (8 PASS) ; `npm run test:unit` : 214 PASS, 0 FAIL ; `npx tsc --noEmit` : sans erreur.
- Limites des compléments : le panneau budget est vide pour un profil sans « Voir les achats » (le message le dit) ; le niveau 2 peut être affiché au niveau 1 : la base refuse la décision, le message le précise ; pas de vérification navigateur.
- Prochain lot : vérification navigateur des écrans budget et demande ; vue d'engagé et de réalisé par centre dans le tableau de bord ; commandes manuelles rattachées à un centre.

### P033 — consultations et comparatifs fournisseurs (migration 0058)
- Objectif : appels d'offres sur une base identique, offres originales versionnées (devise d'origine, transport, droits, délai, incoterm, référence et empreinte), coût rendu en devise de base, scoring transparent, classement, attribution par décision humaine motivée et approuvée.
- Identifiants matrice : ACH-02 passe à « Partiel » ; ACH-05 reste « Absent » (la notation fournisseur existante est utilisée par le comparatif) ; écarts mis à jour dans `docs/MATRICE_ECARTS_CDC.md`.
- Existant conservé et réutilisé : fournisseurs (0006 : qualification, notation 1-5, archivage) ; composants (0008) ; demandes d'achat (0011) ; devises et taux figés (0027 : `fx_rate` lève `FX_RATE_MISSING` si aucun taux ; `fx_convert` arrondit à la devise de base) ; moteur d'approbation (0043 : politique `sourcing_award`, séparation des tâches, délégation, journal) ; empreinte (`approval_hash`) ; numérotation (`next_seq`).
- Ajouts SQL (0058), additifs, aucune fonction existante modifiée :
  - `sourcing_events` (CON-nnnn ; statuts brouillon, ouverte, clôturée, attribuée ; pondérations saisies à l'ouverture, somme 100, sans valeur par défaut) ; `sourcing_event_lines` (lignes et quantités communes).
  - `sourcing_offers` (une par fournisseur et consultation) ; `sourcing_offer_versions` (immuables : devise, incoterm, délai, transport, droits, validité, référence et empreinte SHA-256 de l'original) ; `sourcing_offer_version_lines` (un prix unitaire par ligne de la consultation).
  - `sourcing_event_create`, `sourcing_event_open`, `sourcing_offer_submit` (fournisseur qualifié seulement ; toutes les lignes, une fois chacune ; taux de change requis ; révision = version suivante), `sourcing_event_close` (au moins une offre).
  - `sourcing_compare` (lecture : `purchases.read`) : refusé avant clôture ; refus si un fournisseur n'a pas de notation ; coût rendu = Σ(prix × quantité) + transport + droits, converti au taux du jour d'ouverture ; scores : prix = 100 × min / coût ; délai = 100 × (max − délai) / (max − min), 100 si égaux ; qualité = 20 × notation ; total = Σ(poids × score) / 100 ; rang ; formule renvoyée avec le résultat.
  - `sourcing_award_request` : clôture requise, aucune demande en attente, motif de 20 caractères minimum, version courante seulement (`SOURCING_STALE_VERSION`), politique `sourcing_award` requise ; la version et le classement sont figés dans la demande d'approbation.
  - Trigger `approval_requests_sourcing_sync_au` : approuvée → consultation attribuée (version, décideur, motif, date) ; refusée ou annulée → consultation de nouveau attribuable, motif de refus visible dans la demande.
- Droits : `purchases.write` pour créer, ouvrir, saisir des offres, clôturer et demander l'attribution ; `purchases.read` pour lire ; décision par la politique d'approbation (niveau 1 `purchases.approve` dans le test). Aucune écriture directe des tables (fonctions seulement).
- Fichiers SQL : `supabase/migrations/0058_sourcing_tenders_comparison.sql` ; `web/tests/sql/sourcing_tenders.test.mjs`.
- Fichiers web : `web/src/features/sourcing/services/sourcing.service.ts` ; `web/src/features/sourcing/actions.ts` (création, ouverture, offre, clôture, demande d'attribution) ; `web/src/features/sourcing/components/sourcing-forms.tsx` ; pages `web/src/app/(erp)/purchases/sourcing/` (liste, nouvelle consultation, détail avec comparatif) ; onglet « Consultations » ; messages d'erreur dans `web/src/features/purchases/errors.ts`.
- Enregistrements : `web/package.json` (`test:sql`, `test:unit`) ; liste de migrations de `web/tests/sql/rbac.test.mjs` (incluant 0058) ; `web/tests/unit/purchase-budget-messages.test.mjs` (messages P033 ajoutés).
- Tests réellement exécutés :
  - `sourcing_tenders` : 43 PASS, 0 FAIL. Couvre : création, pondérations invalides, fournisseur non qualifié, offre incomplète, devise sans taux (`FX_RATE_MISSING`), empreinte invalide, droits ; versions conservées et immuables ; comparatif refusé avant clôture ; base identique ; coûts rendus recalculés dans le test (A 1 030,00 ; B 852,00 ; C 1 008,00 EUR) ; scores et classement recalculés ; motif et version obsolète refusés ; demande en attente sans attribution automatique ; auto-approbation refusée et tracée ; approbation : version, décideur et motif figés ; seconde attribution refusée ; notation manquante refusée ; refus humain avec motif visible et nouvelle demande possible ; journal et audit.
  - Régressions : rbac 63/63 ; purchases 99/99 ; approvals_engine 63/63 ; purchase_budget_approval 36/36 ; events_notifications 45/45.
  - `npm run test:unit` : 218 PASS, 0 FAIL, exit 0.
  - `npx tsc --noEmit` (web) : sans erreur.
  - Suite SQL complète (`npm run test:sql`) : exit 0, 2853 PASS, 0 FAIL (log de la session, `SUITE_EXIT=0`).
- Corrections trouvées pendant les tests : boucles `for ... in select * from jsonb_array_elements` (valeur de ligne au lieu du jsonb) et alias jsonb mal référencés — corrigés dans la migration ; fixture fournisseur sous rôle achat sans ligne renvoyée — fixture passée en accès direct, comme les autres fixtures.
- Limites :
  - Pas de génération de commande fournisseur à l'attribution (le bon de commande reste à créer à la main).
  - Pas de portail fournisseur ; les offres sont saisies par l'acheteur.
  - La notation fournisseur est saisie sur la fiche (1 à 5) ; aucune scorecard calculée (ACH-05 reste absent).
  - Les originaux sont tracés par référence et empreinte SHA-256 saisies, sans stockage du document (les pièces GED sont rattachées à un client, pas à un fournisseur).
  - Une seule politique d'attribution par société ; pas de comparatif par article ni par lot.
  - Écrans non vérifiés dans un navigateur connecté ; migration non appliquée à la base locale réelle (`erp360_real`).
- Décisions à valider par le propriétaire : pondérations du scoring par défaut (aucune retenue : saisie à chaque consultation) ; règle de notation fournisseur (1 à 5 saisi, ou scorecard calculée) ; seuil de montant pour l'attribution ; génération de commande à l'attribution ou non.
- Prochain lot : génération de la commande à partir de l'offre retenue ; scorecard fournisseur calculée (ACH-05) ; vérification navigateur des écrans consultations.

### P034 — commandes achats : versions, accord, confirmation, modification approuvée (migration 0059)
- Objectif : bon de commande versionné ; soumission à accord ; envoi seulement de la version approuvée et inchangée depuis l'accord ; confirmation fournisseur avec référence ; modification approuvée (nouvelle version, lignes inchangées avant approbation, quantité jamais sous le reçu) ; reliquats ; commandes ouvertes anciennes et références conservées.
- Identifiants matrice : ACH-03 reste « Partiel » (`docs/MATRICE_ECARTS_CDC.md`) ; écarts mis à jour.
- Existant conservé et réutilisé : commandes, lignes, réceptions et retours (0011) ; numérotation PO ; moteur d'approbation (0043 : politique `purchase_order`, séparation des tâches, journal) ; empreinte (`approval_hash`) ; verrou de commande (`PURCHASE_LOCKED`).
- Ajouts SQL (0059), additifs :
  - Colonnes sur `purchase_orders` : version courante, version approuvée, version envoyée, version confirmée, date, auteur et référence de confirmation, drapeau d'accord en attente.
  - `purchase_order_versions` (immuable, écrite par fonction seulement) : version, nature (soumission, modification, historique), état (proposée, approuvée, refusée, remplacée, annulée), contenu, empreinte SHA-256, total, motif, demande d'accord liée.
  - `purchase_order_confirmations` : une confirmation par version, avec référence et date.
  - `purchase_order_submit` : version initiale et demande d'accord ; une seule demande ouverte à la fois.
  - `purchase_order_send` (remplacée) : refusée sans version approuvée (`PO_NOT_APPROVED`), si le contenu a changé depuis l'accord (`PO_CHANGED_AFTER_APPROVAL`), ou si une demande est en attente.
  - `purchase_order_amend` : nouvelle version proposée ; aucune ligne modifiée avant approbation ; quantité ≥ reçu + retourné ; motif obligatoire.
  - `purchase_order_send_amendment` : envoi explicite de la modification approuvée ; refusé si rien de nouveau.
  - `purchase_order_confirm` : seulement pour la version envoyée ; référence de 3 caractères minimum ; pas de date future ; une seule confirmation par version.
  - `purchase_order_cancel` (remplacée) : ferme la demande d'accord ouverte (journalisée), version annulée.
  - `purchase_order_remaining` : reliquats par ligne (commandé, reçu, retourné, restant).
  - Trigger `approval_requests_po_sync_au` : approuvée → version approuvée (une modification est appliquée aux lignes, la quantité étant revalidée à ce moment) ; refusée ou annulée → version refusée ou annulée, rien ne change.
  - Reprise des commandes existantes (envoyées, reçues, annulées) : une version « historique » approuvée, marquée « accord non tracé », sans modifier leur contenu ni leur référence.
- Droits : `purchases.write` pour soumettre, envoyer, confirmer, modifier et annuler ; `purchases.read` pour lire ; décision par la politique `purchase_order` (niveau 1 `purchases.approve` dans le test). Aucune écriture directe des tables de versions.
- Fichiers SQL : `supabase/migrations/0059_purchase_orders_versions_confirmations.sql` ; `web/tests/sql/purchase_orders_versions.test.mjs`.
- Fichiers web : `web/src/features/purchases/actions.ts` (soumission, confirmation, modification, envoi de la modification) ; `web/src/features/purchases/services/purchases.service.ts` (`orderState`, `orderVersions`) ; `web/src/features/purchases/components/po-version-forms.tsx` ; `web/src/app/(erp)/purchases/orders/[id]/page.tsx` (soumission, envoi après accord, confirmation, modification, historique) ; messages dans `web/src/features/purchases/errors.ts`.
- Tests adaptés (règle renforcée : pas d'envoi sans accord) : `purchases.test.mjs` (charge désormais toutes les migrations, teste l'envoi refusé sans accord puis approuve avant envoi) ; `purchase_budget_approval.test.mjs` (approuve la commande avant envoi).
- Enregistrements : `web/package.json` (`test:sql`) ; liste de migrations de `web/tests/sql/rbac.test.mjs` (incluant 0059).
- Tests réellement exécutés :
  - `purchase_orders_versions` : 36 PASS, 0 FAIL. Couvre : envoi refusé sans accord ; soumission en attente ; seconde soumission refusée ; refus visible, version 1 refusée ; version 2 approuvée ; contenu modifié après accord refusé à l'envoi, retour au contenu approuvé accepté ; confirmation (version incorrecte, référence absente, date future, double confirmation) ; réception partielle ; modification refusée (motif, ligne manquante, quantité sous le reçu) ; modification proposée sans effet sur les lignes ; refus de la modification ; modification approuvée appliquée (total 1 224,00) ; envoi de la modification ; confirmation de la version 4 ; historique complet ; reliquat 80 ; référence conservée ; versions immuables ; annulation fermant l'accord ; commande ancienne reprise en historique ; audit.
  - Régressions : `purchases` 100/100 ; `purchase_budget_approval` 36/36 ; `rbac` 63/63 ; `approvals_engine` 63/63 ; `events_notifications` 45/45 ; `sourcing_tenders` 43/43.
  - `npm run test:unit` : 218 PASS, 0 FAIL, exit 0.
  - `npx tsc --noEmit` (web) : sans erreur.
  - Suite SQL complète (`npm run test:sql`) : exit 0, 2890 PASS, 0 FAIL (log de la session, `SUITE_EXIT=0`).
- Corrections trouvées pendant les tests : une commande ancienne insérée sans drapeau RPC était forcée en brouillon par le garde (fixture corrigée) ; la reprise modifiait des commandes envoyées sans drapeau (drapeau ouvert pendant la reprise) ; une modification sans date de livraison aurait écrit une date nulle, invalidant l'empreinte (date actuelle conservée) ; `create function` sur une fonction existante remplacé par `create or replace` ; deux tests chargeaient une liste de migrations figée (chargement complet).
- Limites :
  - Pas de portail fournisseur : la confirmation est saisie par l'acheteur, sur la foi de la confirmation écrite reçue.
  - La transmission d'une modification est tracée par l'envoi explicite, sans preuve de réception chez le fournisseur.
  - Seuils d'approbation par montant : dépendent d'une politique `purchase_order` à configurer par société ; aucune valeur n'est inventée.
  - Les montants d'accord sont arrondis à 2 décimales (les devises à 3 décimales ne sont pas arrondies à leur précision pour le seuil).
  - Pas d'ajout ni de suppression de ligne après soumission ; une nouvelle commande est nécessaire.
  - Écrans non vérifiés dans un navigateur connecté ; migration non appliquée à la base locale réelle (`erp360_real`).
- Décisions à valider par le propriétaire : seuils et approbateurs de la politique `purchase_order` ; confirmation par le fournisseur via portail ou saisie ; ajout de lignes après soumission (nouvelle version ou non).
- Prochain lot : seuils de commande configurés et vérifiés ; portail fournisseur (confirmation) ; vérification navigateur des écrans achats.

### P035 — réception et rapprochement trois voies (migration 0060)
- Objectif : reçu / accepté / rejeté / facturable ; contrôle à la réception ; quarantaine ; retours ; tolérances commande–réception–facture ; écart bloquant mis en litige ; paiement distinct du rapprochement.
- Identifiants matrice : ACH-04 reste « Partiel » ; écarts mis à jour dans `docs/MATRICE_ECARTS_CDC.md`.
- Existant conservé et réutilisé : réceptions, lignes, retours (0011 : `purchase_receive`, `purchase_return`) ; emplacements de type quarantaine (0009) ; transferts (`stock_move`) ; factures et litiges fournisseur (0022) ; ordres de paiement approuvés (0033/0034).
- Ajouts SQL (0060), additifs ; deux fonctions remplacées avec le même contrat :
  - `purchase_match_tolerances` (une ligne par société, saisie par `purchase_tolerance_set`, droit `finance.write`) ; absente = tolérance nulle, aucune valeur inventée.
  - `purchase_receipt_inspections` : une décision par ligne reçue, accepté + rejeté = reçu ; rejet = `purchase_return` réel (RET-nnnn) ; accepté = transfert de la quarantaine vers un emplacement de stockage (`purchase_receipt_line_decide`). Droits : `quality.write`, `purchases.receive`, `stock.write` ; le réceptionnaire ne décide pas (SOD).
  - `purchase_order_acceptance` : par ligne, commandé, reçu, rejeté, accepté, non contrôlé, facturable (= accepté).
  - `purchase_invoice_matches` (historique append-only) et `supplier_invoice_match` : compare la facture au montant accepté valorisé au prix de commande, avec tolérance ; statuts `matched`, `blocked`, `no_order`, `currency_mismatch` ; écart, facture au-delà de la commande, ou réception non contrôlée → facture mise en litige ; conforme → litige levé.
  - `private.invoice_match_ok` et `private.supplier_payment_apply` (remplacée) : un règlement n'impute qu'aux factures dont le dernier rapprochement est conforme, ou sans commande (comportement antérieur).
- Droits : `quality.write` (décision), `purchases.receive` (retour), `stock.write` (transfert), `finance.write` (rapprochement, tolérances), `purchases.read` (lecture).
- Fichiers SQL : `supabase/migrations/0060_three_way_match.sql` ; `web/tests/sql/three_way_match.test.mjs`.
- Fichiers web : `web/src/features/purchases/actions.ts` (`decideReceiptLineAction`, `matchInvoiceAction`) ; `web/src/features/purchases/services/purchases.service.ts` (`receiptInspections`, `storageLocations`, `orderAcceptance`, `invoicesOfOrder`, `getReceipt` expose `warehouse_id`) ; `web/src/features/purchases/components/receipt-inspection-forms.tsx` ; pages `receipts/[id]` (contrôle) et `orders/[id]` (acceptation, factures liées, rapprochement) ; messages dans `web/src/features/purchases/errors.ts`.
- Enregistrements : `web/package.json` (`test:sql`) ; liste de migrations de `web/tests/sql/rbac.test.mjs` (incluant 0060).
- Tests réellement exécutés :
  - `three_way_match` : 26 PASS, 0 FAIL. Cas de l'énoncé : 1000 commandés, 980 reçus en quarantaine, 20 rejetés, 960 acceptés, 960 facturables ; facture 8 500 contre 8 160 acceptés : écart 340 bloquant, litige affiché ; tolérance 5 % absorbe l'écart et lève le litige ; paiement par ordre approuvé après conformité ; facture sans commande non applicable ; contrôle refusé au réceptionnaire, sans droit qualité, quantité incohérente, motif absent, destination manquante ou invalide, décision répétée.
  - Régressions : `rbac` 63/63 ; `finance` 46/46 ; `delegations` 61/61 ; `general-ledger` 34/34 ; `multicurrency` 44/44 ; `audit` 32/32 ; `purchases` 100/100 ; `purchase_orders_versions` 36/36 ; `purchase_budget_approval` 36/36.
  - `npm run test:unit` : 218 PASS, 0 FAIL.
  - `npx tsc --noEmit` (web) : sans erreur.
  - Suite SQL complète (`npm run test:sql`) : exit 0, 2916 PASS, 0 FAIL (log de la session, `SUITE_EXIT=0`).
- Limites :
  - Décision par ligne uniquement : pas de contrôle partiel d'une ligne reçue.
  - Facture sans commande : non rapprochée, payable comme avant (services et frais hors commande).
  - Tolérances non paramétrées par défaut (zéro) ; les valeurs réelles sont à fournir par le propriétaire.
  - Montant de facture comparé au montant accepté sans gestion de TVA : montant supposé HT, à confirmer.
  - La quarantaine est un emplacement : elle n'empêche pas, à elle seule, la sortie de stock au picking.
  - Un écart « facture inférieure à l'accepté » est aussi bloquant (choix à valider : facturation partielle).
  - Écrans non vérifiés dans un navigateur connecté ; migration non appliquée à la base locale réelle (`erp360_real`).
- Décisions à valider par le propriétaire : valeurs de tolérance par société ; base HT ou TTC de comparaison des factures ; blocage ou non d'une facture partielle inférieure à l'accepté ; quarantaine bloquante au picking ou non.
- Prochain lot : picking qui exclut la quarantaine ; facturation partielle ; vérification navigateur des écrans achats.

### P036 — évaluation fournisseur et délais (migration 0061)
- Objectif : ponctualité, défauts, écart prix, réactivité et documents par période ; retard confirmé distinct de la prévision ; alertes ; brouillons de réapprovisionnement ; aucune commande ferme autonome ; échantillon faible signalé.
- Identifiants matrice : ACH-05 passe à « Partiel » (`docs/MATRICE_ECARTS_CDC.md`).
- Existant conservé et réutilisé : réceptions et commandes (0011 : dates prévues, quantités, prix) ; confirmations fournisseur (0059) ; contrôles à la réception et défauts (0020 : `quality_inspections.purchase_receipt_id`, `sample_size`, `quality_defects`) ; prix matière (0008) ; propositions MRP (0010, `request_id` 0011) ; demandes d'achat (0011).
- Ajouts SQL (0061), additifs :
  - `supplier_score_policies` : pondérations des cinq indicateurs (toutes saisies ou toutes absentes, total 100), seuil d'échantillon, délai cible de confirmation, seuil d'alerte prix. Aucune valeur par défaut : sans politique, aucun score composite n'est calculé. Saisie `supplier_policy_set` (droit `approvals.manage`).
  - `supplier_evaluations` : évaluations conservées, ajout seul (trigger `EVAL_APPEND_ONLY`).
  - `supplier_indicators` (calcul seul) : chaque indicateur est une fraction explicite (numérateur, dénominateur, formule) ; ponctualité = réceptions à la date prévue ou avant ; défauts = quantité défectueuse / quantité contrôlée ; écart prix = Σ quantité × (prix commande − prix catalogue) / Σ quantité × prix catalogue ; réactivité = confirmations dans le délai cible ; documents = (réceptions avec bon de livraison + confirmations) / (réceptions + confirmations). Score composite = Σ poids × sous-scores / 100, uniquement si tous les indicateurs ont des données.
  - Retard CONFIRMÉ = réception effective après la date prévue. PRÉVISION = commande ouverte dont la date prévue est dépassée sans réception ; jamais additionnés.
  - Signalements : `AUCUNE_RECEPTION_PERIODE`, `ECHANTILLON_FAIBLE`, `POLITIQUE_NON_PARAMETREE`, `PRIX_CATALOGUE_MANQUANT`, `DEFAUT_CRITIQUE`, `ECART_PRIX_AU_DELA_SEUIL`, `PREVISION_RETARD`.
  - `supplier_evaluate_preview` (lecture, droit `purchases.read`) ; `supplier_evaluate` (enregistrement, droit `purchases.write`, audit).
  - `supplier_reorder_draft(fournisseur, passage MRP)` : crée une demande d'achat en BROUILLON à partir des propositions MRP du fournisseur, et rattache les suggestions. Jamais de commande ferme, jamais de soumission ni d'approbation.
- Droits : `approvals.manage` (politique), `purchases.read` (lecture), `purchases.write` (évaluation enregistrée, brouillon de réapprovisionnement).
- Fichiers SQL : `supabase/migrations/0061_supplier_evaluation.sql` ; `web/tests/sql/supplier_evaluation.test.mjs`.
- Fichiers web : `web/src/features/purchases/services/purchases.service.ts` (`supplierEvaluationPreview`) ; `web/src/features/purchases/actions.ts` (`saveSupplierEvaluationAction`) ; page `web/src/app/(erp)/purchases/evaluation/page.tsx` (choix fournisseur et période, indicateurs avec formules, alertes, score ou motif d'absence, retard confirmé et prévision séparés, enregistrement) ; onglet « Évaluation » ; messages dans `web/src/features/purchases/errors.ts`.
- Enregistrements : `web/package.json` (`test:sql`) ; liste de migrations de `web/tests/sql/rbac.test.mjs` (incluant 0061).
- Tests réellement exécutés :
  - `supplier_evaluation` : 24 PASS, 0 FAIL. Couvre : sans politique, score non calculé et motif affiché ; ponctualité 1/2 (50 %) ; défauts 2/20 (10 %) ; écart prix +6,25 % ; réactivité ; documents ; pondérations invalides refusées ; droits ; score composite 81,75 conforme à la formule ; échantillon faible (2 réceptions, seuil 3) ; écart prix au-delà du seuil ; retard confirmé 1 distinct de la prévision ; fournisseur sans réception (motif « aucune réception ») ; évaluation enregistrée et ajout seul ; réapprovisionnement en brouillon, aucune commande créée, suggestion rattachée, seconde tentative refusée ; audit.
  - Régressions : `rbac` 63 ; `purchases` 100 ; `mrp` 62 ; `quality` 46 ; `three_way_match` 26 ; `purchase_orders_versions` 36 ; `finance` 46 — toutes à 0 FAIL.
  - `npm run test:unit` : 218 PASS, 0 FAIL (exécuté avant l'ajout des messages P036 ; à relancer si besoin).
  - `npx tsc --noEmit` (web) : sans erreur.
  - Suite SQL complète (`npm run test:sql`) : exit 0, 2940 PASS, 0 FAIL (log de la session, `SUITE_EXIT=0`).
- Corrections trouvées pendant les tests : concaténation de texte à un tableau (remplacée par `array_append`) ; alias de table en conflit avec une variable PL/pgSQL (renommé) ; motif de score absent pour un fournisseur sans réception (corrigé) ; contrôle qualité : contrainte de type exigeant un matériau.
- Limites :
  - Écart prix contre le catalogue actuel : pas d'historique de prix, donc l'écart n'est pas daté au prix du moment de la commande.
  - Pas de graphiques ni de tendances.
  - Le brouillon de réapprovisionnement n'a pas d'écran (action seulement) ; il dépend d'un passage MRP existant.
  - Les défauts ne sont rattachés au fournisseur que par une réception contrôlée (contrôle de type « réception »).
  - Un fournisseur sans réception sur la période ne reçoit aucun score : c'est voulu, pas une note nulle.
  - Écran non vérifié dans un navigateur connecté ; migration non appliquée à la base locale réelle (`erp360_real`).
- Décisions à valider par le propriétaire : pondérations et seuils de la politique ; prix de référence (catalogue actuel ou prix historique) ; cadence de réévaluation ; qui peut enregistrer une évaluation.
- Prochain lot : historique de prix pour l'écart prix ; réapprovisionnement avec écran ; vérification navigateur des écrans achats.

### P037 — entrepôts, emplacements, lots et unités (migration 0062)
- Objectif : tissus, accessoires, fournitures, EPI, produits finis et boutiques ; zones et emplacements ; lots identifiés ; rouleaux (longueur, largeur, bain, défauts) ; propriété (société ou client) distincte de la localisation ; unité et lot traçables ; scope entrepôt ; historique conservé.
- Identifiants matrice : STK-01 et STK-03 restent « Partiel » (`docs/MATRICE_ECARTS_CDC.md`) ; écarts mis à jour.
- Existant conservé et réutilisé : entrepôts, zones (`warehouse_locations`), emplacements, lots FIFO, mouvements (`stock_move`), droits par entrepôt (`private.wh_can`, `WAREHOUSE_FORBIDDEN`) (0009, 0017) ; clients (0004) ; numérotation (`next_seq`) ; produits finis (variantes, lots de produits finis 0055) inchangés.
- Ajouts SQL (0062), additifs :
  - `warehouses.kind` élargi au type `shop` (boutique) ; `bom_materials.family` (tissu, accessoire, fourniture, EPI, autre), reclassé par catégorie à la migration, modifiable par `material_family_set` (droit `stock.write`).
  - `material_lots` : code de lot unique par matière, référence fournisseur, bain, propriétaire optionnel (`material_lot_create`).
  - `material_units` : unité physique (code `UN-nnnnnn`), matière, lot, entrepôt, emplacement, quantité, longueur (tissu), largeur, bain, propriétaire, état (disponible, quarantaine, consommée). Une unité de propriété société est reçue en stock (`stock_move`) ; une unité de propriété client n'entre pas dans le stock société (`stock_posted = false`).
  - `material_unit_receive`, `material_unit_move` (localisation seulement, même entrepôt ; la propriété ne change jamais), `material_unit_defect_record` (défaut critique → quarantaine automatique), `material_unit_quarantine`, `material_unit_release` (droit `quality.write`), `material_unit_consume` (disponible seulement ; sortie de stock si propriété société).
  - Historiques en ajout seul : `material_unit_events` (réception, déplacement, défaut, quarantaine, libération, consommation, avec mouvement de stock lié) et `material_unit_defects` (triggers `UNIT_HISTORY_APPEND_ONLY`).
  - Lecture : `material_unit_trace` (historique complet, refusé hors périmètre : `UNIT_NOT_FOUND`) ; `material_lot_trace` (unités visibles, totaux visibles, nombre d'unités hors périmètre sans détail).
- Droits : `stock.write` (réception, déplacement, défaut, quarantaine, consommation), `quality.write` (libération), `stock.read` (lecture), et périmètre `wh_can` (opérateur pour écrire, visiteur pour lire) sur chaque entrepôt.
- Fichiers SQL : `supabase/migrations/0062_warehouse_lots_units.sql` ; `web/tests/sql/warehouse_lots_units.test.mjs`.
- Fichiers web : `web/src/features/stock/services/units.service.ts` ; `web/src/features/stock/units-actions.ts` (réception, défaut, consommation) ; `web/src/features/stock/components/unit-forms.tsx` ; page `web/src/app/(erp)/stock/units/page.tsx` (liste visible, traçabilité, formulaires).
- Enregistrements : `web/package.json` (`test:sql`) ; liste de migrations de `web/tests/sql/rbac.test.mjs` (incluant 0062) ; matrice STK-01 et STK-03.
- Tests réellement exécutés :
  - `warehouse_lots_units` : 35 PASS, 0 FAIL. Couvre : familles et types d'entrepôt ; droits ; codes de lot en double refusés ; réception d'un rouleau (longueur, largeur, bain, mouvement de stock) ; longueur obligatoire pour un tissu ; réception hors entrepôt affecté refusée (`WAREHOUSE_FORBIDDEN`) ; lot d'une autre matière et propriétaire incompatible refusés ; unité client sans mouvement de stock société ; déplacement dans l'entrepôt sans changement de propriété ; déplacement vers un autre entrepôt refusé ; défaut mineur sans quarantaine ; défaut critique → quarantaine ; consommation refusée en quarantaine ; libération refusée au magasinier et acceptée à la qualité ; consommation avec sortie de stock ; consommation d'une unité client sans sortie société ; pièce non mesurée (quantité 1) ; historique complet dans l'ordre ; lot tracé avec totaux ; unité de boutique masquée au magasinier ; trace hors périmètre refusée ; lecture directe limitée à l'entrepôt affecté ; historique et défauts non modifiables ; audit.
  - Régressions : `rbac` 63 ; `stock` 118 ; `stock_movements` 58 ; `warehouses` 62 ; `purchases` 100 ; `quality` 46 ; `three_way_match` 26 ; `supplier_evaluation` 24 — toutes à 0 FAIL.
  - `npx tsc --noEmit` (web) : sans erreur.
  - Suite SQL complète (`npm run test:sql`) au commit 7888ea3 (worktree dédié) : **2975 PASS, 0 FAIL**, sortie 0 (journal `SUITE_EXIT=0`).
- Limites :
  - Pas de déplacement d'une unité entre entrepôts, pas de changement de propriétaire, pas de découpe partielle d'un rouleau (consommation en totalité).
  - Pas de capacité d'emplacement, pas de picking par unité, pas de FEFO.
  - L'écran n'expose pas les boutons de déplacement, de quarantaine ni de libération (actions serveur seulement).
  - Le rouleau de propriété client suit sa localisation sans contrôle de valeur ni de facturation.
  - Écran non vérifié dans un navigateur connecté ; migration non appliquée à la base locale réelle (`erp360_real`).
- Décisions à valider par le propriétaire : classement des EPI et fournitures ; tolérance de longueur à la consommation ; une unité client peut-elle entrer dans le stock société ; libération d'une unité par la même personne qui l'a mise en quarantaine (aujourd'hui autorisé).
- Prochain lot : déplacement inter-entrepôts et changement de propriété avec approbation ; découpe partielle des rouleaux ; capacités d'emplacement ; vérification navigateur des écrans stock.

### P038 — journal des mouvements et réservations (migration 0063)
- Objectif : journal immuable des entrées, sorties, consommations et retours ; réservations atomiques ; solde rapprochable au journal ; stock négatif refusé ; lot qualité bloqué (quarantaine) ; scope entrepôt.
- Identifiants matrice : STK-02 et STK-04 non modifiés dans cette livraison (matrice non mise à jour, voir limites).
- Existant conservé et réutilisé : `stock_movements` immuable (trigger `STOCK_IMMUTABLE`, 0018), `stock_lots` FIFO, `stock_reservations` (0009/0018), `stock_move`, `stock_apply`, `stock_reserve`, `stock_release`, emplacements `quarantine` (0009), retour fournisseur (`purchase_return`, 0011, rejets 0060) ; `private.wh_can` ; `write_audit`.
- Ajouts SQL (0063), remplacements de fonctions à signature identique :
  - `private.stock_quality_blocked(material, wh)` : quantité en emplacements de type quarantaine.
  - `private.stock_quality_guard()` (trigger BEFORE INSERT sur `stock_movements`) : refuse une sortie depuis un emplacement de quarantaine (`STOCK_QUALITY_BLOCKED`) ; refuse une sortie ou un ajustement négatif qui entamerait le stock bloqué ; refuse un ajustement négatif qui entamerait le stock réservé (`STOCK_RESERVED`).
  - `private.stock_consume` : refuse une sortie explicite depuis la quarantaine ; exclut les lots en quarantaine sauf transfert/libération (destination renseignée) ou retour fournisseur (voir décisions).
  - `public.stock_reserve` : disponible = stock − réservé − bloqué ; refus `STOCK_INSUFFICIENT_AVAILABLE` ; verrou sur la matière ; réservation refusée sans ligne créée.
  - `public.stock_journal_list(warehouse, material, limit)` : lignes du journal avec classe (entrée, sortie, transfert, ajustement, inventaire, consommation, retour) ; filtrée par société, droit `stock.read` et `wh_can` visiteur.
  - `public.stock_journal_reconcile(material)` : par entrepôt, solde du journal, solde des lots, réservé, bloqué et écart.
- Décision technique : la quarantaine ne sort que par un retour fournisseur (`RET-`, `purchases.rpc = on` posé par `purchase_return`) ou par un transfert explicite ; l'exception achats reprend le marqueur existant `purchases.rpc`, déjà posé par les RPC d'achat (pas de nouveau mécanisme).
- Fichiers SQL : `supabase/migrations/0063_stock_journal_reservations.sql` ; `web/tests/sql/stock_journal_reservations.test.mjs`.
- Enregistrements : `web/package.json` (`test:sql`, nouveau test) ; liste de migrations de `web/tests/sql/rbac.test.mjs` (incluant 0063).
- Correction de régression trouvée pendant la livraison : le contrôle de quarantaine bloquait le retour fournisseur d'un lot rejeté (`three_way_match` : `STOCK_QUALITY_BLOCKED`). Corrigé par l'exception bornée décrite ci-dessus (trigger et `stock_consume`) ; `three_way_match` repasse à 26 PASS, 0 FAIL.
- Tests réellement exécutés (résultats de cette session) :
  - `stock_journal_reservations` : 25 PASS, 0 FAIL. Couvre : entrée classée ; journal immuable (modification et suppression refusées) ; sortie et ajustement au-delà du stock refusés ; aucun stock négatif après refus ; quarantaine bloquée (sortie, réservation) et libérée par transfert explicite ; deux réservations du dernier stock (12 + 8 = 20) sans dépassement ; troisième réservation refusée sans ligne créée ; libération puis nouvelle réservation ; ajustement négatif refusé sur stock réservé ; consommation liée à une réservation (soldée, classée « consommation ») ; retour classé « retour » ; réconciliation : journal = lots = 11, réservé 8, bloqué 0, écart 0 ; scope magasinier ; journal sans droit vide ; audit (une trace `stock.reserve` par réservation acceptée, aucune pour la refusée).
  - Régressions : `three_way_match` 26 ; `purchases` 100 ; `quality` 46 ; `stock` 118 ; `stock_movements` 58 ; `rbac` 63 ; `warehouses` 62 ; `warehouse_lots_units` 35 — toutes à 0 FAIL.
  - Suite SQL complète (`npm run test:sql`, après corrections) : **3000 PASS, 0 FAIL**, sortie 0 (journal `SUITE_EXIT=0`).
- Limites :
  - Pas d'écran : aucun écran de journal ni de réservation n'est livré dans ce lot (API/SQL seulement). Les écrans restent à faire.
  - Pas de politique de stock négatif paramétrable : le stock négatif est refusé dans tous les cas, faute de politique écrite.
  - Le journal est `stock_movements` lui-même (pas de table séparée) ; le rapprochement est une fonction, pas un contrôle planifié.
  - Matrice d'écarts non mise à jour ; pas de vérification navigateur (Docker indisponible) ; migration non appliquée à la base locale réelle `erp360_real`.
  - Un ajustement négatif de stock libre reste à la charge de `stock.adjust` ; aucune séparation supplémentaire des tâches sur les ajustements.
- Décisions à valider par le propriétaire : sortie de quarantaine par retour fournisseur seulement (aujourd'hui `RET-` + `purchases.rpc`) ; politique de stock négatif (aujourd'hui toujours refusé) ; classement des mouvements « retour » (préfixe `RET-`).
- Prochain lot : écrans journal et réservations (liste filtrée par entrepôt, réconciliation visible) ; politique de stock négatif si décidée ; mise à jour de la matrice STK-02/STK-04 ; vérification navigateur des écrans stock.

### P039 — FIFO, FEFO et préparation (migration 0064)
- Objectif : proposition de lots FIFO ou FEFO (si échéance pertinente) ; picking par lot et emplacement ; confirmation par scan ; règle de sortie distincte de la méthode de valorisation ; substitution de lot soumise à accord ; lot échu ou bloqué refusé ; scan erroné détecté ; bon lot sorti.
- Identifiants matrice : non mis à jour dans cette livraison (voir limites).
- Existant conservé : lots FIFO (`stock_lots`, `stock_apply`, 0009/0011), coût du lot (`stock_lot_costs`, valorisation inchangée), réservations (0009/0018), quarantaine et journal (0063), `stock_move`. Le picking expédition des produits finis (0021) n'est pas touché ; il ne porte pas sur les lots matière.
- Ajouts SQL (0064), additifs :
  - `stock_lots` : `lot_code` et `expiry_date` (nullables) ; index FEFO.
  - `stock_exit_policies` : règle de sortie par société (`fifo` par défaut, `fefo`) ; valorisation `lot_cost` seule, figée. Séparation explicite : la règle choisit le lot, la valorisation ne change pas.
  - `stock_receive_lot` : entrée avec code et échéance ; refuse une échéance passée (`LOT_EXPIRED_AT_RECEIPT`) et un même code avec une autre échéance (`LOT_EXPIRY_MISMATCH`).
  - `private.stock_pick_plan` / `stock_pick_available` : quantité libre par lot = stock − prélèvements ouverts ; exclut quarantaine et lots échus ; moins les réservations.
  - `stock_pick_proposal` (lecture) : lots proposés, disponible, manque, lots exclus avec motif (EXPIRED / BLOCKED).
  - `stock_pick_lists` et `stock_pick_lines` : liste par composant et entrepôt, numéro PRL-AAAA-NNNNNN, lignes par lot et emplacement, scan, substitution, mouvement lié.
  - `stock_pick_create`, `stock_pick_scan` (retourne ok=false et enregistre l'erreur sans annuler la transaction), `stock_pick_request_substitution`, `stock_pick_decide_substitution` (demandeur ≠ approbateur, `SOD_SELF_APPROVAL`), `stock_pick_confirm` (atomique), `stock_pick_cancel`.
  - `private.stock_take_lot` : sortie d'un lot précis avec mouvement, allocation et coût ; revalide échéance, quarantaine, quantité et réservations au moment de la confirmation.
- Correction de la confirmation : aucune sortie n'a lieu si un lot est échu ou bloqué entre la préparation et la confirmation.
- Fichiers SQL : `supabase/migrations/0064_fifo_fefo_picking.sql` ; `web/tests/sql/stock_fifo_fefo_picking.test.mjs`.
- Fichiers web : `web/src/features/stock/picking-actions.ts` ; `web/src/features/stock/components/picking-forms.tsx` ; page `web/src/app/(erp)/stock/picking/page.tsx` ; lien « Préparation » dans `web/src/features/stock/components/stock-nav.tsx`.
- Enregistrements : `web/package.json` (`test:sql`, nouveau test) ; liste de migrations de `web/tests/sql/rbac.test.mjs` (incluant 0064).
- Tests réellement exécutés :
  - `stock_fifo_fefo_picking` : 43 PASS, 0 FAIL. Couvre : réception avec échéance et code ; échéance passée et code à autre échéance refusés ; FIFO (L-OLD 50 puis L-FEFO 10) ; lots échus et en quarantaine exclus avec motif ; manque signalé et PICK_SHORT ; FEFO (L-FEFO 40 puis L-OLD 20) ; règle inconnue et changement sans droit refusés ; liste créée ; confirmation refusée sans scan (PICK_NOT_SCANNED) ; scan erroné refusé sans annuler la transaction et enregistré (compteur, audit) ; scan juste accepté ; substitution vers lot échu (LOT_EXPIRED), vers quarantaine (LOT_BLOCKED) et motif court refusés ; substitution en attente bloque scan et confirmation ; auto-approbation refusée (SOD_SELF_APPROVAL) ; décision sans droit refusée ; approbation par un autre utilisateur ; ancien lot scanné après substitution détecté comme erreur ; confirmation : L-FEFO 40 consommé, L-ALT 100 − 5 = 95, L-OLD intact à 50 ; mouvements classés « sortie », coût tracé ; seconde confirmation refusée ; lot échu entre préparation et confirmation refusé (LOT_EXPIRED), quantité inchangée ; annulation ; scope entrepôt (WAREHOUSE_FORBIDDEN) ; droit de lecture ; journal réconcilié (écart nul) ; audit (création, scan erroné ×2, demande, décision, confirmation, annulation).
  - Corrections trouvées pendant les tests : trois appels d'audit avaient un argument de trop (corrigés) ; la décision de substitution avait un argument en trop ; le test de motif utilisait le lot déjà prévu (corrigé) ; l'attente d'erreur d'audit était de 1, elle est de 2 (deux scans erronés, les deux tracés).
  - Régressions : `rbac` 63 ; `stock` 118 ; `stock_movements` 58 ; `warehouses` 62 ; `purchases` 100 ; `quality` 46 ; `three_way_match` 26 ; `warehouse_lots_units` 35 ; `stock_journal_reservations` 25 — toutes à 0 FAIL.
  - Suite SQL complète (`npm run test:sql`) : **3043 PASS, 0 FAIL**, sortie 0 (journal `SUITE_EXIT=0`).
  - `npx tsc --noEmit` (web) : sans erreur.
  - `npm run test:unit` (web) : sans erreur.
- Limites :
  - La règle FIFO/FEFO ne s'applique qu'à la proposition et à la préparation. Les sorties ordinaires (`stock_move` out, consommations de fabrication, expéditions) gardent leur ordre existant (FIFO par date de réception) et ne vérifient pas l'échéance : un lot échu peut encore sortir par ce chemin. À trancher.
  - Le scan porte sur le code du lot seulement, pas sur le scan d'emplacement.
  - Les échéances sont simulées dans les tests par mise à jour directe de `expiry_date` (pas de vrai passage du temps).
  - Une substitution est refusée si son lot n'est pas libre au moment de la demande ; la capacité est revérifiée à l'approbation et à la confirmation.
  - La réservation par lot n'existe pas au-delà des listes ouvertes : une réservation de commande reste au niveau matière et entrepôt.
  - Écrans non vérifiés dans un navigateur (Docker indisponible) ; migration non appliquée à la base locale `erp360_real` ; matrice d'écarts non mise à jour.
- Décisions à valider par le propriétaire : la règle de sortie est une règle par société (pas par famille de matière) ; la méthode de valorisation reste `lot_cost` ; les sorties ordinaires doivent-elles aussi respecter l'échéance (aujourd'hui non) ; substitution approuvée par tout utilisateur ayant `stock.adjust` sur l'entrepôt, distinct du demandeur.
- Prochain lot : appliquer l'échéance et la règle de sortie aux sorties ordinaires ; scan d'emplacement ; vérification navigateur des écrans stock ; mise à jour de la matrice STK-02 et STK-04.
