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
