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

### P040 — transferts et stock en transit (migration 0065)
- Objectif : transfert entre entrepôts d'une même société ; cycle brouillon → préparé → expédié (en transit) → partiellement reçu → reçu ; réception partielle avec preuve ; écart de transit soumis à accord ; quantités en transit exactes ; aucune double réception ; propriété respectée.
- Identifiants matrice : STK-05 reste « Partiel » (intersociétés non traitées, voir limites) ; matrice non mise à jour dans cette livraison.
- Existant conservé : mouvement `transfer` cross-entrepôt (0009/0018), garde d'entrepôt (0017), unités de propriété client (0062, `stock_posted = false`), journal immuable (0063), réservations, `stock_move`.
- Ajouts SQL (0065), additifs :
  - Entrepôt `transit` par société (kind ajouté à la contrainte, emplacement `TRANSIT`), créé à la demande par `private.transit_location`. Le stock en route y est physiquement présent.
  - `stock_transfers` (numéro TRF-AAAA-NNNNNN, statut, entrepôts et emplacements), `stock_transfer_lines` (demandé, préparé, expédié, reçu, écart ; contrainte SQL `reçu + écart ≤ expédié`), `stock_transfer_events` et `stock_transfer_receipts` (ajout seul, triggers `STOCK_IMMUTABLE`), `stock_transfer_losses` (contrainte SQL : décideur ≠ demandeur).
  - Fonctions : `stock_transfer_create`, `stock_transfer_prepare`, `stock_transfer_ship`, `stock_transfer_receive` (clé d'idempotence, preuve obligatoire, verrou sur le transfert), `stock_transfer_declare_loss`, `stock_transfer_decide_loss` (sortie du transit seulement après accord), `stock_transfer_cancel`, `stock_transfer_detail` (quantités exactes par ligne, réceptions, écarts, historique), `stock_transit_reconcile` (stock du transit = quantités en transit).
  - Statut recalculé à partir des quantités (`private.transfer_refresh`) : une seule source de vérité.
  - Gardes d'écriture (0017) redéfinies à l'identique avec un passage unique : écriture sur un entrepôt de kind `transit` quand une RPC de transfert a posé `stock.transfer_rpc = on` dans la transaction. Aucun autre entrepôt n'est concerné.
- Fichiers SQL : `supabase/migrations/0065_stock_transfers_transit.sql` ; `web/tests/sql/stock_transfers_transit.test.mjs`.
- Fichiers web : `web/src/features/stock/transfers-actions.ts` ; `web/src/features/stock/components/transfer-forms.tsx` ; page `web/src/app/(erp)/stock/transfers/page.tsx` ; lien « Transferts » dans `stock-nav.tsx`.
- Enregistrements : `web/package.json` (`test:sql`, nouveau test) ; liste de migrations de `web/tests/sql/rbac.test.mjs` (incluant 0065).
- Tests réellement exécutés :
  - `stock_transfers_transit` : 48 PASS, 0 FAIL. Couvre : création en brouillon ; refus (même entrepôt, source en quarantaine, entrepôt d'une autre société, hors périmètre, transit, vide, quantité nulle) ; préparation limitée à la demande et au périmètre ; expédition (source 100 → 40, transit 60, quantité en transit exacte) et refus d'une seconde expédition ; rapprochement transit = 60, écart 0 ; réception partielle de 25 avec preuve, transit 35 ; clé de réception trop courte et preuve absente refusées ; **rejeu de la même clé refusé (TRANSFER_DUPLICATE_RECEIPT), aucun mouvement en double** ; sur-réception refusée (TRANSFER_OVER_RECEIPT) ; réception du solde → statut « reçu », transit 0 ; réception après clôture refusée ; deux preuves tracées ; écart déclaré sans sortie avant accord, réception du reliquat refusée pendant l'écart en attente ; auto-approbation refusée (SOD_SELF_APPROVAL) ; décision sans droit refusée ; écart approuvé : sortie de 5, ligne 20 = 15 + 5, transit 0 ; écart refusé : marchandise toujours en transit, décision répétée refusée ; **propriété : unité de propriété client hors stock société, expédition au-delà du stock société refusée (STOCK_INSUFFICIENT), transfert resté « préparé », source et transit inchangés** ; annulation avant expédition, refus après ; détail hors périmètre refusé ; rapprochement final transit 10 = quantités en transit 10 ; audit (création, expéditions 3, réceptions 3, écarts déclarés 2, décidés 2, annulation 1).
  - Régressions après redéfinition des gardes d'entrepôt : `rbac` 63 ; `warehouses` 62 ; `stock` 118 ; `stock_movements` 58 ; `purchases` 100 ; `quality` 46 ; `three_way_match` 26 ; `warehouse_lots_units` 35 ; `stock_journal_reservations` 25 ; `stock_fifo_fefo_picking` 43 — toutes à 0 FAIL.
  - Suite SQL complète (`npm run test:sql`) : **3091 PASS, 0 FAIL**, sortie 0 (journal `SUITE_EXIT=0`).
  - `npx tsc --noEmit` (web) : sans erreur.
  - `npm run test:unit` (web) : sans erreur.
- Corrections trouvées pendant les tests : le trigger de garde d'entrepôt (0017) bloquait tout transfert vers l'entrepôt transit pour un magasinier, et la création du transit échouait sans droit `warehouses.manage` ; corrigé par le passage limité décrit ci-dessus. Un `await` dans une fonction fléchée du test a été corrigé. Le fixture de la propriété client a dû respecter la règle existante (lot et unité de même propriétaire, matière de famille tissu).
- Limites :
  - **Intersociétés non implémentées.** Les documents juridiques et financiers réciproques relèvent de OPEN-04 (V2) et ne sont pas tranchés par le propriétaire : aucun document n'est généré, aucune écriture comptable n'est créée. Un entrepôt d'une autre société est refusé comme introuvable (pas de fuite d'information inter-sociétés).
  - Propriété : seul le stock société voyage. Les lots de stock n'ont pas de propriétaire ; les unités de propriété client ne sont pas transférables par ce flux (elles ne sont pas dans le stock société).
  - Identité des lots en transit : les quantités sont exactes par transfert et par ligne, et le total du transit est rapproché ; l'identité de lot n'est pas conservée à travers le transit (la réception sort en FIFO du transit pour une même matière).
  - Preuve : référence textuelle du bon de transport, sans pièce jointe.
  - Écran : une seule matière par transfert dans l'interface (la fonction en accepte plusieurs) ; non vérifié dans un navigateur (Docker indisponible).
  - Le passage transit de la garde d'entrepôt est un réglage local à la transaction, posé uniquement par `private.transit_location`.
  - Migration non appliquée à la base locale `erp360_real` ; matrice d'écarts non mise à jour.
- Décisions à valider par le propriétaire : documents intersociétés (OPEN-04) avant toute implémentation ; approbation d'un écart par tout utilisateur ayant `stock.adjust` et l'entrepôt destination en opérateur, distinct du déclarant ; référence de bon de transport textuelle suffisante, ou pièce jointe GED à prévoir ; accès des magasiniers au transit (aujourd'hui aucun, sauf administrateurs).
- Prochain lot : décision OPEN-04 puis flux intersociétés ; pièce jointe de preuve ; transferts multi-matières dans l'écran ; vérification navigateur des écrans stock ; mise à jour de la matrice STK-05.

### P041 — inventaires, ajustements et valorisation (migration 0066)
- Objectif : comptage aveugle ; recomptage ; gel ciblé ou traitement des mouvements simultanés ; accord d'ajustement distinct du compteur ; écarts expliqués ; valorisation selon une méthode validée par la finance ; journal historique non réécrit ; quantité et valeur rapprochées.
- Identifiants matrice : STK-04 reste « Partiel » (comptage aveugle, approbation des écarts et valorisation traités ; seuil d'approbation BR-STK-006 et méthode de valorisation non tranchés) ; matrice non mise à jour dans cette livraison.
- Existant conservé : inventaire et ses lignes (0009), création, ajout de ligne, annulation, mouvements `inventory` (0009/0018), `stock_apply`, coût du lot (`stock_lot_costs`).
- Ajouts SQL (0066), additifs :
  - `stock_inventories` : `targeted_freeze`, `phase` (comptage, recomptage, réconciliation, en attente d'accord, validé, annulé), demande et décision d'accord, motif. Les inventaires existants reçoivent leur phase.
  - `stock_inventory_lines` : `recount_needed`, `snapshot_at`. Lecture directe limitée aux colonnes d'identification ; écriture directe du comptage retirée.
  - `stock_inventory_count_entries` : saisies par passage (1 ou 2), ajout seul (`STOCK_IMMUTABLE`), sans lecture directe.
  - `stock_valuation_settings` : méthode (seule `lot_cost` est acceptée) et confirmation par la finance.
  - Trigger `stock_movements_count_freeze` : mouvements refusés sur les lignes gelées (matière et emplacement) pendant le comptage, sauf mouvements `inventory`.
  - Fonctions : `stock_inventory_freeze_set`, `stock_inventory_lines_for_count` (sans quantité), `stock_inventory_count_submit`, `stock_inventory_close_count` (écart non expliqué → recomptage), `stock_inventory_close_recount`, `stock_inventory_request_approval`, `stock_inventory_decide` (accord distinct, motif obligatoire, ajustement au stock réel à la décision), `stock_valuation_set`, `stock_inventory_reconcile` (quantité et valeur par ligne et par matière).
  - `stock_inventory_validate` (validation directe de 0009) : désactivée, elle lève `INVENTORY_APPROVAL_REQUIRED`. `stock_inventory_cancel` met aussi la phase à jour.
- Théorique attendu = théorique au relevé + mouvements entre le relevé et le comptage final ; mouvements postérieurs au comptage exposés à part et pris en compte à l'ajustement.
- Fichiers SQL : `supabase/migrations/0066_inventory_blind_count_approval.sql` ; `web/tests/sql/inventory_blind_approval.test.mjs` ; `web/tests/sql/stock.test.mjs` (inventaire adapté au nouveau flux, migration 0066 ajoutée à sa liste).
- Fichiers web : `web/src/features/stock/types.ts` ; `web/src/features/stock/services/stock.service.ts` (lecture aveugle ou réconciliation selon `stock.adjust`) ; `web/src/features/stock/actions.ts` (saisie par RPC, clôture par phase, demande et décision d'accord ; validation directe retirée) ; `web/src/features/stock/components/inventory-components.tsx` ; page `web/src/app/(erp)/stock/inventories/[id]/page.tsx`.
- Enregistrements : `web/package.json` (`test:sql`, nouveau test) ; liste de migrations de `web/tests/sql/rbac.test.mjs` (incluant 0066).
- Tests réellement exécutés :
  - `inventory_blind_approval` : 35 PASS, 0 FAIL. Couvre : liste du compteur sans quantité ; théorique non lisible par le compteur ; saisie directe refusée ; gel ciblé (mouvement sur GEN refusé, sur RAY accepté) ; deuxième saisie refusée ; validation directe refusée ; écart non expliqué sur le fil → recomptage ; recomptage par le même compteur refusé (COUNT_SAME_COUNTER) ; recomptage sans écart refusé ; décision par un compteur refusée (SOD_COUNTER_APPROVAL) ; décision sans droit refusée ; motif obligatoire ; accord par la direction ; mouvements `inventory` tracés ; mouvement simultané avant comptage expliqué (−10), aucun recomptage ; mouvement postérieur au comptage (+5) pris en compte à la décision (95 → 90) ; auto-approbation refusée (SOD_SELF_APPROVAL) ; refus motivé puis nouvel accord ; méthode non prévue refusée ; valeur « à confirmer » puis « confirmée » après décision finance ; quantité rapprochée (−2 = −2) ; valeur de l'ajustement (−8 et −50) ; journal et lots rapprochés par matière (écarts de quantité et de valeur nuls) ; mouvement d'inventaire non modifiable (permission refusée, puis `STOCK_IMMUTABLE`) ; réconciliation refusée hors droit ; audit.
  - `stock` : 126 PASS, 0 FAIL (118 auparavant ; 8 assertions ajoutées avec le nouveau flux d'inventaire).
  - Régressions : `rbac` 63 ; `stock_movements` 58 ; `warehouses` 62 ; `purchases` 100 ; `quality` 46 ; `three_way_match` 26 ; `warehouse_lots_units` 35 ; `stock_journal_reservations` 25 ; `stock_fifo_fefo_picking` 43 ; `stock_transfers_transit` 48 — toutes à 0 FAIL.
  - Suite SQL complète (`npm run test:sql`) : **3134 PASS, 0 FAIL**, sortie 0 (journal `SUITE_EXIT=0`).
  - `npx tsc --noEmit` (web) : sans erreur. `npm run test:unit` (web) : sans erreur.
- Corrections trouvées pendant les tests : le nom de colonne `freeze` est réservé par PostgreSQL (renommé `targeted_freeze`) ; deux variables PL/pgSQL masquaient des alias de table (renommées) ; le recomptage attendu était d'une ligne, il est de deux : le surplus de fil (0 → 12) est un écart non expliqué, donc il doit être recompté — l'assertion du test a été corrigée.
- Limites :
  - **Méthode de valorisation non tranchée.** Le dépôt ne contient aucune méthode validée par la finance (BR-COU-001 cite un prix moyen pondéré pour le coût de revient, non implémenté pour le stock). Seule la méthode en vigueur (coût du lot) est acceptée, et la valeur reste « à confirmer » tant que la finance ne la confirme pas. Aucune méthode n'a été inventée.
  - **Seuil d'approbation non paramétré** (BR-STK-006 : seuil Responsable/Direction « à confirmer ») : tout ajustement exige un accord distinct, sans seuil.
  - Pas de tolérance de comptage : tout écart non expliqué, même minime, déclenche un recomptage.
  - Le gel ne couvre que les lignes de l'inventaire (matière et emplacement) ; les mouvements sans gel sont acceptés et expliqués, mais leur date est comparée à l'instant du relevé de la ligne (`snapshot_at` = ajout de la ligne).
  - Les ajustements `inventory` négatifs ne contrôlent pas la réservation (même comportement qu'en 0009) : un ajustement peut consommer du stock réservé. Ce point est à traiter.
  - **Validation directe désactivée** (`stock_inventory_validate` lève une erreur) : c'est un retrait de capacité qui exige une décision écrite du propriétaire (voir décisions).
  - Le test `stock` a été adapté à la nouvelle règle (comptage par RPC, validation par accord) : c'est un changement de règle, à valider.
  - Écrans non vérifiés dans un navigateur (Docker indisponible) ; migration non appliquée à `erp360_real` ; matrice d'écarts non mise à jour.
- Décisions à valider par le propriétaire : retrait écrit de la validation directe 0009 au profit de l'accord distinct ; méthode de valorisation des inventaires (aujourd'hui coût du lot, à confirmer) ; seuil d'accord de BR-STK-006 ; tolérance de comptage (aujourd'hui zéro) ; contrôle de la réservation sur les ajustements négatifs.
- Prochain lot : seuil d'accord et tolérance une fois fournis ; contrôle des réservations sur les sorties d'inventaire ; vérification navigateur des écrans inventaire ; mise à jour de la matrice STK-04.

### P042 — codes-barres et tâches mobiles (migration 0067)
- Objectif : codes retenus, génération et lecture ; anti-scan répété ; tâches réception, picking et inventaire ; API mobile ; erreurs exploitables avec retour visuel et sonore ; droits serveur. RFID : étude seulement.
- Identifiants matrice : STK-06 reste « Partiel » (codes-barres et tâches mobiles couverts ; RFID hors périmètre) ; Warehouse Mobile (Partie 11) reste « Partiel » (réception et comptage mobiles sans écran dédié) ; matrice non mise à jour.
- Codes retenus (existants, réutilisés, sans nouveau format) : SKU et GTIN des variantes (0015 ; génération GTIN par `variant_assign_barcodes`), code matière (0008, généré), code emplacement (0009), code de lot (0064), unité `UN-` (0062), numéros PRL- (0064), TRF- (0065), INV- (0009).
- Existant conservé : module terrain (`classifyCode`, `resolveCodeAction`, tuiles, scan OF/contrôle/BL), `stock_pick_scan` (0064), `stock_transfer_receive` (0065), `stock_inventory_count_submit` (0066).
- Ajouts SQL (0067), additifs :
  - `scan_resolve(code)` : un seul résultat ou `SCAN_UNKNOWN` / `SCAN_AMBIGUOUS`, limité aux entrepôts visibles (`stock.read`).
  - `scan_events` : journal des scans (clé unique par utilisateur, ajout seul, `STOCK_IMMUTABLE`).
  - `mob_pick_scan(line, lot, emplacement, clé)` : lot ET emplacement vérifiés ; `mob_transfer_receive_scan(transfert, article, emplacement, qté, preuve, clé)` : article et emplacement de destination, clé utilisée comme clé d'idempotence de réception ; `mob_count_scan(line, article, emplacement, qté, clé)`.
  - Chaque réponse porte `ok`, `code`, `message`, `sound` (ok/error), `duplicate`, `replayed`, et `expected` pour les mauvais emplacements et lots.
- Fichiers SQL : `supabase/migrations/0067_barcode_mobile_tasks.sql` ; `web/tests/sql/mobile_barcode_tasks.test.mjs`.
- Fichiers web : `web/src/lib/field/scan-feedback.ts` (retour visuel et sonore, partie pure et signal matériel) ; `web/tests/unit/scan-feedback.test.mjs` ; `web/src/features/stock/picking-actions.ts` (`mobilePickScanAction`) ; `web/src/features/stock/components/picking-forms.tsx` (lot et emplacement, clé par tentative) ; `web/src/features/stock/scan-actions.ts` et `components/code-lookup.tsx` (recherche de code) ; page `web/src/app/(field)/atelier/scan/page.tsx` ; API `web/src/app/api/mobile/tasks/route.ts` (`resolve`, `pick`, `receive`, `count`).
- Enregistrements : `web/package.json` (`test:sql` et `test:unit`) ; liste de migrations de `web/tests/sql/rbac.test.mjs` (incluant 0067).
- Tests réellement exécutés :
  - `mobile_barcode_tasks` : 35 PASS, 0 FAIL. Couvre : résolution d'un code matière (saisie en minuscules acceptée), d'un lot, d'un emplacement unique au périmètre du magasinier ; emplacement ambigu pour un utilisateur ayant deux entrepôts (`SCAN_AMBIGUOUS`) ; code inconnu et scan vide (`SCAN_UNKNOWN`) ; résolution sans droit refusée ; picking : mauvais lot refusé (attendu indiqué), mauvais emplacement refusé, refus sans effet, bon lot et bon emplacement confirmés, rejeu de la même clé sans effet, scan répété avec nouvelle clé ignoré, clé trop courte refusée, picking sans droit refusé, clé réutilisée pour une autre tâche refusée (`SCAN_KEY_REUSED`), sortie confirmée une seule fois ; réception : hors entrepôt destination refusé (`WAREHOUSE_FORBIDDEN`), mauvais article refusé, mauvais emplacement refusé, refus sans effet, réception scannée (10 en destination), rejeu de la même clé sans seconde réception, scan après clôture refusé (`TRANSFER_BAD_STATUS`) ; comptage : mauvais article et mauvais emplacement refusés, comptage juste enregistré sans quantité théorique dans la réponse, rejeu sans second comptage, second comptage du passage refusé ; journal : refus tracés avec leur code, journal non modifiable (`STOCK_IMMUTABLE`), comptage hors entrepôt affecté refusé (`WAREHOUSE_FORBIDDEN`).
  - `scan-feedback` : 4 PASS, 0 FAIL (refus, doublon, rejeu, scan accepté).
  - `npm run test:unit` : sans erreur. `npx tsc --noEmit` (web) : sans erreur.
  - Suite SQL complète (`npm run test:sql`) : **3169 PASS, 0 FAIL**, sortie 0 (journal `SUITE_EXIT=0`).
- Corrections trouvées pendant les tests : les quantités `numeric` reviennent en chaîne (comparaisons corrigées dans le test) ; un rejeu de réception sur une ligne déjà close renvoie `TRANSFER_BAD_STATUS` (test précisé) ; la clé de scan est refusée si elle sert à une autre tâche.
- Étude RFID (pas de réalisation) : aucun étiquetage RFID, aucun lecteur, aucune donnée. Le modèle actuel (codes de lot, unités, numéros de document) n'empêche pas une future lecture RFID qui résoudrait un identifiant EPC vers les mêmes entités. Un pilote demanderait : un périmètre d'entrepôt limité, des étiquettes de test, la décision du propriétaire sur le format EPC et sur les coûts matériels. Aucun pilote n'est lancé.
- Limites :
  - Pas d'écran dédié pour la réception et le comptage mobiles : elles passent par l'API `/api/mobile/tasks`, qui n'a pas d'interface terrain.
  - API mobile : authentification par session Supabase (cookies) uniquement ; le jeton « bearer » pour applications natives n'est pas implémenté.
  - Le scan du picking exige désormais l'emplacement : décision à valider (le comportement précédent ne vérifiait que le lot).
  - `scan_resolve` : les matières et les variantes sont visibles de tout utilisateur ayant `stock.read` (pas de périmètre entrepôt pour elles).
  - Retour sonore et vibré non vérifié sur un appareil réel ; écrans non vérifiés dans un navigateur (Docker indisponible).
  - Les refus de scan n'incrémentent plus `scan_errors` du picking (le compteur est désormais dans `scan_events`).
  - Migration non appliquée à `erp360_real` ; matrice d'écarts non mise à jour.
- Décisions à valider par le propriétaire : emplacement obligatoire au scan de picking ; format de code retenu (pas de nouveau code ; GTIN et codes existants) ; périmètre du pilote RFID (aujourd'hui aucun) ; authentification mobile par jeton pour applications natives.
- Prochain lot : écran mobile réception et comptage ; authentification par jeton ; pilote RFID si décidé ; vérification sur appareil réel des retours sonore et vibré ; mise à jour de la matrice STK-06.

### P043 — collections, modèles et dossiers techniques (migration 0068)
- Objectif : collections ; styles, variantes, patrons, mesures, tolérances, visuels, conditionnement, bibliothèques ; cycle brouillon → prototype → revue → approuvé → obsolète avec versions et preuves ; approbation distincte ; cohérence SKU ; ne pas renommer une référence sans mapping.
- Existant conservé et réutilisé : fiche produit `product_master` (PRD-), versions `product_versions` (spec JSON : tech, couleurs, tailles, variantes, mesures avec tolérance, entretien, conditionnement), visuels `product_photos`, documents `product_documents`, certifications, instantané à la validation, comparaison, duplication, archivage (0013) ; variantes et SKU (0015, 0039 : SKU immuable, historique `sku_history`) ; bibliothèques tissus et accessoires = composants existants `bom_materials` (familles, 0008 et 0062), sans nouvelle bibliothèque.
- Identifiants matrice : non mis à jour (matrice non modifiée dans cette livraison).
- Ajouts SQL (0068), additifs :
  - Statuts de version : `prototype` et `review` ajoutés (brouillon, prototype, revue, approuvé = `validated`, obsolète). Contenu verrouillé hors brouillon (trigger 0013 inchangé). Colonnes de revue : demandeur, date, note, retour de rejet, date de décision.
  - `product_version_prototype`, `product_version_submit_review`, `product_version_reject` (motif obligatoire, retour en brouillon).
  - `product_validate_version` (redéfini) : n'approuve que depuis la revue ; approbateur distinct du rédacteur et du demandeur (`SOD_SELF_APPROVAL`) ; preuves : au moins une mesure, chaque mesure avec tolérance, au moins un visuel ou un document ; cohérence SKU exigée.
  - `product_new_version` (redéfini) : bloquée tant qu'une version est en brouillon, prototype ou revue.
  - Collections : `product_collections` (COL-, saison, année, statut brouillon / active / archivée), `product_master.collection_id`, fonctions `product_collection_create`, `product_collection_set_status`, `product_collection_assign` (même client, collection active seulement).
  - Cohérence SKU : `private.sku_issues`, `product_sku_check` (SKU catalogue ≠ spécification = bloquant ; variante non générée = information). Renommage : `product_sku_map_apply` seulement vers le SKU de la spécification, avec motif, et trace permanente dans `product_sku_mappings` (ajout seul).
  - Gardes existants redéfinis à l'identique, avec une seule exception : `private.variant_sku_guard` (0039) accepte le changement de SKU seulement sous le réglage `variants.sku_map` posé par le mapping, et inscrit le nouveau SKU à `sku_history` ; `private.variants_before` (0015) : même corps, mêmes règles, la condition de changement de SKU est soumise au même réglage.
  - Journal : `private.audit_product_versions` (0013) : l'approbation se trace désormais depuis la revue (même action `product.version_validate`).
- Fichiers SQL : `supabase/migrations/0068_collections_dossiers_approval.sql` ; `web/tests/sql/collections_dossiers_approval.test.mjs` ; `web/tests/sql/pdm.test.mjs` (parcours adapté aux nouvelles règles, liste de migrations étendue à 0015, 0039 et 0068).
- Fichiers web : `web/src/features/products/actions.ts` (`versionStepAction` : prototype, demande de revue, rejet) ; `web/src/features/products/components/versions-panel.tsx` (boutons selon le statut ; approbation depuis la revue seulement ; dialogue de rejet avec motif) ; `web/src/features/products/types.ts` ; `web/src/lib/products/options.ts` (libellés des statuts de dossier, sans toucher aux modules articles et nomenclatures).
- Enregistrements : `web/package.json` (`test:sql`, nouveau test) ; liste de migrations de `web/tests/sql/rbac.test.mjs` (incluant 0068).
- Tests réellement exécutés :
  - `collections_dossiers_approval` : 34 PASS, 0 FAIL. Couvre : collection créée (COL-, brouillon) ; nom trop court, année hors bornes, doublon de nom refusés ; rattachement refusé pour une collection non active et pour une collection d'un autre client ; rattachement à la collection active du même client ; prototype, contenu figé en prototype (`PRODUCT_VERSION_LOCKED`), second prototype refusé ; demande de revue ; validation sans droit refusée ; approbation sans preuve visuelle refusée ; rejet sans motif refusé, rejet motivé avec retour en brouillon, brouillon de nouveau modifiable ; auto-approbation refusée (`SOD_SELF_APPROVAL`) ; cohérence SKU : catalogue JAC-MAR-M ≠ spécification JAC-MAR-M2 bloquant, approbation refusée (`PRODUCT_SKU_INCOHERENT`) ; modification directe du SKU refusée (`VARIANT_REF_LOCKED`) ; renommage sans motif, vers un SKU hors spécification (`SKU_NOT_IN_SPEC`) refusés ; renommage avec mapping (catalogue JAC-MAR-M2, mapping conservé) ; approbation distincte réussie, produit actif ; nouvelle version refusée tant qu'une revue est ouverte ; approbation de la version 2 : version 1 obsolète, instantané conservé et lisible, comparaison accessible ; lecture de la cohérence SKU sans droit refusée ; audit (collections, prototypes, revues, rejets, approbations, renommage).
  - `pdm` : 92 PASS, 0 FAIL (suite existante adaptée : validation directe refusée, passage par la revue, preuve visuelle exigée, rédacteur ne peut pas approuver ; tolérance ajoutée à une mesure de la version 2).
  - Régressions : `variants` 88 PASS, `variants_units` 28 PASS, 0 FAIL (avant adaptation de `pdm`).
  - Suite SQL complète (`npm run test:sql`) : **3206 PASS, 0 FAIL**, sortie 0 (journal `SUITE_EXIT=0`).
  - `npx tsc --noEmit` (web) : sans erreur. `npm run test:unit` (web) : sans erreur.
- Décisions et rupture à valider par le propriétaire :
  - Validation directe depuis le brouillon supprimée : toute version passe par la revue (rupture de l'ancien parcours).
  - Séparation des tâches : le rédacteur et le demandeur de revue ne peuvent pas approuver.
  - Preuves exigées : au moins une mesure, chaque mesure avec tolérance, au moins un visuel ou un document. La tolérance n'a pas d'unité ni de valeur imposée (texte libre).
  - Renommage de SKU : seulement vers le SKU de la spécification, avec motif et mapping ; la règle d'immuabilité du SKU et de l'historique (0039) est maintenue, avec cette seule exception.
- Limites :
  - **Pas d'écran de collections** : la gestion des collections n'est pas exposée dans l'interface (fonctions seulement).
  - Pas de statut « approuvé » distinct de « validé » : le libellé est « Approuvée » dans les écrans produits seulement.
  - Les bibliothèques tissus et accessoires ne sont pas enrichies (composants existants réutilisés).
  - Les documents de preuve passent par la GED existante (documents seulement) ; les visuels doivent exister dans le stockage.
  - Le contrôle de cohérence SKU ne couvre que les variantes de la spécification active (les variantes absentes du catalogue sont signalées sans bloquer).
  - Écrans non vérifiés dans un navigateur (Docker indisponible) ; migration non appliquée à `erp360_real` ; matrice d'écarts non mise à jour.
- Prochain lot : écran de gestion des collections ; vérification navigateur des écrans produits ; mise à jour de la matrice.

### P044 — BOM consommations et substitutions (migration 0069)
- Objectif : nomenclatures par variante, taille et coloris ; consommation, pertes, unités et conversions ; substitutions autorisées avec motif ; versions datées et approbation distincte ; figer la version de la nomenclature au lancement de l'OF ; contrôle de la référence matière et de la conversion.
- Critère d'acceptation : « Nouvelle BOM ne change pas OF ancien, quantités et substitutions validées. » Démontré par `bom_consumption_substitutions` (section 5 : l'OF 1 garde 21 m après validation de la version 2 ; l'OF 2 lancé ensuite prend 31,5 m).
- Existant conservé et réutilisé : nomenclatures `boms` / `bom_versions` / `bom_lines` (0008), taux de perte `waste_pct`, matières et prix (`bom_materials`, `bom_material_prices`), archivage de matière (`bom_material_archive`), copie de version `bom_new_version`, OF (0019) et son calcul de besoins MRP (0010). Les règles existantes de validation (0008 et 0039) sont redéfinies, non supprimées.
- Identifiants CDC : non renseignés (matrice non modifiée dans cette livraison).
- Ajouts SQL (0069), additifs :
  - Tables : `bom_line_attributes` (unité, taille, coloris restreints par ligne), `bom_unit_conversions` (conversion vers l'unité de la matière seulement), `bom_line_substitutions` (matière de remplacement, quantité, motif obligatoire, par version), `production_order_bom` (figure immuable de la version et de ses lignes, une par OF).
  - Fonctions : `private.bom_unit_factor`, `public.bom_unit_conversion_set`, `public.bom_line_set_attributes`, `public.bom_line_substitute_add`, `public.bom_line_substitute_remove`, `public.production_order_requirements(order, size, color)` (besoins calculés sur la figure de l'OF).
  - Redéfinies : `private.bom_copy_content` (copie aussi attributs et substitutions), `public.bom_validate_version` (séparation des tâches `SOD_SELF_APPROVAL`, `BOM_UNIT_CONVERSION_MISSING`, `BOM_ATTRIBUTE_UNKNOWN`, `BOM_MATERIAL_ARCHIVED`, date d'effet = date du jour), `private.production_freeze_bom`.
  - Trigger `production_orders_bom_freeze_au` : au passage de l'OF à `launched`, la version validée est figée dans `production_order_bom`. Le lancement lui-même (RPC existante) n'est pas modifié.
  - Immutabilité de `production_order_bom` : modification et suppression refusées (`STOCK_IMMUTABLE` ; `permission denied` pour un utilisateur applicatif).
  - Audit : `production.bom_freeze`, `bom.unit_conversion`, `bom.line_attributes`, `bom.substitute_add`.
- Fichiers SQL : `supabase/migrations/0069_bom_consumption_substitutions.sql` ; `web/tests/sql/bom_consumption_substitutions.test.mjs`.
- Fichiers de configuration : `web/tests/sql/rbac.test.mjs` (liste de migrations incluant 0069) ; `web/package.json` (`test:sql`, nouveau test).
- Aucun fichier web applicatif modifié dans ce lot (pas d'écran, pas d'action).
- Tests réellement exécutés (PGlite) :
  - `bom_consumption_substitutions` : 22 PASS, 0 FAIL. Couvre : conversion vers une autre unité que celle de la matière refusée ; attribut d'unité sans conversion refusé ; taille inconnue refusée ; restriction à la taille M et au coloris Marine ; substitution sans motif suffisant refusée ; substitution par la même matière refusée ; doublon refusé (`BOM_SUBSTITUTE_DUPLICATE`) ; approbation par le rédacteur refusée ; approbation par un autre utilisateur datée ; OF lancé avec version 1 figée ; besoins 21 m (10 × 2 × 1,05) et 15 m (10 × 150 cm) ; substitution listée sans doubler les quantités ; ligne restreinte non comptée sans taille ni coloris et signalée ; nouvelle version copiée ; OF ancien inchangé après validation de la version 2 ; nouvel OF figé en version 2 (31,5 m) ; figure non modifiable ; substitution archivée refusée à la validation ; droit de lecture requis (`RBAC_FORBIDDEN`) ; audit tracé.
  - Régressions : `rbac` 63 PASS ; `bom` 152 PASS ; `production` 44 PASS ; `variants` 88 PASS ; `variants_units` 28 PASS ; `pdm` 92 PASS ; `mrp` 62 PASS ; 0 FAIL partout.
  - Suite SQL complète (`npm run test:sql`) : **3228 PASS, 0 FAIL**, sortie 0 (journal `SUITE_EXIT=0`).
  - `npx tsc --noEmit` et `npm run test:unit` : non relancés dans ce lot (aucun fichier web modifié).
- Décisions :
  - La validation d'une nomenclature exige un approbateur distinct du rédacteur (`SOD_SELF_APPROVAL`). Rupture : une validation faite par le même compte n'est plus possible.
  - La date d'effet d'une version validée est fixée à la date du jour.
  - Une ligne restreinte (taille ou coloris) n'est comptée dans les besoins que si la taille et le coloris sont fournis ; sinon elle est signalée (`restricted_lines`).
  - Aucun seuil d'approbation, aucune règle de fiscalité ni de valorisation n'a été inventé.
- Limites :
  - **Pas d'écran** pour les attributs, les conversions et les substitutions : les fonctions SQL seulement.
  - **OF lancés avant 0069** : aucune figure n'existe ; `production_order_requirements` lève `PRODUCTION_BOM_SNAPSHOT_MISSING`. Aucune reprise de données n'a été faite : décision du propriétaire requise.
  - Les conversions ne couvrent que les unités déclarées explicitement ; pas de table de conversion générique.
  - Migration non appliquée à la base locale ni à `erp360_real` ; validée par PGlite seulement.
  - Écrans non vérifiés dans un navigateur (Docker indisponible) ; matrice d'écarts non mise à jour.
- Prochain lot (à décider par le propriétaire) : écrans de gestion des attributs, conversions et substitutions ; décision sur la reprise des OF déjà lancés sans figure.

### P045 — gammes et temps standards (migration 0070)
- Objectif : gammes par article avec opérations coupe / confection / personnalisation / contrôle / pack ; postes ; compétences ; temps standard versionnés en unité explicite (s, min, h) ; calendrier de poste ; gamme approuvée figée au lancement de l'OF ; instructions d'opération lisibles avec le droit de lecture de la gamme.
- Critères d'acceptation : « Gamme approuvée figée, temps en unité cohérente, version historique conservée ». Démontrés par `routing_standard_times` (42 PASS) : gamme v1 approuvée et figée ; temps convertis en minutes (1,5 h = 90 min ; 30 s = 0,5 min ; 90 s = 1,5 min) ; tolérance explicite ; v1 remplacée sans être supprimée ; OF lancé avant v2 garde v1 ; OF lancé après v2 prend v2.
- Existant conservé et réutilisé : postes `work_centers` (0019 : type, heures par jour, rendement) ; calendriers `calendars` (0042 : jours ouvrés ISO) ; opérations de nomenclature `bom_operations` (0008, coût main d'œuvre, **non remplacées**) ; OF `production_orders` (0019 : `std_minutes_per_unit` saisi à la main, **inchangé**) ; figure de nomenclature `production_order_bom` (0069, inchangée) ; droits production (0019), audit (`write_audit`), contrôles de société et de droits (`require_perm`).
- Identifiants CDC : non renseignés (matrice non modifiée dans cette livraison).
- Ajouts SQL (0070), additifs :
  - Droits : `routing.read`, `routing.write`, `routing.approve`. Admin : tous ; direction : lecture et approbation ; production : lecture et écriture ; qualité : lecture.
  - Postes : types `personnalisation` et `pack` ajoutés à la contrainte existante ; colonne `work_centers.calendar_id` ; garde `work_centers_calendar_guard_biu` (calendrier de la même société, non archivé).
  - Compétences : `production_skills` (catalogue, code normalisé) et `profile_skills` (niveau 1 à 3, date de validité facultative, une ligne par personne et compétence).
  - Gammes : `routing_versions` (brouillon, approuvée, remplacée ; une seule approuvée et un seul brouillon par article) ; `routing_operations` (type, poste, compétence facultative, valeur et unité de temps, tolérance en %, instructions ≤ 4000 car.) ; colonnes générées `standard_minutes` et `minutes_with_allowance` (minutes par pièce).
  - Figure : `production_order_routing` (statut `frozen` ou `no_routing`, version, opérations en JSON) ; immuable (mise à jour et suppression refusées).
  - Gardes : écritures des gammes uniquement par fonctions (drapeau `routing.rpc`, `ROUTING_RPC_ONLY`) ; opérations modifiables seulement sur brouillon (`ROUTING_VERSION_LOCKED`).
  - Fonctions : `production_skill_create`, `production_skill_set_active`, `profile_skill_set`, `routing_version_create` (copie la version approuvée), `routing_operation_add`, `routing_operation_remove`, `routing_version_approve`, `routing_version_summary`, `routing_operation_instructions`, `work_center_capacity`, `production_order_routing_get`.
  - Trigger `production_orders_routing_freeze_au` : au passage à `launched`, la gamme approuvée de l'article est figée (`no_routing` sinon).
  - Audit : `routing.version_create`, `routing.version_approve`, `routing.operation_add`, `routing.operation_remove`, `skill.create`, `skill.archive`, `skill.restore`, `skill.grant`.
- Fichiers SQL : `supabase/migrations/0070_routings_standard_times.sql` ; `web/tests/sql/routing_standard_times.test.mjs`.
- Fichiers de configuration et de catalogue : `web/tests/sql/rbac.test.mjs` (migration 0070 ajoutée) ; `web/package.json` (`test:sql`, nouveau test) ; `web/src/lib/rbac/permissions.ts` (constantes `ROUTING_READ`, `ROUTING_WRITE`, `ROUTING_APPROVE`, pour la cohérence catalogue TypeScript ↔ SQL).
- Tests réellement exécutés :
  - `routing_standard_times` : 42 PASS, 0 FAIL. Couvre : compétence créée, code en double refusé, niveau hors 1–3 refusé, niveau mis à jour sans doublon ; capacité du poste (8 h × 60 × 85 % × 5 j = 2040 min/semaine) ; poste sans calendrier sans capacité inventée ; calendrier d'une autre société refusé ; second brouillon refusé ; type, unité, temps, tolérance et compétence invalides refusés ; total 100,625 min/pièce ; conversions ; instructions lisibles, refusées sans droit ; modification directe refusée ; approbation sans droit refusée ; auto-approbation refusée ; approbation distincte ; gamme approuvée non modifiable ; OF avec gamme figée (5 opérations) ; OF sans gamme : `no_routing` ; v2 copiée puis modifiée sans toucher v1 ; v1 remplacée, une seule approuvée ; OF figés sur leur version ; figure immuable (mise à jour et suppression) ; écriture directe du catalogue refusée ; audit.
  - Régressions : `rbac` 63 PASS (après ajout des constantes TypeScript) ; `bom` 152 ; `production` 44 ; `variants` 88 ; `variants_units` 28 ; `pdm` 92 ; `mrp` 62 ; `bom_consumption_substitutions` 22 : 0 FAIL partout.
  - Suite SQL complète (`npm run test:sql`) : **3270 PASS, 0 FAIL**, sortie 0.
  - `npx tsc --noEmit` (web) : sans erreur. `npm run test:unit` (web) : 4 PASS, 0 FAIL, sortie 0.
- Décisions à valider par le propriétaire :
  - Les opérations de gamme sont un référentiel distinct de `bom_operations`. Les deux coexistent ; aucune reprise ni synchronisation n'est faite.
  - Le temps standard de l'OF (`std_minutes_per_unit`) n'est pas recalculé à partir de la gamme.
  - La gamme figée est une copie ; une modification ultérieure de la gamme approuvée ne change pas les OF déjà lancés.
  - Les instructions sont protégées par le droit de lecture de la gamme, pas par un contrôle par poste.
- Limites :
  - **Pas d'écrans opérationnels ni de routes API pour ce lot** : la gestion des gammes, des postes, des compétences et des instructions n'est accessible que par fonctions SQL. Le brief demande des écrans ; ils ne sont pas livrés et doivent faire l'objet d'un lot suivant. Rien n'a été vérifié dans un navigateur.
  - Les instructions ne sont pas filtrées par poste : tout détenteur de `routing.read` lit les instructions de toutes les opérations de la société. « Accessible au poste autorisé » n'est donc pas appliqué au sens strict.
  - Les compétences ne bloquent rien : une opération peut être affectée sans contrôle que la personne qui la réalise possède la compétence requise. Aucun lien avec la planification n'existe.
  - Le calendrier porte les jours ouvrés ; les heures viennent du poste (`hours_per_day`), pas du calendrier. Aucune capacité n'est calculée pour un poste sans calendrier.
  - Les OF lancés avant 0070 n'ont pas de figure de gamme ; aucune reprise n'a été faite.
  - Migration non appliquée à la base locale Supabase ni à `erp360_real` ; validée par PGlite seulement.
  - Matrice d'écarts non mise à jour.
- Prochain lot (à décider par le propriétaire) : écrans gammes (liste, fiche, brouillon, approbation), écran des postes et compétences, puis décision sur la reprise des OF lancés sans figure et sur le lien entre compétence et affectation.

### P046 — MRP et planification des besoins (migration 0071)
- Objectif : besoins calculés à partir des commandes et prévisions validées, du stock utilisable, des réservations, des nomenclatures, des délais et des lots ; propositions d'achat et d'OF expliquées ; aucune commande ferme créée par le calcul ou la décision.
- Critères d'acceptation : « Besoins réconciliés, stock bloqué exclu, proposition sans commande ferme ». Démontrés par `mrp_reconciliation` (27 PASS) : stock en quarantaine (30) et lot périmé (20) exclus du disponible ; réservation liée couvrant le besoin comptée une seule fois (proposition 30 m contre 40 m sans liaison, écart = 10 m réservés) ; contrôle de réconciliation par composant, avec détection d'un écart injecté ; compteurs de commandes d'achat et d'OF inchangés après simulation et décisions.
- Existant conservé et réutilisé : moteur `mrp_run` (0010) avec ses paramètres, ses sorties, ses décisions (`mrp_suggestion_decide`), sa suppression et son audit ; prévisions, paramètres d'approvisionnement, réceptions planifiées ; stock de sécurité (`stock_thresholds`) ; quarantaine (emplacements de type « quarantine », 0009/0063) ; réservations (0009) ; conversions d'unité et lignes restreintes (0069) ; droits `mrp.read` / `mrp.write`. Le test MRP existant (62 PASS) passe sans modification de ses scénarios.
- Identifiants CDC : non renseignés (matrice non modifiée dans cette livraison).
- Ajouts SQL (0071), additifs :
  - Réservations : `stock_reservations.sales_order_line_id` (nullable) ; fonction `stock_reservation_link_order_line(réservation, ligne)` (liaison ou déliaison ; ligne confirmée uniquement ; composant de la ligne seulement ; réservation active seulement). Droit : `stock.write` et rôle sur l'entrepôt (garde 0017).
  - Simulation (`mrp_run` redéfini, mêmes paramètres) : stock utilisable = lots hors quarantaine et non périmés ; disponible de départ = utilisable − réservations actives + couvert par les réservations liées ; besoin brut inchangé ; colonnes ajoutées par composant (`total_lots`, `quarantine_excluded`, `expired_excluded`, `covered_qty`, `projected_end`) ; couverture par ligne dans `mrp_run_pegging.covered_qty` ; explication par proposition (`mrp_run_suggestions.explanation`) ; propositions d'OF (`mrp_run_production_suggestions`, une par article et par date de besoin).
  - Réconciliation : `private.mrp_reconcile` (écarts sur besoin brut, propositions, stock = utilisable + quarantaine + périmé, solde final = utilisable − réservé + couvert + réceptions − besoin + proposé, proposition ≥ besoin net) ; résultat dans `summary.reconciled` et `summary.reconciliation_issues` ; `mrp_run_reconcile(run)` (droit `mrp.read`).
  - Décision sur une proposition d'OF : `mrp_production_suggestion_decide` (droit `mrp.write`, audit `mrp.decide_production`). Elle ne crée aucun OF.
  - Explosion des nomenclatures (`private.mrp_unit_requirements`, `private.mrp_article_issue`) redéfinies : conversion d'unité de P044 ; lignes restreintes (taille ou coloris) exclues du besoin et signalées (`restricted_lines`) ; conversion absente signalée (`unit_conversion_missing`, jamais atteignable par les fonctions actuelles, car la conversion est vérifiée à la saisie de l'attribut).
  - Audit : `mrp.run` (avec `reconciled`), `mrp.reservation_link`, `mrp.reservation_unlink`, `mrp.decide_production`.
- Fichiers SQL : `supabase/migrations/0071_mrp_reconciliation.sql` ; `web/tests/sql/mrp_reconciliation.test.mjs`.
- Fichiers de test modifiés : `web/tests/sql/mrp.test.mjs` (charge désormais toutes les migrations, comme les tests récents, et valide les taux de TVA en attente, comme `bat_logos_validation` ; les scénarios et valeurs attendues sont inchangés) ; `web/tests/sql/rbac.test.mjs` (0071 ajoutée) ; `web/package.json` (`test:sql`, nouveau test).
- Tests réellement exécutés :
  - `mrp_reconciliation` : 27 PASS, 0 FAIL. Couvre : quarantaine exclue (30) et disponible 100 ; lot périmé exclu (20) ; proposition de 30 (20 aujourd'hui, 10 à J+23) quand la quarantaine n'est pas comptée ; conversion cm → m (4 × 150 cm = 6 m) ; ligne restreinte non comptée et signalée ; article sans nomenclature signalé ; réservation liée : 30 m contre 40 m non liée ; refus de liaison (ligne brouillon, composant absent, réservation libérée, sans droit) ; explication ; propositions d'OF (A et B seulement) ; décision sans OF créé ; achat accepté sans commande créée ; détection d'un écart injecté ; droits de réconciliation ; insertion directe refusée ; audit.
  - Régressions : `mrp` 62 PASS ; `rbac` 63 ; `stock_journal_reservations` 25 ; `stock_fifo_fefo_picking` 43 ; `stock_transfers_transit` 48 ; `inventory_blind_approval` 35 ; `production` 44 ; `bom` 152 : 0 FAIL partout.
  - Suite SQL complète (`npm run test:sql`) : **3297 PASS, 0 FAIL**, sortie 0.
  - Aucun fichier web applicatif modifié dans ce lot : `tsc` et `test:unit` non relancés.
- Décisions à valider par le propriétaire :
  - Stock bloqué = stock dans un emplacement de type « quarantaine ». Il n'existe pas de statut qualité par lot dans le modèle actuel ; un lot bloqué hors quarantaine serait compté.
  - Stock périmé = lot dont la date d'expiration est antérieure à la date du calcul.
  - Une réservation liée à une ligne couvre le besoin de cette ligne au plus une fois ; le reste reste une réservation qui réduit le disponible.
  - Les lignes restreintes (taille ou coloris) ne sont pas comptées par la simulation, car elle ne reçoit ni taille ni coloris. Elle doit être complétée par un besoin par taille, à décider.
  - Les propositions d'OF utilisent la date de besoin déjà décalée de `offset_days`.
- Limites :
  - **Pas d'écran MRP dans ce lot** : les simulations, les propositions et la liaison restent accessibles par fonctions SQL. Le brief demande des écrans opérationnels ; ils ne sont pas livrés.
  - **Le stock de produits finis n'est pas modélisé** : les propositions d'OF ne déduisent aucun stock d'articles finis (`finished_stock_netted = false`).
  - Aucune conversion automatique de proposition en commande d'achat ou en OF : l'engagement reste une action humaine, hors de ce lot.
  - Les réservations sans ligne de commande (OF, usage manuel) continuent de réduire le disponible sans être rattachées à un besoin.
  - Migration non appliquée à la base locale Supabase ni à `erp360_real` ; validée par PGlite seulement.
  - Matrice d'écarts non mise à jour.
- Prochain lot (à décider par le propriétaire) : écran MRP (simulation, besoins, propositions, réconciliation, liaison de réservation) ; statut qualité par lot ; besoins par taille et coloris ; décision sur le stock de produits finis.

### P047 — capacité et ordonnancement (migration 0072)
- Objectif : charge par poste et par jour, capacité finie à partir du calendrier du poste, priorité des OF, simulations de planification comparables, replanification soumise à validation distincte avec impact client visible, plan accepté versionné ; aucune surcharge silencieuse ; données manquantes signalées, jamais remplacées par un calendrier fictif.
- Critères d'acceptation : « Pas de surcharge silencieuse, scénario comparé, plan accepté versionné ». Démontrés par `capacity_scheduling` (40 PASS) : charge du jour T à 900 min pour 480 de capacité signalée en surcharge ; plan simulé sans aucun jour de COUP47 au-delà de la capacité ; deux scénarios comparés (priorité : P2 finit un jour après son échéance client ; échéance client : aucun retard nouveau) ; validation refusée sans accord client puis sans accord de surcharge ; plan accepté en version 1 avec les OF modifiés ; scénario devenu obsolète refusé (PLAN_STALE) ; scénario refusé sans modification d'OF.
- Existant conservé et réutilisé : OF (0019 : dates, poste, quantité, temps standard par pièce, statuts, création, replanification, lancement, suspension), postes et calendriers (0019, 0042, 0070), tableau de bord de production (0019, `production_dashboard`, inchangé). Le « surchargé » du tableau de bord (plus de 20 jours de charge, sans calendrier) est une heuristique existante ; le nouveau calcul ne l'utilise pas et ne la remplace pas.
- Identifiants CDC : non renseignés (matrice non modifiée dans cette livraison).
- Ajouts SQL (0072), additifs :
  - Droits : `production.approve_plan` (admin, direction). Planifier et simuler : `production.plan` (existant). Lire la charge et les plans : `production.read` (existant).
  - OF : colonne `priority` (1 à 5, défaut 3). Fonction `production_order_set_priority` (refuse les OF terminés).
  - Fonctions de calcul : `private.wc_day_capacity` (capacité d'un jour : heures × 60 × rendement si jour ouvré du calendrier ; null sans calendrier ou calendrier archivé), `private.production_spread` (charge répartie sur les jours ouvrés d'une fenêtre), `private.order_due` (échéance client confirmée du même article).
  - Tables : `production_schedule_scenarios` (PLN-, statut simulé / validé / refusé, paramètres, résumé, décision, accords), `production_schedule_lines` (une ligne par OF : statut, dates de référence et simulées, retard, impact client), `production_capacity_days` (charge, capacité, statut par poste et par jour), `production_plan_versions` (version numérotée avec les changements avant / après).
  - Immutabilité : lignes, jours de capacité et versions ne sont ni modifiables ni supprimables ; écritures par fonctions seulement (drapeau `schedule.rpc`) ; scénarios non supprimables.
  - Fonctions publiques : `production_load(du, au)` (charge par poste et par jour : figée + planifiée à dates actuelles, plage de 120 jours au plus), `production_schedule_simulate(nom, paramètres)` (tri `priority` ou `due_date`, horizon 1 à 365 jours, 120 par défaut), `production_schedule_compare(a, b)`, `production_schedule_validate(scénario, décision, note, accord client, accord surcharge)`.
  - Audit : `production.order_priority`, `production.schedule_simulate`, `production.plan_validate`, `production.plan_reject`.
- Règles de calcul :
  - Charge figée (OF lancés ou en cours) : minutes = quantité × temps standard, répartis également sur les jours ouvrés de la fenêtre planifiée ; ils ne sont pas déplacés.
  - OF planifiés : placés par priorité (1 = la plus haute) puis date planifiée, ou par échéance client si le tri est « due_date » ; ils commencent au plus tôt à la date planifiée ou à aujourd'hui, et ne prennent que la capacité libre.
  - Un OF qui ne tient pas dans l'horizon est « unscheduled » ; il n'est jamais forcé.
  - Un OF sans poste est « no_work_center » ; un OF dont le poste n'a pas de calendrier est « capacity_missing ».
  - Retard client nouveau : la fin simulée dépasse l'échéance alors que la fin planifiée actuelle ne la dépassait pas. Il exige l'accord client à la validation.
  - Surcharge : un jour où la charge dépasse la capacité est enregistré « overload » ; il exige l'accord de surcharge à la validation.
  - Validation : refusée si le valideur est l'auteur (SOD_SELF_APPROVAL), si le scénario n'est pas simulé (PLAN_BAD_STATUS), si un accord manque, ou si un OF a changé depuis la simulation (statut, poste ou dates : PLAN_STALE). Seuls les OF planifiés ordonnancés changent de dates.
- Fichiers SQL : `supabase/migrations/0072_capacity_scheduling.sql` ; `web/tests/sql/capacity_scheduling.test.mjs`.
- Fichiers de configuration et de catalogue : `web/tests/sql/rbac.test.mjs` (0072 ajoutée) ; `web/package.json` (`test:sql`, nouveau test) ; `web/src/lib/rbac/permissions.ts` (constante `PRODUCTION_APPROVE_PLAN`).
- Tests réellement exécutés :
  - `capacity_scheduling` : 40 PASS, 0 FAIL. Couvre : charge du jour T (figé 300 + planifié 600 = surcharge) ; poste sans calendrier signalé sans capacité ; plage de charge refusée au-delà de 120 jours ; simulation par priorité (résumé, P1 fin J+2, P2 fin J+3 avec retard client, aucune surcharge planifiée sur COUP47, OF sans calendrier et sans poste signalés, aucun jour de capacité inventé) ; OF suspendu exclu mais compté ; semaine de 5 jours respectée (aucun jour de capacité ni de fin un week-end) ; tri par échéance sans retard nouveau ; tri inconnu et droit de simulation refusés ; comparaison des deux scénarios ; validation refusée (auteur, droit, accord client, accord de surcharge, scénario déjà validé, obsolète) ; validation acceptée en version 1, dates des OF mises à jour ; priorité refusée hors bornes et sans droit ; scénario refusé sans modification d'OF ; écritures directes refusées ; scénario d'une autre société invisible ; audit.
  - Régressions : `production` 44 PASS ; `mrp` 62 ; `mrp_reconciliation` 27 ; `routing_standard_times` 42 ; `bom_consumption_substitutions` 22 ; `rbac` 63 : 0 FAIL.
  - `npx tsc --noEmit` (web) : sans erreur. `npm run test:unit` (web) : 4 PASS, 0 FAIL.
  - Suite SQL complète (`npm run test:sql`), après la dernière modification de la migration : **3337 PASS, 0 FAIL**, sortie 0.
- Décisions à valider par le propriétaire :
  - Un OF lancé ou en cours est une charge figée : il n'est pas replanifié. Seuls les OF planifiés changent de dates.
  - La charge d'un OF figé est répartie également sur les jours ouvrés de sa fenêtre (approximation explicite).
  - Un OF commence au plus tôt à la date planifiée ou à aujourd'hui : la simulation ne l'avance jamais avant sa date planifiée.
  - La durée d'un OF est `quantité × std_minutes_per_unit` (valeur saisie sur l'OF), pas les minutes de la gamme (P045) : le lien entre gamme et OF reste à décider.
  - Le retard client s'appuie sur les lignes de commandes **confirmées** du même article, pour le même OF.
- Limites :
  - **Pas d'écran** : la charge, les scénarios, la comparaison et la validation ne sont accessibles que par fonctions SQL. Le brief demande des écrans opérationnels ; ils ne sont pas livrés. Rien n'a été vérifié dans un navigateur.
  - **Pas d'entité « équipe »** dans le dépôt : la charge est calculée par poste (atelier ou machine). La charge par équipe n'est pas faite, et aucune équipe n'a été inventée.
  - Le calendrier porte les jours ouvrés, pas les jours fériés ni les absences : un jour férié saisi comme ouvré donnerait une capacité fausse.
  - Les heures par jour et le rendement viennent des postes ; leurs valeurs par défaut (8 h, 85 %) sont celles de la table existante, pas des données validées par l'atelier.
  - Le tableau de bord existant garde son heuristique « surchargé » (plus de 20 jours) : elle n'est pas alignée sur la nouvelle charge.
  - Les OF suspendus sont exclus de la simulation et de la charge (signalés seulement par leur nombre dans le résumé).
  - Migration non appliquée à la base locale Supabase ni à `erp360_real` ; validée par PGlite seulement.
  - Matrice d'écarts non mise à jour.
- Prochain lot (à décider par le propriétaire) : écrans de charge et de planification (charge, scénarios, comparaison, validation avec accords) ; calendrier avec jours fériés ; lien gamme → temps de l'OF ; décision sur l'équipe comme entité.

### P048 — OF coupe et généalogie des lots (migration 0073)
- Objectif : OF figé au lancement (quantité, variante, nomenclature, gamme) ; réservations rattachées à l'OF ; coupe par matelas consommant des lots matière ; sortie des produits finis liée à l'OF ; fractionnement de lots avec quantités ; traçabilité amont et aval ; encours d'un OF.
- Critères d'acceptation : « Lot matière retrouvable dans produits/commandes, pas de consommation impossible ». Démontrés par `cutting_lot_genealogy` (34 PASS) : le lot TIS-A est retrouvé jusqu'au matelas MAT-0001, à l'OF, au lot produit LOT-P48-A, à l'expédition SHP et à la commande de vente ; une consommation sur un lot périmé est refusée et annulée (rien ne sort, le matelas reste planifié) ; une consommation au-delà du disponible est refusée ; la quarantaine n'est jamais consommée (TIS-Q intacte) ; une consommation peut s'étendre sur deux lots (27,4 m puis 32,6 m).
- Existant conservé et réutilisé : OF (0019) et journal de production (rebuts, bons), figures de nomenclature et de gamme (0069, 0070), réservations (0009), lots matière et allocations FIFO par mouvement (0009, 0011, 0064), garde-fous qualité (0063) et entrepôt (0017), sortie et disponibilité via `private.stock_apply` (0011), produits finis et stock de variante (0055 : `finished_lot_receive`, `finished_lots` en ajout seul), expéditions (0021, 0055 : shipments, shipment_lines, shipment_line_lots).
- Identifiants CDC : non renseignés (matrice non modifiée dans cette livraison).
- Ajouts SQL (0073), additifs :
  - OF : colonnes `variant_id` et `frozen_at`. Trigger `production_orders_freeze_bu` : après le lancement, quantité, article, variante, temps standard, poste et dates ne changent plus (`OF_FROZEN`). Fonction `production_order_set_variant` (OF planifié seulement ; la variante doit appartenir à la fiche produit liée à l'article : `OF_VARIANT_ARTICLE_MISMATCH`).
  - Réservations : colonne `stock_reservations.production_order_id` ; fonction `production_reservation_link` (droit stock.write ; réservation active ; OF lancé ; matière dans la nomenclature figée).
  - Produits finis : `finished_lots.production_order_id` ; origine élargie à `split` (contrainte remplacée) ; table `lot_splits` (ajout seul) ; fonctions `production_finished_lot_receive` (sortie d'OF : réception standard `finished_lot_receive`, référence = numéro d'OF, quantité cumulée ≤ quantité de l'OF) et `finished_lot_split` (le lot d'origine enregistre une sortie `qty_out`, le lot enfant reçoit la quantité, origine `split`, sans mouvement de stock de variante).
  - Matelas : table `production_cut_plans` (code MAT-, matière de la nomenclature figée, unité mètre, longueur × couches × (1 + perte) = quantité requise générée, pièces par couche, pièces de l'OF ≤ quantité de l'OF) ; immuable une fois consommé ; fonctions `production_cut_plan_create`, `production_cut_plan_consume` (sortie standard `private.stock_apply` avec la réservation de l'OF quand elle couvre le matelas ; refus et annulation complète si un lot consommé est périmé : `CUT_EXPIRED_LOT`), `production_cut_plan_cancel` (motif obligatoire).
  - Encours : `production_order_wip` (pièces coupées, en attente de coupe, sorties, rebuts, encours = coupées − sorties − rebuts).
  - Traçabilité : `lot_trace_material` (amont → aval : matelas, OF, lots produits, expéditions, commandes ; compte les sorties hors matelas) ; `lot_trace_finished` (aval → amont : parent de fractionnement, OF, matelas et lots matière consommés, expéditions).
  - Audit : `production.reservation_link`, `production.order_variant`, `production.cut_plan_create`, `production.cut_consume`, `production.cut_cancel`, `production.output_lot`, `lot.split`.
- Fichiers SQL : `supabase/migrations/0073_cutting_lot_genealogy.sql` ; `web/tests/sql/cutting_lot_genealogy.test.mjs`.
- Fichiers de configuration : `web/tests/sql/rbac.test.mjs` (0073 ajoutée) ; `web/package.json` (`test:sql`, nouveau test). Aucune permission nouvelle : production.write, stock.write, production.read utilisés.
- Tests réellement exécutés :
  - `cutting_lot_genealogy` : 34 PASS, 0 FAIL. Couvre : OF lancé avec nomenclature figée, variante renseignée avant lancement, quantité et variante non modifiables après lancement ; variante d'une autre fiche produit refusée ; réservation liée, matière absente de la nomenclature refusée ; garde-fous de création de matelas (droit, unité, matière absente, pièces en excès) ; calcul 4 m × 3 × 1,05 = 12,6 m ; consommation avec réservation de l'OF et lot FIFO enregistré ; second passage refusé ; lot périmé refusé sans mouvement ; insuffisance refusée ; annulation ; consommation sur deux lots sans toucher la quarantaine ; encours (coupées, sorties, en cours) ; sortie de produits liée à l'OF ; dépassement refusé ; code de lot en double refusé ; fractionnement (dépassement refusé, parent et enfant) ; expédition avec affectation du lot ; traçabilité amont et aval ; audit.
  - Régressions : `rbac` 63 ; `production` 44 ; `capacity_scheduling` 40 ; `mrp` 62 ; `mrp_reconciliation` 27 ; `routing_standard_times` 42 ; `bom_consumption_substitutions` 22 ; `stock_journal_reservations` 25 ; `stock_fifo_fefo_picking` 43 ; `stock_transfers_transit` 48 ; `inventory_blind_approval` 35 ; `deliveries_returns` 33 ; `shipping` 43 : 0 FAIL partout.
  - Suite SQL complète (`npm run test:sql`), après la dernière modification de la migration : **3371 PASS, 0 FAIL**, sortie 0.
  - Aucun fichier TypeScript modifié dans ce lot : `tsc` et `test:unit` non relancés.
- Décisions à valider par le propriétaire :
  - Un matelas ne porte qu'une matière et une longueur : pas de plan de matelas par taille ni de détail par couche.
  - Les rouleaux sont consommés par lot matière (FIFO). Les unités physiques de rouleau (0062) ne sont pas utilisées par la consommation.
  - La sortie d'un OF est une réception de produit fini : elle alimente le stock de variante comme les autres réceptions.
  - Le fractionnement déplace une quantité par sortie du lot d'origine ; il ne modifie pas le stock de variante.
  - La consommation suit l'ordre de réception (FIFO), comme le reste du stock. Un lot périmé plus ancien bloque donc la consommation jusqu'à traitement (refus, rien ne sort).
- Limites :
  - **Pas d'écran** : coupe, encours, fractionnement et traçabilité ne sont accessibles que par fonctions SQL. Le brief demande des écrans opérationnels ; ils ne sont pas livrés. Rien n'a été vérifié dans un navigateur.
  - Les rebuts de coupe ne sont pas déduits de la quantité sortie (la sortie ne dépasse pas la quantité de l'OF ; les rebuts sont ceux du journal de production).
  - La consommation ne suit pas l'expiration (FEFO) : un lot périmé ancien empêche la consommation au lieu d'être contourné.
  - Migration non appliquée à la base locale Supabase ni à `erp360_real` ; validée par PGlite seulement.
  - Matrice d'écarts non mise à jour.
- Prochain lot (à décider par le propriétaire) : écrans (coupe, encours, sorties, fractionnement, traçabilité) ; FEFO pour la consommation des matelas ; décision sur les rouleaux physiques dans la consommation ; décision sur la déduction des rebuts de coupe.

### P049 — confection, personnalisation et temps réels (migration 0074)
- Objectif : déclaration par opération de la gamme figée (temps productif, arrêt, retouche ; bonnes pièces, rebuts, retouches) ; personnalisation bloquée sans BAT approuvé et courant ; corrections tardives motivées et approuvées par un autre utilisateur ; tâches visibles aux seuls postes affectés.
- Critères d'acceptation : « BAT respecté, rejet non compté bon, temps et corrections traçables ». Démontrés par `operation_declarations_time` (34 PASS) : déclaration de personnalisation refusée sans spécification, sans BAT approuvé, et avec la spécification d'une ligne sans BAT ; rebuts (2) et retouches (1) non comptés bons (bons de l'opération : 7) ; temps productif, arrêt avec motif, retouche tracés ; correction tardive (plus de 2 jours) en attente sans effet sur les totaux, puis approuvée (135 min) ; correction rendant les bons négatifs refusée à l'approbation ; auto-approbation refusée ; saisies et corrections approuvées non modifiables ni supprimables ; audit complet.
- Existant conservé et réutilisé : journal de production (0019, immuable) inchangé ; gamme figée et postes (0070) ; personnalisation et BAT (0054 : spécifications, BAT approuvés, démarrage de l'opération, droits sur le logo) ; droits production.* et personalization.operate.
- Identifiants CDC : non renseignés (matrice non modifiée dans cette livraison).
- Ajouts SQL (0074), additifs :
  - Droits : `production.operate` (déclarer, demander une correction, voir ses tâches ; admin et production), `production.approve_log` (approuver ou refuser une correction ; admin et direction).
  - Affectations : table `production_operator_assignments` (opérateur, poste, actif) ; fonction `production_operator_assign` (droit production.plan).
  - Déclarations : table `production_operation_entries` (ajout seul : opération, poste, date, minutes productives, d'arrêt et de retouche, bons, rebuts, retouches, motif d'arrêt obligatoire si arrêt, spécification et opération de personnalisation pour une personnalisation) ; fonction `production_operation_declare`.
  - Corrections : table `production_entry_adjustments` (ajout seul, variations signées par champ, motif ≥ 10 caractères, tardive si la date a plus de 2 jours, statut en attente / approuvée / refusée) ; fonctions `production_entry_request_correction` et `production_entry_decide_correction` (approbation distincte du demandeur, totaux jamais négatifs, pièces de l'opération ≤ quantité de l'OF).
  - Lecture : `production_my_tasks` (opérations de la gamme figée des OF lancés ou en cours, aux postes affectés seulement, avec les instructions de l'opération) ; `production_order_totals` (par opération : minutes, bons, rebuts, retouches, approbations incluses ; bons du dernier poste ; corrections en attente).
  - Garde-fous : suppression et modification des déclarations interdites ; une correction ne change que sa décision (OPERATION_APPEND_ONLY).
  - Statut de l'OF : passe à « en cours » à la première déclaration.
  - Audit : `production.operation_declare`, `production.correction_request`, `production.correction_approve`, `production.correction_reject`, `production.operator_assign`, `production.operator_unassign`.
- Règles :
  - Une opération n'est déclarable que par un opérateur affecté à son poste.
  - Une opération « personnalisation » exige une spécification courante de la commande de l'OF, une opération de personnalisation démarrée sur un BAT approuvé, et des droits valides sur le logo (sinon PERSO_NO_VALID_BAT / LOGO_RIGHTS_INVALID).
  - Bon + rebut + retouche par opération ≤ quantité de l'OF. Les rebuts et retouches ne sont jamais comptés bons.
- Fichiers SQL : `supabase/migrations/0074_operation_declarations_time.sql` ; `web/tests/sql/operation_declarations_time.test.mjs`.
- Fichiers de configuration et de catalogue : `web/tests/sql/rbac.test.mjs` (0074 ajoutée) ; `web/package.json` (`test:sql`, nouveau test) ; `web/src/lib/rbac/permissions.ts` (constantes `PRODUCTION_OPERATE`, `PRODUCTION_APPROVE_LOG`).
- Tests réellement exécutés :
  - `operation_declarations_time` : 34 PASS, 0 FAIL (couverture : voir « Critères »).
  - Régressions : `rbac` 63 ; `bat_logos_validation` 46 ; `production` 44 ; `routing_standard_times` 42 ; `cutting_lot_genealogy` 34 ; `capacity_scheduling` 40 : 0 FAIL.
  - `npx tsc --noEmit` (web) : sans erreur. `npm run test:unit` (web) : 4 PASS, 0 FAIL.
  - Suite SQL complète (`npm run test:sql`) : **3405 PASS, 0 FAIL**, sortie 0.
- Décisions à valider par le propriétaire :
  - Les déclarations par opération restent distinctes du journal de production (0019) : elles n'alimentent pas `production_logs`. Les indicateurs existants (`production_order_metrics`, `production_dashboard`) ne voient donc pas les déclarations par opération. Deux sources coexistent ; une synchronisation reste à décider.
  - Le seuil de correction tardive est de 2 jours (choix de conception, à confirmer).
  - Une correction ne modifie que les minutes et les pièces ; la date et le poste ne sont pas corrigeables (une nouvelle déclaration est requise).
- Limites :
  - **Pas d'écran** : déclaration, tâches, corrections et approbations ne sont accessibles que par fonctions SQL. Le brief demande des écrans opérateurs ; ils ne sont pas livrés. Rien n'a été vérifié dans un navigateur ni sur un terminal mobile.
  - **Pas de rôle opérateur dédié** : le rôle existant `production` détient déjà `production.plan` (0019). Un opérateur de ce rôle peut donc s'affecter lui-même à un poste. Il faut un rôle opérateur sans droit de planification.
  - Les temps sont saisis en minutes : pas de chronomètre ni de pointage en temps réel.
  - Les tâches sont les opérations de la gamme figée : un OF sans gamme approuvée n'a aucune tâche.
  - Les corrections ne couvrent pas la date ni le poste.
  - Migration non appliquée à la base locale Supabase ni à `erp360_real` ; validée par PGlite seulement.
  - Matrice d'écarts non mise à jour.
- Prochain lot (à décider par le propriétaire) : écrans opérateurs (tâches, déclaration, corrections, approbation) ; rôle opérateur dédié ; synchronisation avec le journal de production ; pointage en temps réel.

### P050 — sous-traitance et clôture industrielle (migration 0075)
- Objectif : commandes de sous-traitance rattachées à un OF, prix convenu, matières externes suivies (propres confiées ou propriétaires du client), réconciliation des coûts standard et réel de l'OF avec explication, revue des écarts significatifs, clôture refusée si incohérente.
- Critères d'acceptation : « Matières externes suivies, coût standard / réel expliqué, clôture incohérente refusée ». Démontrés par `subcontract_industrial_close` (37 PASS) : matière de la société envoyée (sortie de stock, coût moyen 8 €), consommée (3 m, 24 €), rendue (1 m, rentrée en stock), solde 0 ; matière du client envoyée sans aucun mouvement de stock, rebutée, solde 0 ; coût standard et réel de chaque composant avec formule et éléments (matière 160 € / 160 €, main-d'œuvre 300 € / 300 €, sous-traitance 20 € / 25 €) ; écart significatif (25 % pour un seuil de 10 %) en attente, clôture refusée (CLOSE_VARIANCE_REVIEW_PENDING), approuvé par un autre utilisateur, clôture acceptée ; OF sans sortie de produits finis : contrôle en échec et clôture refusée (CLOSE_INCONSISTENT) ; seuil absent refusé ; ancienne clôture simple refusée ; registre en ajout seul.
- Existant conservé et réutilisé : sous-traitance (0016 : sous-traitants, commandes SC-, envois, réceptions, contrôle qualité, entrée en stock, coûts de prestation, clôture de commande) ; OF et journal (0019) ; gamme et nomenclature figées (0069, 0070) ; coût des lots (0009) ; matelas consommés (0073) ; sortie de produits finis (0073) ; taux horaire (0008) ; droits existants (subcontract.*, production.*, production.approve_log de 0074).
- Identifiants CDC : non renseignés (matrice non modifiée dans cette livraison).
- Ajouts SQL (0075), additifs :
  - Commandes : colonnes `subcontract_orders.production_order_id` et `unit_price` ; fonctions `sc_order_link_production` (commande ouverte, OF non terminé) et `sc_order_set_price` (droit subcontract.costs).
  - Matières externes : table `sc_material_ledger` (ajout seul ; solde jamais négatif ; propriétaire = la société ou un client de la société) ; fonctions `sc_material_send` (matière de la société : sortie de stock standard, coût moyen des lots ; matière du client : registre seul), `sc_material_consume` (consommation ou rebut), `sc_material_return` (matière de la société : entrée en stock au coût moyen ; matière du client : registre seul), `sc_material_summary` (envoyé, consommé, rendu, solde, coût consommé par matière et propriétaire).
  - Réconciliation : table `production_order_variances` (un écart par composant : matière, main-d'œuvre, sous-traitance ; statut ok / en attente / approuvé / refusé) ; fonction privée `production_reconcile_calc` (vérifications, coûts standard et réel avec formules et éléments) ; `production_order_reconcile(OF, seuil)` (écrit l'état des écarts et renvoie l'analyse) ; `production_variance_decide` (droit production.approve_log, auteur de la revue exclu, motif ≥ 10 caractères) ; `production_order_close_industrial(OF, seuil)` (clôture seulement si toutes les vérifications passent et si chaque écart significatif est approuvé pour les montants actuels).
  - Ancienne clôture : `production_order_close` (0019) renvoie désormais CLOSE_USE_INDUSTRIAL. Voir décisions.
  - Audit : `subcontract.link_production`, `subcontract.set_price`, `subcontract.material_send`, `subcontract.material_consume`, `subcontract.material_scrap`, `subcontract.material_return`, `production.reconcile`, `production.variance_approve`, `production.variance_reject`, `production.order_close_industrial`.
- Règles de calcul :
  - Matière standard : Σ(quantité OF × multiplicateur × quantité × conversion × (1 + perte) × prix unitaire de la matière) sur la nomenclature figée, lignes restreintes exclues comme pour les besoins.
  - Matière réelle : Σ(matelas consommés × coût des lots) + Σ(matières de la société consommées chez les sous-traitants de l'OF × coût moyen d'envoi).
  - Main-d'œuvre standard : quantité × temps standard par pièce / 60 × taux horaire de la nomenclature. Réelle : minutes déclarées (productif + retouche, déclarations par opération de P049) / 60 × taux horaire.
  - Sous-traitance standard : Σ(quantité commandée × prix convenu) ; réelle : Σ(coûts de prestation saisis).
  - Écart significatif : |réel − standard| > seuil × standard / 100 ; si le standard est nul, tout réel non nul est significatif. Le seuil est fourni à chaque appel : aucun seuil par défaut.
  - Vérifications de clôture : OF terminé ; nomenclature figée présente ; aucune correction de déclaration en attente ; bons + rebuts + retouches ≤ quantité ; sortie de produits finis = bons du dernier poste ; aucun matelas planifié ; matelas consommés ≥ bons + rebuts ; sous-traitance clôturée et tarifée ; taux horaire présent ; prix matière et conversions présents.
- Fichiers SQL : `supabase/migrations/0075_subcontract_industrial_close.sql` ; `web/tests/sql/subcontract_industrial_close.test.mjs`.
- Fichiers de configuration : `web/tests/sql/rbac.test.mjs` (0075 ajoutée) ; `web/package.json` (`test:sql`, nouveau test). Aucune permission nouvelle, aucun fichier TypeScript modifié dans ce lot.
- Tests réellement exécutés :
  - `subcontract_industrial_close` : 37 PASS, 0 FAIL.
  - Régressions : `rbac` 63 ; `production` 44 ; `subcontracting` 82 ; `cutting_lot_genealogy` 34 ; `operation_declarations_time` 34 ; `capacity_scheduling` 40 : 0 FAIL.
  - Suite SQL complète (`npm run test:sql`) : **3442 PASS, 0 FAIL**, sortie 0.
- Décisions à valider par le propriétaire :
  - **Remplacement d'une capacité existante** : la clôture simple de l'OF (0019) n'est plus acceptée. Elle est remplacée par la clôture après réconciliation, exigée par le brief de ce lot ; le seuil doit être fourni à chaque clôture. Le test `production.test` ne charge que les migrations jusqu'à 0025 : il vérifie toujours l'ancien comportement de 0019 et ne voit pas cette redéfinition. Ce test n'a pas été modifié.
  - Le seuil d'écart n'est pas inventé : il doit être fourni par l'utilisateur. Sans seuil, la réconciliation est refusée.
  - La main-d'œuvre réelle vient des déclarations par opération (P049), pas du journal de production (0019) ; les deux sources ne sont pas synchronisées.
  - Une matière du client n'est ni valorisée ni facturée : elle est suivie en quantité seulement.
  - Le prix standard matière est le prix saisi dans la table des matières (`bom_material_prices`), pas le coût réel du lot.
- Limites :
  - **Pas d'écran** : prix, matières externes, réconciliation, revue et clôture ne sont accessibles que par fonctions SQL. Le brief demande des écrans ; ils ne sont pas livrés. Rien n'a été vérifié dans un navigateur.
  - Pas de facturation, de TVA ni de rapprochement avec les factures fournisseur ou client.
  - Une décision de revue rejetée reste rejetée : il faut corriger les montants et relancer la réconciliation pour rouvrir la revue.
  - La réconciliation ne consulte pas les pièces justificatives (documents GED).
  - Migration non appliquée à la base locale Supabase ni à `erp360_real` ; validée par PGlite seulement.
  - Matrice d'écarts non mise à jour.
- Prochain lot (à décider par le propriétaire) : écrans (commandes sous-traitance, matières externes, réconciliation et revue, clôture) ; décision sur le prix standard matière ; facturation des matières du client ; source unique pour la main-d'œuvre réelle.

### P051 — plans de contrôle et résultats (migration 0076)
- Objectif : plans de contrôle versionnés pour la réception, les opérations en cours et le contrôle final (méthode, échantillon, tolérance, instrument) ; résultats saisis avec unité, valeur brute et preuve d'étalonnage ; décision distincte de la saisie ; contrôle lié au lot matière, au lot produit, à l'OF ou à la réception ; contrôle rejoué sur le plan d'origine.
- Critères d'acceptation : « Plan correct à date, preuve et unité conservées, contrôle rejoué traçable ». Démontrés par `control_plans_results` (40 PASS) : le contrôle ouvert à date prend la version 1 (tolérance 149–151 cm) ; après activation de la version 2, un nouveau contrôle prend la version 2 (148–152) et le rejeu du contrôle initial garde la version 1 ; plan à une date antérieure à sa validité : aucun plan ; unité différente refusée et unité cm conservée ; valeur brute 152 conservée avec l'instrument MET-51 et sa date d'étalonnage ; le rejeu renvoie à l'original ; le lot LOT-T51 retrouve son contrôle initial et son rejeu.
- Existant conservé et réutilisé : contrôles qualité (0020 : `quality_inspections`, défauts immuables, décision, ouverture de non-conformité sur rejet), droits quality.read / write / approve (0020, 0003), lots matière (0009), lots produits (0055), OF (0019), réceptions d'achat (0011). `quality_inspection_open` et `quality_defect_add` restent inchangés pour les contrôles sans plan. `quality_inspection_decide` (0020) est redéfinie : mêmes règles, avec les vérifications supplémentaires des seuls contrôles planifiés.
- Identifiants CDC : non renseignés (matrice non modifiée dans cette livraison).
- Ajouts SQL (0076), additifs :
  - Droit : `quality.plan` (rédaction et activation des plans, gestion des instruments ; admin et qualité).
  - Instruments : table `quality_instruments` (code, nom, date d'étalonnage saisie, actif) ; fonction `quality_instrument_save`.
  - Plans : tables `quality_control_plans` (code, version, titre, étape reception / in_process / final, périmètre matière ou article, statut brouillon / actif / retiré, période de validité) et `quality_plan_characteristics` (mesure avec unité, bornes et instrument ; ou attribut ok/ko ; méthode et taille d'échantillon 1 à 500 ; figée une fois le plan actif).
  - Fonctions : `quality_control_plan_create` (une nouvelle version garde le même périmètre et la même étape), `quality_control_plan_add_characteristic`, `quality_control_plan_activate` (rédacteur ≠ activateur ; la version précédente du code prend fin la veille ; pas de chevauchement avec un autre plan actif du même périmètre et de la même étape), `quality_control_plan_at` (plan en vigueur à une date).
  - Contrôles : colonnes `plan_id`, `plan_version_no`, `replay_of_id`, `material_lot_id`, `finished_lot_id` sur `quality_inspections` ; table `quality_inspection_characteristics` (copie figée des caractéristiques à l'ouverture, avec la version du plan).
  - Résultats : table `quality_measurements` (ajout seul ; un résultat par caractéristique et par échantillon ; unité, valeur brute, hors tolérance calculé, instrument et date d'étalonnage au moment de la mesure, auteur).
  - Fonctions : `quality_inspection_open_planned` (plan actif à la date d'ouverture, lié au lot matière, lot produit, OF ou réception), `quality_measurement_record`, `quality_inspection_replay` (même plan et caractéristiques que l'original ; motif ≥ 10 caractères), `quality_inspection_snapshot` (contrôle complet : plan, caractéristiques, résultats, preuves, décideur), `quality_inspections_for_lot` (recherche par lot matière, lot produit, OF ou réception).
  - Décision (redéfinie) : pour un contrôle planifié, « accepté » exige tous les résultats et aucune valeur hors tolérance ou attribut « ko » ; le décideur ne peut pas être l'un des saisissants (QUALITY_DECIDER_IS_RECORDER).
  - Audit : `quality.instrument_save`, `quality.plan_create`, `quality.plan_activate`, `quality.inspection_open_planned`, `quality.measurement_record`, `quality.inspection_replay`, et `quality.inspection_decide` (avec le marqueur `planned`).
- Fichiers SQL : `supabase/migrations/0076_control_plans_results.sql` ; `web/tests/sql/control_plans_results.test.mjs`.
- Fichiers de configuration et de catalogue : `web/tests/sql/rbac.test.mjs` (0076 ajoutée) ; `web/package.json` (`test:sql`, nouveau test) ; `web/src/lib/rbac/permissions.ts` (constante `QUALITY_PLAN`).
- Tests réellement exécutés :
  - `control_plans_results` : 40 PASS, 0 FAIL. Couvre : plan sans matière refusé ; mesure sans unité, sans instrument, tolérance inversée refusées ; plan sans caractéristique refusé à l'activation ; activation par le rédacteur refusée ; second plan actif sur le même périmètre refusé ; caractéristique ajoutée à un plan actif refusée ; contrôle sans plan refusé ; lot d'une autre matière refusé ; unité différente, valeur absente, échantillon hors plage, mesure en double, résultat d'attribut invalide refusés ; résultats conservés (valeur brute, unité, hors tolérance) ; décision sans droit refusée ; décision par le saisissant refusée ; acceptation incomplète refusée ; acceptation avec valeur hors tolérance refusée ; rejet par habilité avec non-conformité ouverte ; instrument échu refusé à la mesure ; rejeu sans motif refusé et rejeu sur contrôle ouvert refusé ; rejeu sur l'ancien plan ; plan à date ; preuve (unité, valeur, instrument, étalonnage, auteur, décideur) ; traçabilité par lot ; résultat modifié ou inséré directement refusé ; audit.
  - Régressions : `rbac` 63 ; `quality` 46 ; `deliveries_returns` 33 ; `supplier_evaluation` 24 ; `three_way_match` 26 ; `subcontracting` 82 ; `shipping` 43 : 0 FAIL.
  - `npx tsc --noEmit` (web) : sans erreur. `npm run test:unit` (web) : 4 PASS, 0 FAIL.
  - Suite SQL complète (`npm run test:sql`) : **3482 PASS, 0 FAIL**, sortie 0.
- Décisions à valider par le propriétaire :
  - Le rôle direction détient `quality.approve` dans le socle existant (0003) : il peut donc décider des contrôles. Ce n'est pas modifié ici ; la séparation saisie / décision porte sur le saisissant, pas sur le rôle.
  - La décision d'un contrôle planifié ne peut pas être prise par l'un des saisissants : c'est une règle de séparation ajoutée (à confirmer).
  - Les unités ne sont pas converties : une mesure doit être saisie dans l'unité de sa caractéristique (aucune table de conversion n'est inventée).
  - Le plan d'un contrôle est figé à son ouverture ; un rejeu reprend ce plan, même si une version plus récente est active.
- Limites :
  - **Pas d'écran** : plans, instruments, résultats, décisions et rejeux ne sont accessibles que par fonctions SQL. Le brief demande des écrans ; ils ne sont pas livrés. Rien n'a été vérifié dans un navigateur.
  - Pas de pièce jointe de preuve (document GED) sur une mesure : la preuve est l'instrument, sa date d'étalonnage et la valeur brute.
  - Les dates d'étalonnage sont saisies par la société ; aucune source externe n'est interrogée.
  - Les contrôles existants sans plan (0020) restent sans résultats mesurés : aucune migration de données.
  - Le contrôle planifié ne déduit pas automatiquement de défauts : une décision de rejet reste une décision humaine.
  - Migration non appliquée à la base locale Supabase ni à `erp360_real` ; validée par PGlite seulement.
  - Matrice d'écarts non mise à jour.
- Prochain lot (à décider par le propriétaire) : écrans (plans, instruments, saisie des résultats, décision, rejeu, traçabilité) ; pièce de preuve GED par mesure ; décision sur la séparation de la décision et du rôle direction.

### P052 — quarantaine et libération qualité (migration 0077)
- Objectif : statut par lot (quarantaine, bloqué, libéré, rejeté) pour les lots matière et les lots produits ; blocage opérationnel en consommation, picking, prise de lot, écriture directe et affectation à l'expédition ; libération formelle, motivée et auditée ; lot critique libérable seulement par le rôle dédié ; retour physique accepté entré en quarantaine (non vendable sans libération).
- Critères d'acceptation : « Blocage effectif API/UI/mobile, libération auditée, pas de droit implicite ». Démontrés par `quarantine_quality_release` (43 PASS) pour la base et les fonctions RPC. **Écran et mobile non livrés** : le blocage est appliqué en base, donc il vaut pour tout canal qui passe par ces fonctions, mais rien n'a été vérifié dans une interface.
- Existant conservé et réutilisé : quarantaine par emplacement (0009, 0063 : `stock_quality_blocked`, `stock_quality_guard`) ; FIFO de consommation, proposition et prise de picking (0063, 0064) ; lots produits, non-conformité, retours et règlement (0055) ; affectation aux expéditions (0055) ; droit `quality.approve` et délégations (0003, 0033) ; audit (`write_audit`, 9 arguments).
- Identifiants CDC : non renseignés (matrice non modifiée).
- Ajouts SQL (0077), additifs :
  - Droit : `quality.release_critical` (admin et direction, accordé par la migration).
  - Tables : `lot_quality_states` (statut courant par lot ; un lot sans ligne est libéré, régime existant) et `lot_quality_events` (journal en ajout seul ; `LOT_EVENTS_APPEND_ONLY`). Lecture par `quality.read`, écriture directe refusée.
  - Fonctions : `lot_quality_hold` (quarantaine ou blocage, motif ≥ 5 caractères, `quality.write`), `lot_quality_release` (non critique : `quality.approve` ; critique : `quality.release_critical` ; jamais par la personne qui a posé le statut, `LOT_SELF_RELEASE`), `lot_quality_reject` (rejet définitif, `quality.approve`), `lot_quality_status_get` (statut, critique, auteur, historique).
  - Redéfinitions (comportement inchangé sans statut) : `private.stock_quality_blocked` (ajoute les lots bloqués par statut), `private.stock_consume` (exclut les lots bloqués par statut), `private.stock_pick_plan` (exclut), `private.stock_pick_check_lot` et `private.stock_take_lot` (refusent `LOT_BLOCKED`).
  - Garde-fous : trigger `stock_lots_status_guard_bu` (refuse la décrémentation ou le déplacement d'un lot matière bloqué, quel que soit le chemin) ; trigger `shipment_line_lots_status_guard_bi` (refuse l'affectation d'un lot produit bloqué) ; trigger `finished_lots_return_quarantine_ai` (un retour accepté, lot `released`, entre en quarantaine ; un retour `nc` ne reçoit pas de statut supplémentaire).
  - Audit : `lot.hold`, `lot.release`, `lot.reject` (motif, statut précédent et suivant, critique, auteur du blocage).
- Fichiers SQL : `supabase/migrations/0077_lot_quarantine_release.sql` ; `web/tests/sql/quarantine_quality_release.test.mjs`.
- Fichiers de configuration et de catalogue : `web/tests/sql/rbac.test.mjs` (0077 ajoutée) ; `web/package.json` (`test:sql`, nouveau test) ; `web/src/lib/rbac/permissions.ts` (constante `QUALITY_RELEASE_CRITICAL`).
- Corrections trouvées pendant la livraison (avant la fin du lot) : `lot_quality_status_get` lisait `found` après une seconde requête, ce qui rendait `recorded` toujours vrai ; corrigé en capturant le résultat tout de suite. Trois attendus du test étaient faux (calcul de stock, lot déjà libre, ordre des lignes d'expédition) et ont été corrigés ; aucun contrôle n'a été affaibli.
- Tests réellement exécutés :
  - `quarantine_quality_release` : 43 PASS, 0 FAIL. Couvre : motif et droits de blocage ; transitions interdites (libéré par blocage, second blocage, libération d'un lot déjà libéré, nouveau blocage après rejet) ; picking : lot bloqué exclu de la proposition, PICK_SHORT au-delà du libre ; `private.stock_pick_check_lot` et `private.stock_take_lot` refusent `LOT_BLOCKED` ; sortie de 45 m refusée (`STOCK_QUALITY_BLOCKED`, lots inchangés), sortie de 20 m prise sur le lot libre ; décrémentation et déplacement directs refusés ; auto-libération refusée ; libération sans droit ou sans motif refusée ; libération rétablit le disponible ; lot critique : qualité refusée (`RBAC_FORBIDDEN`), magasin refusé, direction libère, droit présent pour admin et direction seulement ; rejet définitif et exclu du picking ; produit fini bloqué refusé à l'affectation (`LOT_BLOCKED`), auto-libération refusée, affectation acceptée après libération ; retour physique entré en quarantaine, affectation refusée, retour `nc` sans statut supplémentaire, libération après contrôle ; RLS (statuts invisibles sans droit) ; journal en ajout seul ; audit (4 blocages, 4 libérations, 1 rejet).
  - Suite SQL complète (`npm run test:sql`) : **3525 PASS, 0 FAIL**, sortie 0 (P051 : 3482 ; +43).
  - `npx tsc --noEmit` (web) : sans erreur. `npm run test:unit` (web) : 222 PASS, 0 FAIL, sortie 0.
- Décisions à valider par le propriétaire :
  - Un lot sans statut enregistré est libéré : aucune donnée antérieure n'est classée automatiquement.
  - Droit `quality.release_critical` accordé à l'administrateur et à la direction (choix de l'ERP, à confirmer). Un lot non critique reste libérable par `quality.approve`.
  - Libérer un lot ne le sort pas physiquement de l'emplacement de quarantaine : le transfert explicite reste nécessaire, comme avant.
  - La personne qui pose un statut ne peut pas le lever (séparation des tâches, critique ou non).
- Limites :
  - **Pas d'écran ni d'écran mobile.** Les actions sont des fonctions SQL (`lot_quality_*`). Rien n'a été vérifié dans un navigateur.
  - Retour physique : à l'acceptation, la quantité retournée entre dans le stock variante (comportement 0055, test `deliveries_returns` attend 123). Ce stock peut donc apparaître dans la disponibilité commerciale tant que le lot est en quarantaine, même si le lot ne peut pas être affecté à une expédition. **Point ouvert** : décider si la quantité du retour doit être exclue de la disponibilité jusqu'à libération (même mécanisme que `stock_block`, 0053).
  - `stock_pick_proposal` liste dans `excluded` les lots en quarantaine d'emplacement et les lots périmés, mais pas les lots bloqués par statut : l'exclusion est effective, l'affichage du motif est incomplet.
  - Pas de pièce jointe ni de motif structuré (défaut, photo) sur un blocage : seul un texte libre est conservé.
  - Migration non appliquée à la base locale Supabase ni à `erp360_real` ; validée par PGlite seulement.
  - Matrice d'écarts non mise à jour.
- Prochain lot (à décider par le propriétaire) : écran de quarantaine (liste, blocage, libération, rejet, historique) pour web et mobile ; décision sur l'exclusion de la quantité retournée de la disponibilité ; motifs structurés de blocage.

### P054 — normes EPI et preuves documentaires (migration 0078)
- Objectif : registre des normes (ISO 9001, EN ISO 20471, EN 343, EN ISO 13688, EN 14058) avec éditions, amendements et marché ; applicabilité par produit confirmée par la qualité ; essais et certificats rattachés au produit, à la version et à l'édition, avec leur document GED ; échéances signalées. Aucun statut « certifié produit » n'est créé : le seul statut produit est « preuve documentaire valide ».
- Critères d'acceptation : « Preuves liées au bon produit/version, expiration signalée, aucune certification inventée ». Démontrés par `norm_standards_evidence` (45 PASS) : preuve d'un autre produit, d'une autre version, d'une autre édition ou d'un autre client refusée ; un essai ne crée aucun statut ; un certificat ne couvre pas une version nouvelle ; certificat expiré et échéance proche signalés ; édition différente signalée ; suspension et retrait tracés.
- Existant conservé et réutilisé : `product_certifications` (0013, texte libre par produit) et `product_documents` restent inchangés ; versions produit (0013, 0068) ; GED et dossier « certifications » par client (0005) ; droits `certifications.read` / `certifications.write` (0003, qualité et commercial en lecture) et `quality.approve` (0003) ; audit (`write_audit`).
- Identifiant de la matrice : QUA-04 (« Registre documentaire ISO 9001, EN ISO 20471, EN 343, EN ISO 13688 », partiel). Matrice non modifiée.
- Ajouts SQL (0078), additifs, sans droit nouveau :
  - Tables : `norm_standards` (société, code, périmètre produit ou organisation, intitulé vide tant que la qualité ne le renseigne pas) ; `norm_editions` (édition, amendement, marché, date de publication, unicité) ; `product_norm_requirements` (applicabilité par produit et par norme, édition optionnelle, motif, confirmée par) ; `norm_tests` (rapport d'essai : laboratoire, numéro, date, résultat pass/fail, édition, version, document) ; `norm_certificates` (numéro, organisme, dates, statut valid/suspended/withdrawn, motif, document ; rattachement produit + version pour un périmètre produit, société seule pour ISO 9001).
  - Registre initial : cinq normes déclarées dans le cahier, sans intitulé ni édition.
  - Garde-fous (triggers, y compris en écriture directe) : périmètre cohérent avec la norme ; version du produit concerné et non obsolète ; édition de la même norme ; document GED de la même société non supprimé et du même client pour un périmètre produit.
  - Fonctions : `norm_standard_add`, `norm_standard_set_title`, `norm_edition_add`, `norm_requirement_confirm` (quality.approve, motif ≥ 5 caractères), `norm_test_record`, `norm_certificate_record`, `norm_certificate_set_status` (motif obligatoire hors retour à valide ; retiré est définitif), `norm_product_status(produit, version, seuil)`, `norm_expiry_alerts(jours)`.
  - Statuts par norme : `a_confirmer`, `non_applicable`, `edition_a_confirmer`, `manquant`, `edition_differente`, `suspendu_ou_retire`, `expire`, `echeance_proche`, `preuve_valide`.
  - Audit : `norm.standard_add`, `norm.standard_update`, `norm.edition_add`, `norm.requirement_confirm`, `norm.test_record`, `norm.certificate_record`, `norm.certificate_status`.
  - Lignes protégées : RLS par société et par `certifications.read` ; aucun DML direct pour les rôles applicatifs.
- Fichiers SQL : `supabase/migrations/0078_norm_standards_evidence.sql` ; `web/tests/sql/norm_standards_evidence.test.mjs`.
- Fichiers de configuration et de catalogue : `web/tests/sql/rbac.test.mjs` (0078 ajoutée) ; `web/package.json` (`test:sql`, nouveau test).
- Corrections trouvées pendant la livraison : un appel d'audit avait un argument en trop (10 au lieu de 9), corrigé ; `norm_product_status` réutilisait `found` après une autre requête, remplacé par des indicateurs explicites. Le test a aussi corrigé trois attendus (édition propre à ISO 9001, nombre de confirmations selon l'ordre du test).
- Tests réellement exécutés :
  - `norm_standards_evidence` : 45 PASS, 0 FAIL, sortie 0.
  - Suite SQL complète (`npm run test:sql`) : **3570 PASS, 0 FAIL**, sortie 0 (P052 : 3525 ; +45).
  - Non relancés dans ce lot : `npx tsc --noEmit` et `npm run test:unit` (aucun fichier TypeScript modifié ; dernier résultat P052 : tsc sans erreur, 222 PASS).
- Décisions à valider par le propriétaire :
  - Libellé « preuve documentaire valide » au lieu de « certifié » : le module ne certifie rien.
  - Classement : ISO 9001 au niveau société ; les quatre autres normes au niveau produit (à confirmer).
  - Couverture stricte par version : une nouvelle version n'hérite pas des certificats de la précédente.
  - Seuil d'alerte d'échéance : 60 jours par défaut (paramètre de lecture, à valider).
  - Les données existantes de `product_certifications` (texte libre) ne sont pas migrées vers le registre : correspondance à décider par le propriétaire.
- Limites :
  - **Pas d'écran** (registre, applicabilité, essais, certificats, alertes) ni d'API dédiée : fonctions SQL seulement. Rien n'a été vérifié dans un navigateur.
  - Le blocage de commande et d'expédition sur certificat expiré (BR-CER-003) n'est pas câblé ; `norm_expiry_alerts` signale, il ne bloque pas.
  - L'authenticité du certificat auprès de l'organisme n'est pas vérifiée ; le document GED n'est pas exigé à l'état « validé ».
  - Le test de la version 2 utilise une fixture de test (passage de la version 1 à « validated » via le drapeau `product.rpc`, réservé aux RPC produit) ; le module produit n'a pas été modifié.
  - Migration validée par PGlite seulement ; non appliquée à la base locale ni à `erp360_real`.
  - Matrice d'écarts non mise à jour.
- Prochain lot (à décider par le propriétaire) : écrans du registre et des preuves ; câblage de BR-CER-003 à la confirmation de commande et à l'expédition ; décision sur la reprise de `product_certifications`.

### P053 — non-conformités et CAPA (migration 0079)
- Objectif : compléter le module NC/CAPA existant (0020) par la cause structurée, le périmètre aval (lots impactés et leur aval), la retouche et le rebut terminal, les coûts de non-qualité, et une clôture conditionnée à la cause racine, au responsable, à l'échéance, aux dispositions et à l'efficacité.
- Critères d'acceptation : « CAPA inefficace non clôturée, lot impacté retrouvé, rebut jamais réintroduit ». Démontrés par `nc_capa_disposition` (51 PASS) : clôture refusée tant qu'une action vérifiée est inefficace et qu'aucune action efficace ultérieure ne la remplace ; lot matière et lot produit impactés retrouvés avec leur statut et leur numéro d'expédition ; rebut : lot rejeté, quantité sortie du stock par mouvement tracé, libération, retouche, nouveau rebut et réception du même code refusés.
- Existant conservé et réutilisé (0020) : `quality_nonconformities` (gravité, confinement, cause racine texte, responsable, échéance, statut), `quality_corrective_actions` (correctives et préventives, vérification d'efficacité), `quality_action_plans`, numérotation NC- / CA-, `quality_nc_open`, `quality_nc_contain`, `quality_ca_*`, `quality_dashboard`. Lots (0009, 0055, 0077) : statuts de lot, libération SOD, rejet terminal. Traçabilité (0073), sortie de variante (0015).
- Identifiants CDC : non renseignés.
- Ajouts SQL (0079), additifs :
  - Colonnes : `cause_category` (matière, méthode, machine, main-d'œuvre, mesure, environnement, conception, fournisseur, autre) et `no_impact_reason` sur `quality_nonconformities`.
  - Droit : `quality.cost` (admin, direction, finance) ; permission absente du rôle qualité.
  - Journaux en ajout seul : `quality_nc_impacts` (lot matière ou produit, quantité ≤ quantité du lot), `quality_nc_dispositions` (retouche ou rebut, une seule par impact ; complétion seule modifiable), `quality_nc_costs` (nature, montant ≥ 0, devise ISO 3 lettres, libellé).
  - Fonctions : `quality_nc_set_cause`, `quality_nc_assign` (responsable de la société, échéance obligatoire), `quality_nc_impact_add`, `quality_nc_scope_declare` (motif si aucun lot), `quality_nc_scope` (lots impactés, statut, disposition, expéditions, OF), `quality_nc_rework` (lot bloqué via 0077), `quality_nc_rework_complete` (libération par une autre personne via 0077), `quality_nc_scrap` (rebut terminal : quality.approve + stock.write pour la matière, variants.stock pour le produit fini), `quality_nc_cost_add`, `quality_nc_costs`, `quality_nc_closure` (règles non satisfaites), `quality_capa_watch` (retards et inefficacités non clôturées).
  - Clôture redéfinie : `quality_nc_close` (même signature que 0020) ; chaque règle non satisfaite lève `NC_CLOSE_<code>`.
  - Rebut : contournement explicite des gardes de stock par un drapeau local à la transaction (`quality.scrap_rpc`), réservé à `private.nc_stock_scrap` ; `private.stock_quality_guard` (0063) et `private.stock_lot_status_guard` (0077) sont redéfinies avec ce seul passage.
  - Garde : `stock_lots_scrap_guard_biu` refuse la réception ou la mise à jour de code d'un lot matière dont le même code (même matière) est rebuté (`NC_SCRAP_REINTRODUCTION`).
- Fichiers SQL : `supabase/migrations/0079_nc_capa_disposition.sql` ; `web/tests/sql/nc_capa_disposition.test.mjs`.
- Fichiers de configuration et de catalogue : `web/tests/sql/rbac.test.mjs` (0079 ajoutée) ; `web/package.json` (`test:sql`, nouveau test) ; `web/src/lib/rbac/permissions.ts` (constante `QUALITY_COST`).
- Corrections trouvées pendant la livraison : `SELECT INTO` sans ligne mettait le statut à NULL (lot sans statut jamais bloqué pour la retouche) — corrigé ; garde de réception vérifiait le code à l'insertion alors que la réception insère sans code puis le met à jour — corrigé ; trigger d'append-only lisait `completed_at` sur les tables sans ce champ — corrigé ; `array || 'code'` mal typé — corrigé.
- Tests réellement exécutés :
  - `nc_capa_disposition` : 51 PASS, 0 FAIL, sortie 0. Couvre : règles de clôture listées et codes distincts ; cause et responsable validés ; impact supérieur au lot refusé ; unicité d'impact ; lot matière et lot produit retrouvés (expédition incluse) ; retouche : blocage, doublon refusé, fin de retouche par la même personne refusée, libération par une autre ; rebut produit fini sans droit de stock refusé, rebut effectué, lot rejeté, double rebut refusé ; rebut matière sans droit refusé, effectué, mouvement tracé, quantité du lot réduite ; libération, retouche, rebut et réception du même code après rebut refusés ; retouche en attente signalée ; action inefficace bloque, surveillance CAPA la signale, clôture refusée, levée par action efficace ultérieure ; coûts : droit distinct, devise et nature validées, totaux par devise, invisibles à la qualité (RLS) ; journaux en ajout seul ; accès direct refusé ; NC invisible sans droit ; audit.
  - Suite SQL complète (`npm run test:sql`) : **3621 PASS, 0 FAIL**, sortie 0 (P054 : 3570 ; +51).
  - `npx tsc --noEmit` (web) : sans erreur. `npm run test:unit` (web) : 222 PASS, 0 FAIL.
- Comportement changé (à noter) : `quality_nc_close` impose désormais cause, cause racine, responsable, échéance, périmètre évalué, dispositions terminées et efficacité. Le test `quality.test.mjs` (existant, charge 0001–0020 seulement) n'est pas concerné ; il fige le comportement d'avant P053 et n'a pas été modifié. Le test P053 couvre la nouvelle clôture.
- Décisions à valider par le propriétaire :
  - Liste des causes (neuf catégories) : choix de l'ERP, à confirmer.
  - Droits de rebut : rebut matière = quality.approve + stock.write ; rebut produit fini = quality.approve + variants.stock. Aucun rôle ne cumule ces droits par défaut : c'est une séparation volontaire.
  - Retouche : le lot est bloqué entier, sans quantité de retouche distincte ; la libération finale est la décision de la qualité, sans contrôle de retouche rattaché.
  - Une action inefficace bloque la clôture jusqu'à une action efficace ultérieure ; aucune règle de réouverture n'est ajoutée.
  - Coûts : aucun coût n'est déduit automatiquement (ni valeur de lot, ni temps) ; ils sont saisis avec leur devise.
- Limites :
  - **Pas d'écran ni d'API dédiée** : fonctions SQL seulement. Rien n'a été vérifié dans un navigateur.
  - Rebut de produit fini : la quantité est sortie du stock produit, mais la quantité restante du lot (`qty_in − qty_out`) n'est pas décrémentée (le statut `nc` est final et interdit la modification de `qty_out`) ; le rebut fait foi par ses dispositions.
  - Un retour physique de pièces rebutées n'est pas refusé par le module retours (0055) : la réintroduction par retour de produit fini n'est pas couverte, seulement celle par réception matière.
  - Le périmètre aval d'un lot matière passe par les OF et les lots produits (chaîne 0073) ; le test ne couvre pas ce chemin complet (seul le lot produit expédié est testé).
  - Migration validée par PGlite seulement ; non appliquée à la base locale ni à `erp360_real`.
  - Matrice d'écarts non mise à jour.
- Prochain lot (à décider par le propriétaire) : écrans NC et CAPA (liste, confinement, périmètre, dispositions, coûts, clôture) ; test du chemin matière → OF → expédition ; garde de retour pour les pièces rebutées.

### P055 — picking, colisage et export (migration 0080)
- Objectif : scan commande, SKU, lot et emplacement pendant le prélèvement ; colis individualisés (poids, dimensions, étiquette, contenu scanné) ; rapprochement colis ↔ lignes ↔ BL ; liste de colisage versionnée avec empreinte ; preuve export explicite ; déclaration douanière dont l'acceptation exige un retour officiel.
- Critères d'acceptation : « Mauvaise taille bloquée, colis rapprochés BL, preuves export explicites ». Démontrés par `picking_packing_export` (57 PASS) : scan d'une autre taille refusé (`SHIP_WRONG_SIZE`) et d'un autre coloris refusé (`SHIP_WRONG_COLOR`), au scan comme au colisage ; scan au-delà du prélevé refusé ; rejeu de clé sans double comptage ; colis rapprochés du BL et fermeture exigeant le rapprochement ligne par ligne ; liste de colisage versionnée, empreinte stable pour un contenu identique, journal figé ; douane « acceptée » seulement après retour officiel (référence, date, document GED) — la contrainte de base refuse l'écriture directe.
- Existant conservé et réutilisé : expéditions, lignes, prélèvement et réservation, BL unique et sortie de stock (0021) ; BL réimprimable et lots affectés (0055) ; facture export `EXP-` (0021) ; facturation depuis expédition (0056) ; scan et idempotence du stock (0067) ; droits `shipments.read` / `shipments.write`.
- Identifiants matrice : LOG-01 (picking par lot et emplacement, scan, colisage, étiquettes — « Étiquettes imprimables » était l'écart) et LOG-03 (« colis non individualisés » était l'écart). Matrice non modifiée.
- Ajouts SQL (0080), additifs :
  - Droit : `shipments.customs` (admin, direction, commercial).
  - Colonnes : `shipment_lines.qty_scanned`, `qty_packed`.
  - Tables : `shipment_packages` (numéro, étiquette unique par société, statut ouvert / fermé, poids brut et net, dimensions) ; `shipment_package_lines` (contenu : ligne, variante, quantité) ; `shipment_scan_events` (journal en ajout seul, idempotence par clé) ; `shipment_documents` (liste de colisage, versions, empreinte SHA-256 du contenu, en ajout seul) ; `customs_declarations` (une par expédition ; `accepted` / `rejected` exigent référence, date, document GED de retour et date de réponse).
  - Scan : `shipment_scan(expédition, nature, code, clé)` — natures `order`, `sku`, `lot`, `location`. Un scan refusé est renvoyé avec son code et journalisé, sans effet sur les quantités.
  - Colisage : `shipment_package_open`, `shipment_package_add` (SKU scanné, quantité ≤ scannée non emballée), `shipment_package_close` (poids brut ≥ net > 0, dimensions > 0, contenu requis), `shipment_package_discard` (colis ouvert vide), `shipment_reconcile`, `shipment_packing_complete` (tous les colis fermés, chaque ligne prélevée = scannée = emballée ; passe l'expédition à « emballée »).
  - `shipment_pack` (0021) est redéfinie : refusée (`SHIPPING_PACKAGES_EXIST`) dès qu'une expédition a des colis ; le comportement sans colis est inchangé.
  - Documents : `shipment_document_generate(expédition, 'packing_list')` (statut emballée, expédiée ou livrée ; au moins un colis).
  - Douane : `customs_declaration_open` (expédition hors du pays de la société), `customs_declaration_submit` (référence ; liste de colisage requise), `customs_declaration_respond` (seule voie vers acceptée ou rejetée).
  - Preuve : `shipment_export_proof` — BL, colis avec leur BL, listes de colisage avec empreinte, facture EXP, statut douanier ; `customs_accepted` n'est vrai qu'après retour officiel.
  - Garde-fous : `ship_package_line_guard` (le contenu d'un colis doit être une ligne de la même expédition, à la même variante) ; `shipment_documents` et `shipment_scan_events` refusent toute modification (`SHIP_APPEND_ONLY`).
  - Audit : `shipping.package_open`, `shipping.package_close`, `shipping.packing_complete`, `shipping.document`, `customs.open`, `customs.submit`, `customs.response`.
- Fichiers SQL : `supabase/migrations/0080_picking_packing_export.sql` ; `web/tests/sql/picking_packing_export.test.mjs`.
- Fichiers de configuration et de catalogue : `web/tests/sql/rbac.test.mjs` (0080 ajoutée) ; `web/package.json` (`test:sql`, nouveau test) ; `web/src/lib/rbac/permissions.ts` (constante `SHIPMENTS_CUSTOMS`).
- Corrections trouvées pendant la livraison : diagnostic taille / coloris dépendant de la ligne tirée au hasard — remplacé par une comparaison couleur puis taille (`private.ship_mismatch_code`) ; étiquette de colis rendue globalement unique alors que les numéros ne le sont que par société — unicité par société ; un colis ouvert oublié bloquait le colisage — ajout de `shipment_package_discard`.
- Tests réellement exécutés :
  - `picking_packing_export` : 57 PASS, 0 FAIL, sortie 0. Couvre : commande, SKU et lot erronés refusés ; emplacement d'un autre entrepôt refusé ; taille et coloris bloqués au scan et au colisage ; dépassement du prélevé refusé ; rejeu de clé ; clé réutilisée pour une autre nature refusée ; expédition non prélevée refusée au scan ; colis : poids, dimensions, contenu vide, colis fermé, dépassement des scannés ; colisage refusé tant qu'un colis est ouvert ou que la ligne n'est pas rapprochée ; rapprochement BL des deux colis ; étiquettes uniques ; liste de colisage (numéro, empreinte, contenu, immuabilité) ; facture EXP ; douane : droit, statut, doublon, référence, réponse non valide, sans document refusée, date future refusée, acceptation écrite directement refusée, acceptation après retour officiel, double soumission refusée ; RLS ; journal de scan figé ; audit.
  - Suite SQL complète (`npm run test:sql`) : **3678 PASS, 0 FAIL**, sortie 0 (P053 : 3621 ; +57).
  - `npx tsc --noEmit` (web) : sans erreur. `npm run test:unit` (web) : 222 PASS, 0 FAIL.
- Décisions à valider par le propriétaire :
  - Régimes douaniers et codes : aucun n'est implémenté (OPEN-03) ; la déclaration est un enregistrement de statut, sans règle de validation des données douanières.
  - La douane n'est pas une condition d'expédition : une expédition peut partir avant l'acceptation douanière. Décision à prendre (BR-EXP et OPEN-03).
  - Documents hors périmètre : EUR.1 et certificat d'origine (BR-EXP-002 [À CONFIRMER]), non générés.
  - Une pièce scannée doit être emballée avant le colisage terminé : c'est le seul contrôle quantitatif du colisage (pas de tolérance).
  - Aucune limite de poids ni de dimension n'est imposée.
- Limites :
  - **Pas d'écran ni d'impression d'étiquettes** : les étiquettes sont des données (`label_code`, contenu), sans rendu PDF ni impression. Rien n'a été vérifié dans un navigateur.
  - Pas de retour arrière sur un contenu de colis (aucune fonction de retrait de pièce) ; un colis fermé est figé.
  - Scan d'emplacement : les lots produits n'ont pas d'emplacement modélisé ; le contrôle vérifie que l'emplacement appartient à l'entrepôt de l'expédition.
  - Le scan ne remplace pas la réservation : une quantité scannée reste une quantité prélevée déjà réservée par `shipment_pick`.
  - Le rapprochement porte sur les quantités ; il ne vérifie pas les numéros de série ni les étiquettes physiques.
  - Expéditions sans colis : le comportement d'avant P055 est conservé (colisage par nombre) ; une expédition avec colis n'a plus cette voie.
  - Migration validée par PGlite seulement ; non appliquée à la base locale ni à `erp360_real`.
- Prochain lot (à décider par le propriétaire) : écrans de picking (scan, colisage, étiquettes) et de documents export ; décision sur la douane comme condition d'expédition ; EUR.1 et origine une fois les règles validées.

### P056 — transporteurs, suivi et livraison (migration 0081)
- Objectif : intégrer des transporteurs confirmés : étiquettes par colis ou par expédition, suivi, événements reçus par webhook signé, anomalies, preuve de livraison ; garantir qu'un événement répété n'a aucun effet supplémentaire et qu'une panne se reprend ; statut « livré » sans règlement automatique de facture ni de litige.
- Critères d'acceptation : « Événement répété unique, panne reprenable, preuve de livraison accessible habilitée ». Démontrés par `carrier_tracking_delivery` (40 PASS) et par les 12 vérifications de `carrier-webhook` (signature et fenêtre de rejeu) : événement répété = doublon sans effet ; même identifiant avec contenu différent = conflit refusé ; même suivi, code et date sous un autre identifiant = doublon ; événement reçu avant son étiquette = en échec, puis appliqué une seule fois au rejeu ; second rejeu sans effet ; preuve refusée pour un événement non livré et pour un document d'un autre client ; preuve lisible seulement avec `shipments.read` et `documents.read` ; facture et réclamation inchangées par la livraison.
- Existant conservé et réutilisé : expéditions, statuts, BL et événements d'expédition (0021) ; livraison confirmée par le client (0055, inchangée) ; colis (0080) ; réclamations (0026) ; factures (0012, 0056) ; GED (0005) ; modèle de webhook marketing idempotent et signé (0051, `/api/webhooks/marketing`), dont le schéma de signature est repris avec horodatage.
- Identifiants matrice : LOG-02 (transporteurs, suivi, preuve — « webhooks transporteurs » était l'écart) et CON-05 (transport : tracking, preuve — « Connecteur » était l'écart). Matrice non modifiée.
- Ajouts SQL (0081), additifs :
  - Droit : `carriers.manage` (admin, direction).
  - Tables : `carriers` (code, nom, actif, confirmation par un administrateur) ; `carrier_labels` (étiquette par expédition ou par colis, suivi unique par transporteur, en ajout seul) ; `carrier_events` (événements reçus : identifiant fournisseur unique par transporteur, unicité de la réalité physique, empreinte SHA-256 du corps, état de traitement) ; `carrier_anomalies` (ouvertes par un événement « exception » ou « returned », résolues avec motif) ; `carrier_proofs` (une preuve de livraison par expédition, document GED du client).
  - Fonctions utilisateur : `carrier_register`, `carrier_confirm`, `carrier_label_issue` (expédition emballée ou expédiée, transporteur confirmé, colis fermé si précisé), `carrier_tracking_get`, `carrier_anomaly_resolve` (motif ≥ 10 caractères), `carrier_proof_attach` (utilisateur habilité, ou serveur), `carrier_proof_get` (`shipments.read` ET `documents.read`).
  - Fonctions serveur seules (service_role) : `carrier_ingest` (réception, anti-doublon, conflit, application tolérante aux pannes), `carrier_events_replay` (rejeu des événements en attente ou en échec, dans l'ordre de survenue).
  - Application (interne) : transit → événement d'expédition « en transit » ; exception / retour → événement et anomalie ouverte ; livré → expédition livrée à la date de l'événement ; aucune modification de facture, avoir ou réclamation.
  - Garde-fous : événements appliqués non modifiables ni supprimables ; étiquettes et preuves en ajout seul ; statut et anomalies changés seulement par fonctions.
  - Audit : `carrier.register`, `carrier.confirm`, `carrier.label_issue`, `carrier.event_applied`, `carrier.anomaly_resolve`, `carrier.proof_attach`.
- Webhook : `web/src/app/api/webhooks/carriers/route.ts` (HMAC-SHA256 sur « horodatage.corps » ; fenêtre ± 300 s ; réponses 200 doublon ou accepté, 202 accepté en échec à rejouer, 409 conflit, 422 transporteur non confirmé, 401 signature ou horodatage, 503 non configuré) ; logique de signature : `web/src/lib/carrier/webhook.ts`.
- Fichiers SQL : `supabase/migrations/0081_carrier_tracking_delivery.sql` ; `web/tests/sql/carrier_tracking_delivery.test.mjs`.
- Fichiers TypeScript et tests : `web/src/lib/carrier/webhook.ts` ; `web/src/app/api/webhooks/carriers/route.ts` ; `web/tests/unit/carrier-webhook.test.mjs` ; `web/src/lib/rbac/permissions.ts` (constante `CARRIERS_MANAGE`) ; `web/tests/sql/rbac.test.mjs` (0081 ajoutée) ; `web/package.json` (`test:sql` et `test:unit`).
- Corrections trouvées pendant la livraison : les événements d'expédition écrits à l'application n'avaient pas de société hors session utilisateur (le helper de 0021 ne la fournit pas) — écriture explicite de la société de l'événement ; un message de rejeu appelé comme utilisateur était refusé — le rejeu est un appel serveur, le test le fait comme le webhook.
- Tests réellement exécutés :
  - `carrier_tracking_delivery` : 40 PASS, 0 FAIL, sortie 0. Couvre : transporteur non confirmé refusé et non journalisé ; confirmation réservée ; étiquette en double, référence trop courte, expédition non emballée, transporteur non confirmé refusés ; transit appliqué ; doublon, conflit, doublon de suivi, code invalide ; événement avant étiquette en échec puis appliqué au rejeu, second rejeu sans effet, un seul transit au journal ; anomalie ouverte, motif insuffisant refusé, résolution, seconde résolution refusée ; livraison appliquée, facture et réclamation inchangées ; preuve refusée pour événement non livré, pour document d'un autre client, seconde preuve refusée ; preuve lisible par un habilité, refusée sans droit, invisible sans droit (RLS) ; journaux figés ; écriture directe et appel webhook par utilisateur refusés ; audit.
  - `carrier-webhook` (unitaire) : 12 PASS, 0 FAIL. Couvre : signature valide ; corps, secret et horodatage altérés refusés ; en-tête absent ou de mauvaise longueur sans exception ; horodatage absent ou non numérique ; rejeu et horodatage futur hors fenêtre ; bornes de la fenêtre ; format de signature.
  - Suite SQL complète (`npm run test:sql`) : **3718 PASS, 0 FAIL**, sortie 0 (P055 : 3678 ; +40).
  - `npx tsc --noEmit` (web) : sans erreur. `npm run test:unit` (web) : 234 PASS, 0 FAIL (222 + 12).
- Décisions à valider par le propriétaire :
  - Transporteurs : la liste exacte des transporteurs confirmés et leurs contrats (OPEN-03 et contrats transporteurs) ne sont pas fournis ; aucun transporteur n'est créé par défaut.
  - Fenêtre de rejeu : 300 secondes (choix de l'ERP, à confirmer).
  - Événement « livré » : le statut passe à livré sans preuve obligatoire ; la preuve est rattachée ensuite. Exiger la preuve avant le statut livré est une décision à prendre.
  - Facture et litige : aucun règlement automatique ; la décision reste humaine, comme demandé.
  - Un seul document de preuve par expédition.
- Limites :
  - **Pas d'écran** (suivi, anomalies, rejeu, preuve) ; pas de connecteur réel : aucun transporteur n'a été contacté, aucune clé ni URL de production n'existe. Le webhook n'a pas été exercé sur HTTP : la route Next n'est pas testable ici ; seule sa logique de signature l'est.
  - Les variables d'environnement `CARRIER_WEBHOOK_SECRET` et `CARRIER_COMPANY_ID` doivent être fournies par l'exploitation ; sans elles, la route répond 503.
  - Le rejeu est un appel serveur ; il n'a pas encore d'écran ni de planification (tâche périodique à définir).
  - Pas de numéros de série, pas de rendu d'étiquette (données seulement) ; l'étiquette transporteur n'est pas générée par l'ERP.
  - Les événements arrivés hors ordre ne sont appliqués qu'en rejeu ; un transit reçu après la livraison reste en échec.
  - Migration validée par PGlite seulement ; non appliquée à la base locale ni à `erp360_real`.
- Prochain lot (à décider par le propriétaire) : écrans de suivi, anomalies, rejeu et preuve ; planification du rejeu ; exigence de preuve avant « livré » si décidée ; configuration des transporteurs confirmés avec leurs secrets.

### P057 — tickets SAV et résolution (migration 0082)
- Objectif : réclamation client / qualité liée à la commande, la facture et les lots ; canal, priorité, responsable, SLA mesurable, preuves, investigation ; base de connaissance, réponse proposée, clôture confirmée ; détection des doublons ; causes répétées liées aux CAPA.
- Critères d'acceptation : « SLA mesurable, détails client protégés, ticket doublon détecté ». Démontrés par `sav_tickets` (61 PASS) : échéances = création + durée de la politique saisie, état de SLA par ticket et rapport par priorité (respecté, manqué, en retard, sans politique) ; coordonnées du demandeur lisibles seulement avec `sav.contact` (fiche, lecture directe RLS) et absentes de l'audit ; doublon suspecté sur commande, facture ou lot partagés, uniquement entre tickets du même client, création suspendue jusqu'au motif ou au rattachement.
- Existant conservé et réutilisé : `client_complaints` (0026, numéros `REC-`, lien commande, gravité, statuts, solution) — un ticket EST une réclamation, marquée `ticket` ; `complaint_open` / `complaint_update` et le cycle des réclamations antérieures sont inchangés (test de non-régression) ; factures (0012, 0056) ; lots produits et affectations (0055, 0021) ; GED (0005) ; NC et CAPA (0020, 0079) ; audit (0035) ; droits `clients.read` / `clients.write`.
- Identifiants matrice : SAV-01 (ticket lié client, commande, facture, lot ; SLA — « SLA et canaux » était l'écart), SAV-02 (qualification, solution, clôture — « retour physique » reste hors périmètre), SAV-03 (base de connaissance, causes récurrentes — « Absent »). Matrice non modifiée.
- Ajouts SQL (0082), additifs :
  - Droits : `sav.write` (admin, direction, commercial, qualité), `sav.contact` (admin, direction, commercial), `sav.kb` (admin, commercial, qualité), `sav.publish` (admin, direction, qualité), `sav.admin` (admin, direction).
  - Colonnes sur `client_complaints` : `invoice_id`, `ticket`, `channel`, `priority`, `owner_id`, `first_response_due`, `resolution_due`, `first_response_at`, `resolved_by`, `cause_category`, `nc_id`, `duplicate_of`, `close_kind`, `close_ref`, `closed_by` ; contraintes : un ticket a canal et priorité, un ticket clos a une nature de clôture, un doublon est clos « doublon ».
  - Tables : `sav_sla_policies` (une durée par priorité, saisie, aucune valeur par défaut) ; `complaint_lots` ; `complaint_requesters` (nom, e-mail, téléphone, lisible avec `sav.contact` seulement) ; `complaint_evidence` (documents GED du client) ; `complaint_investigations` (constat et cause) ; `complaint_responses` ; `sav_kb_articles` (brouillon, publié, retiré ; contenu figé après publication). Tous en ajout seul sauf l'état d'un article.
  - Fonctions : `sla_policy_set`, `ticket_open` (références contrôlées, doublon, SLA, coordonnées séparées), `ticket_assign` (responsable de la société), `ticket_evidence_add`, `ticket_investigate`, `kb_article_save` / `_publish` (publication par une autre personne que l'auteur) / `_retire`, `ticket_propose_response` (propose, n'enregistre ni n'envoie rien), `ticket_respond` (réponse humaine ; première réponse horodatée une fois), `ticket_resolve` (cause et investigation exigées), `ticket_close` (confirmation client avec référence, ou interne par une autre personne que le résolveur avec `quality.approve`), `ticket_link_nc`, `ticket_repeat_causes` (seuil explicite ≥ 2, fenêtre en jours), `ticket_open_capa_for_cause` (ouvre une NC et la lie aux tickets non liés), `ticket_get` (coordonnées masquées sans `sav.contact`), `ticket_sla_report`.
  - Garde : un ticket ne change pas de statut par `complaint_update` ni par écriture directe (`COMPLAINT_USE_TICKET_FLOW`).
  - Audit : `sav.sla_set`, `sav.ticket_open`, `sav.ticket_assign`, `sav.evidence_add`, `sav.investigate`, `sav.kb_*`, `sav.respond`, `sav.resolve`, `sav.close`, `sav.link_nc`, `sav.capa_for_cause` — sans coordonnées du demandeur.
- Fichiers SQL : `supabase/migrations/0082_sav_tickets.sql` ; `web/tests/sql/sav_tickets.test.mjs`.
- Fichiers de configuration et de catalogue : `web/tests/sql/rbac.test.mjs` (0082 ajoutée) ; `web/package.json` (`test:sql`) ; `web/src/lib/rbac/permissions.ts` (cinq constantes `SAV_*`).
- Corrections trouvées pendant la livraison : `found` perdu par un `perform` intermédiaire dans `ticket_open` (politique de SLA présente non détectée) — résultat capturé dans une variable ; la fiche n'exposait pas l'identifiant de facture (une facture brouillon n'a pas de code) — `invoice_id` ajouté.
- Tests réellement exécutés :
  - `sav_tickets` : 61 PASS, 0 FAIL, sortie 0. Couvre : droit SAV, canal et priorité invalides, facture / lot / commande d'un autre client, lot non livré pour la commande ; priorité dérivée de la gravité ; ticket sans politique (aucune échéance supposée) ; politique réservée à l'administration et cohérente ; échéances calculées ; doublon suspecté, jamais exposé à un autre client, confirmation avec motif, rattachement clos « doublon », rattachement invalide refusé ; responsable inconnu refusé, réponse sans responsable refusée ; preuve d'un autre client refusée ; résolution sans investigation refusée ; article brouillon non proposé, publication par l'auteur ou sans droit refusée, proposition sans envoi ; réponse avec article non publié refusée ; première réponse horodatée une fois ; rapport de SLA (manqué, en retard, sans politique, doublon exclu) ; solution trop courte, double résolution, clôture sans confirmation, nature inconnue, clôture par l'ancien chemin et par écriture directe refusées ; clôture par confirmation client ; ticket clos fermé aux réponses ; confirmation interne par le résolveur ou sans droit refusée, acceptée par une autre personne ; réclamation antérieure inchangée ; coordonnées visibles / masquées, RLS, audit sans coordonnées ; seuil invalide, cause répétée détectée, CAPA sans droit refusée puis ouverte et liée, seconde ouverture refusée, doublon exclu du comptage ; journaux et articles publiés figés, insertion directe refusée, article retiré non proposé ; audit.
  - Suite SQL complète (`npm run test:sql`) : **3779 PASS, 0 FAIL**, sortie 0 (P056 : 3718 ; +61).
  - `npx tsc --noEmit` (web) : sans erreur. `npm run test:unit` (web) : 234 PASS, 0 FAIL.
- Décisions à valider par le propriétaire :
  - **Durées de SLA** : aucune n'est fournie ; la table est vide. Tant qu'un administrateur ne les saisit pas, les tickets sont comptés « sans politique ».
  - Priorité par défaut dérivée de la gravité (mineur → normale, majeur → haute, critique → urgente) ; modifiable à l'ouverture.
  - Droits SAV par rôle (voir plus haut) ; en particulier la qualité n'a pas `sav.contact`.
  - Liste des causes : les neuf catégories de P053 (à confirmer).
  - Clôture : la confirmation du client est une référence saisie (e-mail, appel, signature) ; son authenticité n'est pas vérifiée.
  - Seuil et fenêtre des causes répétées : explicites à chaque appel, sans valeur par défaut.
- Limites :
  - **Pas d'écran** (liste, fiche, base de connaissance, rapport) ni d'envoi : la « réponse » est enregistrée par un humain, rien n'est expédié au client. Rien n'a été vérifié dans un navigateur.
  - Horloge de SLA en minutes écoulées : aucun calendrier ouvré ni pause n'est supposé.
  - Doublons : partage de commande, de facture ou de lot seulement ; aucune similarité de texte.
  - Aucun article n'est fourni : la base de connaissance est vide, aucune réponse type n'est inventée.
  - Les coordonnées du demandeur ne sont pas modifiables après ouverture ; le texte libre d'un ticket peut encore contenir des données personnelles.
  - Pas de retour physique ni d'avoir lié au ticket (SAV-02 partiel) : les modules retours et avoirs restent distincts.
  - Pas de portail client ni d'import de messages.
  - Migration validée par PGlite seulement ; non appliquée à la base locale ni à `erp360_real`.
- Prochain lot (à décider par le propriétaire) : écrans SAV (liste, fiche, base de connaissance, rapport de SLA) ; saisie des durées de SLA ; lien ticket ↔ retour ↔ avoir ; contenu initial de la base de connaissance fourni par le métier.

### P058 — retours (RMA), réparation, remplacement, avoir et remboursement (migration 0083)
- Objectif : dossier RMA par retour, lié à la facture de la commande ; décision de compensation (réparation, remplacement, avoir, remboursement) indépendante du retour physique ; exécution après retour contrôlé ; bornes en quantité et en montant ; double compensation refusée ; remboursement approuvé par une personne distincte ; aucune compensation automatique (source humaine imposée).
- Critères d'acceptation : « Retour NC contrôlé, double compensation refusée, lien facture conservé ». Démontrés par `rma_compensations` (40 PASS) : retour NC réglé (rejet qualité, lot non conforme) avant exécution de l'avoir ; décision d'une réparation avant toute réception ; exécution refusée avant contrôle ; deuxième compensation de la même pièce refusée (réparation + avoir + remplacement au-delà de la quantité retournée), y compris après exécution ; remboursement borné au total de l'avoir émis et au solde restant ; facture d'un autre client refusée au rattachement ; lien facture figé (modification refusée) et partagé avec l'avoir.
- Existant conservé et réutilisé : retours clients (0055 : demande, réception, inspection qualité, règlement — inchangés) ; avoirs (0012 : création, émission, bornage par ligne, `CREDIT_OVER_CREDIT`) ; factures (0012, 0056) ; encaissements (0022, inchangés). L'avoir d'une compensation est créé par `credit_note_create`-équivalent dans ce lot (lignes limitées à la quantité décidée) puis émis par `credit_note_issue` existant.
- Identifiants matrice : ADV-05 (retours clients avec contrôle d'état et avoir — « remboursement non implémenté » et « avoir lié au retour à faire manuellement » étaient les écarts). Matrice non modifiée.
- Ajouts SQL (0083), additifs :
  - Droits : `rma.write` (admin, direction, commercial) ; `rma.approve_refund` (admin, direction, finance).
  - Tables : `rma_cases` (numéro RMA-, retour unique, client, facture, statut ouvert / annulé ; lien facture figé, client de la facture contrôlé) ; `rma_compensations` (nature, quantité ou montant, avoir lié, statut décidée / exécutée / annulée, motif, source `human` imposée, clé d'idempotence unique, décideur, approbateur, exécutant ; identité figée, seules les transitions de statut sont permises).
  - Fonctions : `rma_open` (facture de la même commande et du même client), `rma_cancel` (sans compensation exécutée), `rma_compensation_decide` (bornes, idempotence par clé), `rma_compensation_cancel`, `rma_refund_approve` (distincte du décideur), `rma_compensation_execute` (retour réglé ; exécutant distinct du décideur ; avoir créé pour la seule quantité décidée sur les lignes de la variante, puis émis par le module existant ; remboursement approuvé requis), `rma_status_get` (quantités restantes, avoirs, remboursable).
  - Audit : `rma.open`, `rma.cancel`, `rma.compensation_decide`, `rma.compensation_cancel`, `rma.refund_approve`, `rma.compensation_execute`.
- Fichiers SQL : `supabase/migrations/0083_rma_compensations.sql` ; `web/tests/sql/rma_compensations.test.mjs`.
- Fichiers de configuration et de catalogue : `web/tests/sql/rbac.test.mjs` (0083 ajoutée) ; `web/package.json` (`test:sql`) ; `web/src/lib/rbac/permissions.ts` (constantes `RMA_WRITE`, `RMA_APPROVE_REFUND`).
- Corrections trouvées pendant la livraison : un `await` dans une fonction fléchée du test (erreur de syntaxe) ; une décision exécutée par son auteur (séparation des tâches, correctement refusée, test corrigé) ; un attendu d'audit trop haut (les tentatives refusées ne sont pas journalisées).
- Tests réellement exécutés :
  - `rma_compensations` : 40 PASS, 0 FAIL, sortie 0. Couvre : remboursement hors-dossier et facture d'un autre client refusés ; dossier unique, lien facture figé ; décision de réparation avant réception ; exécution avant contrôle refusée ; rejeu de clé, clé réutilisée refusée ; double compensation par quantité refusée (avant et après exécution) ; motif, nature et montant invalides refusés ; retour réglé en non-conformité ; exécution par le décideur refusée ; exécution sans droit de facturation refusée ; réparation exécutée ; avoir émis pour la seule quantité décidée, rattaché à la facture, ligne de facture bornée ; avoir exécuté deux fois refusé ; remboursement au-delà du total de l'avoir refusé ; remboursement non approuvé refusé ; approbation sans droit refusée ; approbation par le décideur refusée ; remboursement approuvé, exécuté, solde remboursé, centime au-delà refusé ; compensation d'origine automatique refusée (contrainte source) ; compensation modifiée ou supprimée refusée ; annulation après exécution refusée ; lien facture commun au dossier et à l'avoir ; RLS ; audit.
  - Suite SQL complète (`npm run test:sql`) : **3819 PASS, 0 FAIL**, sortie 0 (P057 : 3779 ; +40).
  - `npx tsc --noEmit` (web) : sans erreur. `npm run test:unit` (web) : 234 PASS, 0 FAIL.
- Décisions à valider par le propriétaire :
  - Séparation des tâches : décideur commercial, exécution de l'avoir par la finance (`invoices.write`), approbation du remboursement par une autre personne (`rma.approve_refund`).
  - Une compensation peut être décidée avant réception ; son exécution exige un retour réglé. Un retour rejeté par la qualité reste compensable sur ce constat.
  - Bornes : quantité par pièce retournée ; remboursement par solde de l'avoir émis. Aucun plafond de geste commercial n'est fixé.
  - Le remboursement est enregistré dans l'ERP ; le virement reste hors ERP (aucun connecteur bancaire).
  - Aucune compensation automatique : aucune fonction n'accepte une source autre qu'humaine ; un résumé IA ne peut pas en déclencher une.
- Limites :
  - **Pas d'écran** : dossiers, décisions, approbations et remboursements ne sont accessibles que par fonctions SQL. Rien n'a été vérifié dans un navigateur.
  - Réparation et remplacement : seule l'exécution est enregistrée (aucun ordre de fabrication ni expédition de remplacement créé) ; le stock du remplacement n'est pas mouvementé.
  - Avoir : les lignes sont prises sur la variante retournée ; un avoir partiel sur une facture à plusieurs variantes n'est pas proposé.
  - Pas de lien vers un paiement client existant : le remboursement ne vérifie pas le montant réellement encaissé sur la facture.
  - Pas de retour physique automatique : le lot non conforme reste celui de 0055.
  - Migration validée par PGlite seulement ; non appliquée à la base locale ni à `erp360_real`.
- Prochain lot (à décider par le propriétaire) : écrans RMA (dossier, décision, approbation, remboursement) ; remplacement relié à une expédition ; contrôle du montant encaissé avant remboursement.

### P059 — plan comptable, journaux et périodes : pièces manuelles, contrepassation, clôture et réouverture (migration 0084)
- Objectif : compléter le grand livre provisoire de 0031 par la saisie manuelle de pièces (brouillon puis validé), la contrepassation, la protection des périodes closes et la réouverture encadrée par un visa ; ajouter et désactiver des comptes sans jamais les supprimer. Ancien grand livre (écritures automatiques de 0031) inchangé.
- Critères d'acceptation : « Débit = crédit, période close protégée, ancien grand livre intact ». Démontrés par `gl_manual_periods` (62 PASS) : pièce déséquilibrée refusée à la validation et restant en brouillon ; pièce équilibrée validée ; contrôle global « aucune pièce validée déséquilibrée » ; période close refusant pièces manuelles, insertions directes validées ou en brouillon, et écritures automatiques ; empreinte des écritures d'avant migration identique après 0084, après clôture, après contrepassation et après réouverture ; visa par le demandeur refusé, sans droit refusé, exécution sans visa refusée, exécution deux fois refusée ; correction après réouverture puis re-clôture.
- Existant conservé et réutilisé : `gl_accounts`, `gl_journals`, `gl_periods`, `gl_entries`, `gl_entry_lines` et leurs gardes (0031), `private.gl_post`, `private.gl_period`, `gl_close_period`, `gl_trial_balance`, `gl_ledger` — aucun n'est remplacé. Numérotation par `private.next_seq` (même format `JOURNAL-AAAA-NNNNNN`).
- Identifiants CDC : Partie 4, P059 (plan comptable, journaux, périodes, pièces, brouillon / validé / clôturé). Matrice non modifiée.
- Ajouts SQL (0084), additifs :
  - Droit : `finance.visa` (admin, finance) — visa de réouverture, distinct de `finance.write`.
  - Garde : `private.gl_entry_period_guard` — refuse toute insertion dans une période close, et toute validation dans une période close, y compris par écriture directe.
  - Table : `gl_period_reopenings` (demande en attente, visée, exécutée ; une seule demande ouverte par période ; motif obligatoire ; identité figée ; suppression refusée ; RLS par `finance.read`).
  - Fonctions : `gl_period_reopen_request`, `gl_period_reopen_visa` (demandeur ≠ visa), `gl_period_reopen_execute` (après visa seulement), `gl_account_add`, `gl_account_deactivate` (motif obligatoire ; aucune suppression), `gl_manual_entry_create` (brouillon, numéro réservé, au moins deux lignes), `gl_entry_validate` (équilibre, période ouverte, passage en validé), `gl_entry_discard` (brouillon seulement), `gl_entry_reverse` (une seule contrepassation par pièce, journal OD, pièce d'origine intacte), `gl_period_summary` (brouillons, validées, débit et crédit de la période, équilibre).
  - Audit : `gl.entry_create`, `gl.entry_validate`, `gl.entry_discard`, `gl.entry_reverse`, `gl.account_add`, `gl.account_deactivate`, `gl.period_reopen_request`, `gl.period_reopen_visa`, `gl.period_reopen_execute`.
- Fichiers : `supabase/migrations/0084_gl_manual_periods.sql` ; `web/tests/sql/gl_manual_periods.test.mjs` ; `web/tests/sql/rbac.test.mjs` (0084 ajoutée) ; `web/package.json` (`test:sql`) ; `web/src/lib/rbac/permissions.ts` (constante `FINANCE_VISA`).
- Corrections trouvées pendant la livraison : une garde de période d'abord limitée aux pièces validées, étendue à toute insertion (brouillon compris) dans une période close ; un test qui attendait une erreur de lecture alors que la RLS renvoie zéro ligne (attendu corrigé) ; un appel de `gl_ledger` sans utilisateur (refusé à juste titre, test corrigé) ; une faute de guillemets dans un appel SQL du test.
- Tests réellement exécutés :
  - `gl_manual_periods` : 62 PASS, 0 FAIL, sortie 0.
  - `rbac` : contrôles de catalogue et d'escalade PASS (la constante `FINANCE_VISA` est présente).
  - `npx tsc --noEmit` (web) : sans erreur.
  - Suite SQL complète (`npm run test:sql`) : **3881 PASS, 0 FAIL**, sortie 0 (P058 : 3819 ; +62).
- Décisions à valider par le propriétaire :
  - Exercice = année civile (12 périodes mensuelles) ; aucun exercice décalé n'est supposé (à confirmer).
  - Journaux fixes VT, AC, BQ, CA, OD ; les pièces manuelles vont au journal OD (aucun journal de saisie dédié).
  - Réouverture : demandeur finance.write, visa finance.visa d'une autre personne, exécution finance.write ; aucune réouverture sans visa.
  - Contrepassation : une seule par pièce, toujours au journal OD, datée dans une période ouverte ; la contrepassation d'une contrepassation est refusée.
  - Comptes : désactivation seulement (motif ≥ 5 caractères) ; aucune suppression.
- Limites :
  - **Pas d'écran** : brouillons, validation, contrepassation, réouverture et plan comptable ne sont accessibles que par fonctions SQL. Rien n'a été vérifié dans un navigateur.
  - Pas de rapprochement bancaire, pas de lettrage, pas de déclaration fiscale : aucune règle tunisienne n'est codée (à valider par l'expert).
  - Plan comptable provisoire (à valider par l'expert) : les comptes de 0031 restent « à valider ».
  - Un brouillon se numérote dès sa création (le numéro consommé n'est pas rendu à la suppression du brouillon).
  - Migration validée par PGlite seulement ; non appliquée à la base locale ni à `erp360_real`.
- Prochain lot (à décider par le propriétaire) : écrans comptables (plan, saisie de pièces, périodes, réouverture) ; journal de saisie dédié ; rapprochement bancaire ; validation des règles de plan par l'expert.

### P060 — TVA retenues et déclarations (migration 0085)
- Objectif : retenues à la source versionnées par date d'effet et validées à deux ; TVA déductible saisie par taux sur les factures fournisseur ; déclarations mensuelles (brouillon → validée figée → exportée → déposée) ; export interne avec empreinte ; dépôt seulement avec référence d'accusé réelle et unique ; contrôle de cohérence de la déclaration figée contre le calcul actuel.
- Critères d'acceptation : « Jeux fiscaux signés, règle historique conservée, absence de faux dépôt ». Démontrés par `tax_vat_declarations` (70 PASS, 0 FAIL) :
  - *Jeux fiscaux signés* : les taux de TVA de la base sont « à valider » ; le test les valide par une autre personne **uniquement dans la fixture de test** (taux de 0 à 19 % déjà présents dans 0027, aucun taux nouveau). La retenue de test (« Fixture de test (non fiscale) », 2 %) n'a aucune valeur fiscale : elle prouve le mécanisme (création à valider, refus par l'auteur, validation par une autre personne, refus si non validée, refus si absente, fermeture). Aucune retenue réelle n'est saisie dans le dépôt.
  - *Règle historique conservée* : une version de retenue est datée et ne chevauche pas la précédente (chevauchement refusé) ; fermeture refusée si une retenue postdate la date de fin ; une version validée n'est plus modifiable (taux, date d'effet, rétroactivité refusés) ; une retenue garde le taux de la version en vigueur à sa date (mars 2 %, mai 3 %) ; la déclaration de mars déposée reste à 4,00 de retenues après la nouvelle version.
  - *Absence de faux dépôt* : aucun statut « déposée » sans référence et date d'accusé (contrainte de table, même par écriture directe) ; dépôt d'un brouillon ou non exporté refusé ; dépôt par le validateur refusé (SOD) ; référence d'accusé unique par société (un même accusé pour avril est refusé) ; annulation après dépôt refusée ; accusé non modifiable après dépôt ; export direct sans empreinte refusé.
- Existant conservé et réutilisé : `vat_rates` versionnés et validés à deux (0030, 0040, `vat_rate_validate`, `vat_rate_at`) ; `vat_summary` (0027, inchangé) ; factures et avoirs (0012, 0022, 0027) ; devise de base (`finance_settings`, `private.base_currency`) ; audit et RBAC (0003) ; navigation finance (layout).
- Ajouts SQL (0085), additifs :
  - Droits : `tax.validate` (validation des retenues et déclarations, annulation) et `tax.file` (dépôt) ; attribués à admin et finance.
  - Tables : `withholding_rules` (versions datées, statut, validation distincte de l'auteur, sans chevauchement) ; `supplier_invoice_vat_lines` (TVA par taux saisie sur facture fournisseur, TVA recalculée côté serveur, unicité par taux) ; `supplier_invoice_withholdings` (retenues enregistrées, taux figé, annulation avec motif, jamais de suppression) ; `vat_declarations` (une déclaration active par société et mois, statuts, totaux figés, empreinte, accusé unique) ; `vat_declaration_lines` (lignes calculées, modifiables seulement en brouillon).
  - Fonctions : `withholding_rule_create`, `withholding_rule_validate`, `withholding_rule_close`, `supplier_invoice_vat_set`, `supplier_withholding_record`, `supplier_withholding_cancel`, `vat_declaration_prepare`, `vat_declaration_validate`, `vat_declaration_export`, `vat_declaration_file`, `vat_declaration_cancel`, `vat_declaration_drift`. Calcul interne : `private.vat_compute`, `private.withholding_rule_at`, `private.vat_period_locked`.
  - Audit : `tax.withholding_rule_create`, `tax.withholding_rule_validate`, `tax.withholding_rule_reject`, `tax.withholding_rule_close`, `tax.supplier_vat_set`, `tax.withholding_record`, `tax.withholding_cancel`, `tax.vat_declaration_prepare`, `tax.vat_declaration_validate`, `tax.vat_declaration_export`, `tax.vat_declaration_file`, `tax.vat_declaration_cancel`.
- Écrans (nouveaux) : `/finance/tva` (calcul de brouillon, liste par mois, validation, export interne, dépôt avec accusé, annulation, cohérence) ; `/finance/retenues` (versions de règle, validation ou rejet, fermeture, enregistrement et annulation de retenues). Onglets « TVA » et « Retenues » ajoutés à la navigation finance.
- Actions serveur : `web/src/features/finance/tax-actions.ts` (codes d'erreur traduits en français). Composant de formulaire : `web/src/features/finance/components/tax-form.tsx`.
- Fichiers : `supabase/migrations/0085_tax_withholding_vat_declarations.sql` ; `web/tests/sql/tax_vat_declarations.test.mjs` ; `web/src/features/finance/tax-actions.ts` ; `web/src/features/finance/components/tax-form.tsx` ; `web/src/app/(erp)/finance/tva/page.tsx` ; `web/src/app/(erp)/finance/retenues/page.tsx` ; `web/src/app/(erp)/finance/layout.tsx` ; `web/src/lib/rbac/permissions.ts` (`TAX_VALIDATE`, `TAX_FILE`) ; `web/tests/sql/rbac.test.mjs` (0085 ajoutée) ; `web/package.json` (`test:sql`).
- Corrections trouvées pendant la livraison : une fonction SQL référençant une table créée plus tard (passée en plpgsql) ; une fixture avec paramètres non typés (`$6+$7`, corrigé en `::numeric`) ; une retenue d'avril enregistrée sous la version 1 empêchait sa fermeture (comportement correct : le test a été reformulé avec une facture de mai) ; un attendu de test trop faible pour le dépôt direct (la contrainte de table refuse, attendu corrigé).
- Tests réellement exécutés :
  - `tax_vat_declarations` : 70 PASS, 0 FAIL, sortie 0.
  - `rbac` : 63 PASS, 0 FAIL (catalogue TS et SQL cohérents avec `TAX_VALIDATE`, `TAX_FILE`).
  - `npx tsc --noEmit` (web) : sans erreur.
  - `npm run test:unit` (web) : 234 PASS, 0 FAIL.
  - Suite SQL complète (`npm run test:sql`) : **3951 PASS, 0 FAIL**, sortie 0 (P059 : 3881 ; +70).
- Décisions à valider par l'expert-comptable et le propriétaire (aucune valeur n'a été supposée) :
  - Taux et régimes de TVA, et tout taux de retenue, à fournir et valider ; le champ d'application d'une retenue (quelles factures, quelle base) est décidé à chaque enregistrement, pas automatiquement.
  - Format officiel de déclaration de l'administration : non fourni ; l'export est un état interne.
  - Une facture fournisseur est saisie TTC (base + TVA = total) : à confirmer.
  - Retenues : montant séparé de la TVA due (aucune compensation calculée) ; crédit de TVA reporté sur le mois suivant : non modélisé.
  - Séparation des tâches : préparation (finance.write), validation et annulation (tax.validate), dépôt (tax.file) par trois personnes distinctes quand le dispositif le permet.
- Limites :
  - **Aucune transmission à l'administration** : le dépôt est un enregistrement d'un accusé saisi par un humain ; la référence n'est pas vérifiée auprès de l'administration.
  - Une pièce ajoutée après validation n'est pas refusée (la période n'est pas bloquée pour les factures) ; elle est signalée par `vat_declaration_drift` et l'écran « Cohérence ». Une déclaration corrective n'est pas encore gérée : seul l'annulation avant dépôt existe.
  - Taux de TVA par facture : contrôle au niveau de la facture (taux validé dans la base), pas ligne par ligne.
  - Pas de TVA sur les avoirs fournisseurs, pas de TVA à l'importation, pas de régimes spéciaux (exonérations par nature) : hors périmètre tant que l'expert ne les a pas fournis.
  - Écrans : non vérifiés dans un navigateur ; vérification de compilation seulement (tsc).
  - Migration validée par PGlite seulement ; non appliquée à la base locale ni à `erp360_real`.
- Prochain lot (à décider par le propriétaire) : vérification navigateur des écrans TVA et retenues ; saisie de la TVA déductible depuis l'écran fournisseur ; déclaration corrective ; report de crédit de TVA ; paramétrage des régimes validé par l'expert.
