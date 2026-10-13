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
