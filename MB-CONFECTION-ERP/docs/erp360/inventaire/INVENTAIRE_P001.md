# Inventaire réel du dépôt — Lot P001 (WORKMAN ERP 360)

Date : 12 octobre 2026. Périmètre : dossier `MB-CONFECTION-ERP` (web, api, supabase, docs, deploy).
Nature : **lecture seule**. Aucune modification de code, de données, de schéma ou de la production.
Référence : CDC §1.4 (AUD-001 à AUD-003), guide Phase 1, matrice `docs/MATRICE_ECARTS_CDC.md`.

## 0. Méthode et preuves

| Étape | Moyen | Résultat |
|---|---|---|
| Routes web | `find web/src/app -name page.tsx`, `route.ts` | 139 pages, 9 handlers `route.ts` |
| Features et services | parcours de `web/src/features/*` | 27 dossiers de domaine |
| API | `api/routes/api.php`, `api/app` | 1 route de santé, 18 routes protégées |
| Base (catalogue) | requêtes `SELECT` sur `information_schema`, `pg_*` (base locale) | 125 tables, 6 vues, 290 politiques RLS, 204 fonctions `public`, 241 `private`, 200 triggers |
| Droits | table `permissions`, `roles`, `role_permissions` | 79 permissions, 8 rôles, 274 affectations |
| Tâches planifiées | recherche `cron`, `pg_cron`, `cron.job` | **aucune** |
| Tests web SQL | `npm run test:sql` (PGlite, mémoire) | **1 808 contrôles réussis, 0 échec** |
| Tests web unitaires | `npm run test:unit` | **168 contrôles réussis, 0 échec** |
| Tests API | `phpunit` dans l'image `workman-api:dev` (conteneur jetable) | **2 tests, 1 échec** (voir §6) |
| Absence de mutation | `git status` après le lot | aucun fichier source modifié ; seul `docs/erp360/backlog/` (travail P003 suspendu) reste non suivi |

Les comptes de lignes (`pg_stat_user_tables`) sont des estimations du moteur, pas des mesures de volume : ils ne servent qu'à repérer les tables vides ou dominantes.

## 1. Modules recensés (existant, conservé)

Les pages sont dans `web/src/app/(erp)/<module>/`. Les services et actions sont dans `web/src/features/<module>/`.

| Module | Pages | Services/actions (fichiers) | Tables principales (base) | Classement |
|---|---:|---|---|---|
| Clients | 4 | `features/clients/` (services, actions) ; API `ClientController`, `ContactController`, `AddressController`, `DirectoryController` | `clients`, `client_contacts`, `client_addresses`, `payment_terms` | **Conserver** (migré vers l'API, commit `c3823a7`) |
| Commercial (devis, factures, avoirs, pipeline, prospects) | 13 | `features/commercial/` (service, actions) | `quotes`, `quote_lines`, `invoices`, `invoice_lines`, `invoice_payments`, `credit_notes`, `credit_note_lines`, `prospects`, `prospect_activities` | **Corriger** (versionnage des devis, devise/probabilité sur opportunité) ; **étendre** (consentements, dédoublonnage) |
| Commandes (orders) | 3 | `features/orders/` | `sales_orders`, `sales_order_lines` | **Étendre** (reliquats, annulations motivées : ADV-01) |
| Articles | 5 | `features/articles/` | `articles`, `article_versions`, `article_photos` | **Conserver** |
| Produits / variantes | 6 + 3 | `features/products/`, `features/variants/` | `product_master`, `product_variants`, `product_versions`, `product_photos`, `product_documents`, `product_certifications`, `variant_stock`, `variant_stock_moves`, `colors`, `sizes` | **Conserver** ; **étendre** (BAT, collections : BE-01) |
| Nomenclatures (BOM) | 5 | `features/bom/` | `boms`, `bom_versions`, `bom_lines`, `bom_operations`, `bom_materials`, `bom_material_prices`, `bom_version_costs` | **Conserver** ; **étendre** (compétences, substitutions : BE-02) |
| Développement produit | 7 | `features/development/` | `development_projects`, `development_documents`, `development_exchanges`, `prototypes`, `prototype_costs`, `samples`, `industrialization`, `customer_validations` | **Conserver** |
| Achats | 10 | `features/purchases/` | `purchase_requests`, `purchase_request_lines`, `purchase_orders`, `purchase_order_lines`, `purchase_receipts`, `purchase_receipt_lines`, `purchase_returns`, `purchase_return_lines` | **Corriger** (contrôle budgétaire, tolérances, quarantaine : ACH-01, ACH-04) |
| Fournisseurs | 4 | `features/suppliers/` | `suppliers`, `supplier_contacts`, `supplier_documents`, `supplier_invoices`, `supplier_payments`, `supplier_payment_allocations` | **Conserver** ; **étendre** (scorecard ACH-05 absent) |
| Stock et entrepôts | 8 + 2 | `features/stock/`, `features/warehouses/` | `warehouses`, `warehouse_locations`, `stock_locations`, `stock_lots`, `stock_movements`, `stock_movement_allocations`, `stock_movement_costs`, `stock_movement_policies`, `stock_movement_requests`, `stock_reservations`, `stock_thresholds`, `stock_inventories`, `stock_inventory_lines`, `user_warehouses`, `sites` (migration 0032, sans donnée) | **Conserver** (STK-02, STK-07 conformes) ; **corriger** (FEFO, comptage aveugle : STK-03, STK-04) |
| Expédition | 6 | `features/shipping/` | `shipments`, `shipment_lines`, `shipment_events` | **Étendre** (étiquettes, transporteurs : LOG-01, LOG-02) |
| Production (OF, postes) | 4 | `features/production/` | `production_orders`, `production_logs`, `work_centers` | **Conserver** ; **étendre** (capacité finie, généalogie : PRD-02, PRD-04) |
| MRP | 5 | `features/mrp/` | `mrp_params`, `mrp_forecasts`, `mrp_runs`, `mrp_run_materials`, `mrp_run_suggestions`, `mrp_run_pegging`, `mrp_scheduled_receipts` | **Conserver** (PRD-01 conforme, 62 contrôles de test) |
| Sous-traitance | 6 | `features/subcontracting/` | `subcontractors`, `subcontract_orders`, `subcontract_shipments`, `subcontract_receipts`, `subcontract_costs` | **Conserver** (PRD-06 conforme) |
| Qualité | 7 | `features/quality/` | `quality_inspections`, `quality_defects`, `quality_defect_codes`, `quality_nonconformities`, `quality_corrective_actions`, `quality_action_plans`, `product_certifications` | **Conserver** (QUA-01, QUA-02 conformes) ; **corriger** (blocage automatique au picking et à l'expédition : QUA-03) |
| Finance | 9 | `features/finance/` | `gl_accounts`, `gl_journals`, `gl_periods`, `gl_entries`, `gl_entry_lines`, `vat_rates`, `exchange_rates`, `currencies`, `cash_accounts`, `cash_movements`, `finance_settings`, `finance_reminders`, `invoice_payments` | **Conserver** (grand livre, TVA versionnée) ; **corriger** (clôture et réouverture auditée : FIN-03) ; **étendre** (banque, rapprochement : FIN-07 à FIN-09) |
| Copilote, stratégie, centre de commande, exécutif | copilote 1, stratégie 1, centre de commande 1, `dashboard` 2 ; `executive` sans page dédiée (non vérifié) | `features/copilot/`, `features/strategy/`, `features/command-center/`, `features/executive/` | `copilot_conversations`, `copilot_messages` | **Conserver** (règles, sans modèle de langage : IA-01 partiel) |
| Administration (utilisateurs, rôles, permissions, entrepôts, audit) | 8 | `features/admin/`, `features/rbac/` | `profiles`, `roles`, `permissions`, `role_permissions`, `user_roles`, `audit_logs`, `auth_events` | **Conserver** ; **étendre** (délégations, séparation des tâches : SEC-03, MTX « Séparation des tâches ») |
| GED (documents) | 3 | `features/ged/` | `ged_folders`, `ged_documents`, `ged_document_versions`, `ged_comments` | **Conserver** |
| Terrain atelier (field) | 9 | `features/field/` | lecture des OF, contrôles, picking | **Conserver** ; **étendre** (file hors ligne : MOB-01, MOB-02 absents) |
| Authentification | 3 (`(auth)`) + 1 (`(secure)`) | `features/auth/` | `auth.users` (Supabase), `profiles`, `auth_events` | **Étendre** (MFA et SSO absents : SEC-01) |
| Parcours sans module (dans le cahier, absents du dépôt) | — | — | — | **Nouveau** : BAT, paie, RH (hors dossier employé), POS, portails, BI entrepôt, agents IA, connecteurs |

Note de nommage : la route `/strategie` correspond au dossier `features/strategy/` ; les noms du cahier ne sont pas toujours ceux du code. Aucun module n'a été déclaré inexistant à cause d'un nom différent.

## 2. API (Laravel 12, API seule)

| Élément | Emplacement | État |
|---|---|---|
| Routes | `api/routes/api.php` | 1 route publique `/api/v1/health`, 18 routes protégées par le middleware `supabase` (clients, contacts, adresses, conditions de paiement, commerciaux, annuaire) |
| Contrôleurs | `api/app/Http/Controllers/Api/V1/` | 4 contrôleurs (Client, Contact, Address, Directory) |
| Validation | `api/app/Http/Requests/` | 3 FormRequest (Client, Contact, Address) |
| Authentification | `api/app/Auth/SupabaseToken.php`, `api/app/Http/Middleware/AuthenticateSupabase.php` | vérification ES256 (JWKS) et HS256 |
| Contexte RLS | `api/app/Support/Tenant.php` | `set_config` + `set local role authenticated` |
| Erreurs | `api/app/Support/DatabaseError.php` | mapping PostgreSQL vers HTTP |
| Autres modules | — | **absents** : aucune route pour les 26 autres modules |

## 3. Base de données (catalogue, lecture seule)

- 125 tables de base et 6 vues dans `public`. Les vues : `company_directory`, `finance_receipts`, `production_order_metrics`, `quality_defect_history`, `stock_journal`, `stock_overview`.
- RLS activée sur **toutes** les tables `public` (aucune table sans RLS).
- 290 politiques RLS ; 204 fonctions `public` et 241 fonctions `private` ; 200 triggers.
- Extensions : `plpgsql`, `uuid-ossp`, `pgcrypto`, `pg_stat_statements`, `supabase_vault`. **`pg_cron` absent.**
- Buckets de stockage (tous privés) : `client-docs`, `ged`, `supplier-docs`, `article-photos`, `product-photos`.
- Registre des migrations : 33 lignes pour 33 fichiers (`supabase/migrations/0001` à `0033`).
- Données locales (estimations) : `companies` = 1 (MB Confection), `warehouses` = 10, `sites` = 0, `clients` = 6. Les tables les plus volumineuses (estimations) sont `ged_folders` (81), `audit_logs` (60) et les tables techniques d'authentification. Aucune donnée de production n'a été consultée.
- Tables orphelines (sans référence dans le code ni dans les triggers) : **non vérifié** à ce stade, voir §7.

## 4. Droits et interfaces

- Permissions par préfixe : `articles` (3), `audit` (1), `bom` (3), `certifications` (2), `clients` (3), `copilot` (1), `costs` (1), `dashboard` (2), `development` (3), `documents` (4), `finance` (2), `invoices` (2), `mrp` (2), `orders` (3), `payments` (2), `production` (3), `products` (4), `prospects` (2), `purchases` (5), `quality` (3), `quotes` (2), `reports` (1), `roles` (3), `sessions` (1), `shipments` (2), `stock` (5), `subcontract` (4), `suppliers` (3), `users` (2), `variants` (3), `warehouses` (2).
- Rôles : `achat`, `admin`, `commercial`, `direction`, `finance`, `magasin`, `production`, `qualite`.
- Contrôle serveur : les actions serveur appellent `getAuthContext` puis `ctx.permissions.includes(...)` (ex. `web/src/features/clients/actions.ts`) ; la base applique la RLS et `private.has_perm`.
- Intégrations externes : **aucune** intégration réelle (paiement, banque, transporteurs, messagerie, e-commerce) dans le code. Seuls des appels internes : Supabase (auth, base, stockage) et l'API Laravel.
- Exports : `web/src/app/(erp)/admin/audit/export/route.ts` (journal d'audit) ; tableaux exportables via `components/data/data-table.tsx`.

## 5. Constats d'architecture (preuves)

| Constat | Preuve | Gravité |
|---|---|---|
| Le frontend lit et écrit la base directement pour la quasi-totalité des modules | `grep` : **544** appels `.from('…')` et **171** appels `.rpc(` dans `web/src` ; les plus fréquents : `purchases.service.ts` (35), `stock.service.ts` (29), `commercial.service.ts` (27), `bom.service.ts` (26) | **P0** (contraire à ADR-001 et au cahier, §2.5) |
| Seul le module Clients passe par l'API | `grep apiGet|apiWrite` : 25 occurrences, toutes liées aux clients | **P0** (même cause) |
| Aucune tâche planifiée | aucun `pg_cron`, aucun `cron.job`, aucun job Laravel (`api/app/Console` absent) ; les `setInterval` trouvés sont des minuteries d'interface (`use-idle-timeout`, `executive-live`, `field/panels`) | **P0** (relances, recalculs, sauvegardes, réconciliations) |
| Pas de MFA ni de SSO | recherche de mots entiers `mfa|totp|sso|saml|oauth` : aucun résultat dans `web/src` | **P0** (SEC-01) |
| Pas de sélecteur de société | aucune occurrence de bascule de société dans `web/src` ; un seul enregistrement `companies` | **P0** (ORG-002) |
| Pas de PWA | aucun `manifest` ni service worker dans `web/public` | **P1** (MOB, CDC §11) |
| Dépendance inutilisée | `laravel/sanctum` est requis dans `api/composer.json`, sa configuration existe, mais aucun code ne l'utilise | **P2** |

## 6. Tests existants (exécutés pour ce lot)

| Suite | Commande | Résultat | Remarque |
|---|---|---|---|
| Web SQL (PGlite, mémoire) | `npm run test:sql` dans `web/` | **1 808 réussis, 0 échec** | La matrice annonçait 1 769 ; le compte réel est 1 808 — à corriger dans la matrice |
| Web unitaires | `npm run test:unit` | **168 réussis, 0 échec** | |
| Concurrence (stock) | `web/tests/concurrency/reserve-concurrency.sh` | non exécuté dans ce lot (base locale requise) | voir matrice (refus de survente vérifié précédemment) |
| API smoke clients | `api/tests/smoke/clients.sh` | 41/41 (exécuté au lot L2, rôle `workman_api`) | seul test API métier |
| API PHPUnit | `phpunit` (conteneur jetable) | **2 tests, 1 échec** : `Tests\Feature\ExampleTest` attend un 200 sur `/` ; l'API n'a volontairement aucune route web (404) | test du modèle Laravel par défaut, à remplacer (P1) |

Non vérifié : tests de sécurité négative multi-périmètres (web/API/mobile/BI/IA/export), tests de charge (NFR-02), restauration (NFR-04, MIG-01), accessibilité (NFR-08).

## 7. Inconnues et limites de l'inventaire

1. **Production** : aucun accès, aucun état de production inspecté. Tout constat vaut pour la base locale et le dépôt.
2. **Volumes et utilisateurs réels** : inconnus (CDC §12.13). Les comptes de lignes sont des estimations.
3. **Usage réel des écrans** : aucun parcours observé avec les utilisateurs (AUD-002) ; le classement « conserver/corriger » s'appuie sur le code et la matrice, pas sur l'usage.
4. **Propriétaires métier** : non nommés ; à confirmer (CDC §12.1). Aucun responsable n'est déduit du nom.
5. **Tables orphelines** : vérification exhaustive (tables sans référence dans le code ou les triggers) non faite ; reportée à AUD-003.
6. **Autres projets dans le même dépôt git** (`workvoice`, `stid-crm`, `avocat-ries`, `bat-generator`, `chatbot`, `seo-audit-workman`…) : hors périmètre ERP, non inventoriés. Leurs modifications non commitées ne sont pas touchées.
7. **Dossier `deploy/`** : contient des copies de migrations et des bundles SQL/ZIP ; non vérifié s'ils sont à jour par rapport à `supabase/migrations/` (0032 et 0033 ne sont pas reportées).
8. **Tests de rejeu SQL** : exécutés sur PGlite, pas sur un PostgreSQL 15 de référence.

## 8. Écarts classés P0 / P1 / P2

| Priorité | Écart | Référence CDC | Module |
|---|---|---|---|
| **P0** | Frontend qui lit/écrit la base directement (544 `.from`, 171 `.rpc`) | ARC-E, §2.5, ADR-001 | Tous sauf clients |
| **P0** | Aucune tâche planifiée (relances, recalculs, réconciliations, sauvegardes) | NFR-04, MIG-01, AUD-001 | Transverse |
| **P0** | Pas de MFA ni de SSO | SEC-01 | Authentification |
| **P0** | Pas de sélecteur de société active | ORG-002 | Transverse |
| **P0** | Chaîne BAT absente (BAT-01 à BAT-04) | §3.6 | Produits, production |
| **P0** | Données personnelles : conservation et droits absents | §9.4 | Transverse |
| **P0** | Séparation des tâches non généralisée (paiement, ajustement, dérogation) | §9.3, FIN-08 | Finance, achats, stock |
| **P0** | Blocage automatique des lots en quarantaine (picking, expédition) | QUA-03 | Qualité, expédition |
| **P0** | Sauvegarde et restauration non testées | MIG-01, NFR-04 | Infrastructure |
| **P1** | Pas de PWA ni de file hors ligne | MOB-01, MOB-02, §11 | Terrain |
| **P1** | Tests API : seul le test par défaut de Laravel (échec), aucun test métier PHPUnit | §12.9 | API |
| **P1** | Une seule route API métier (clients) sur 27 modules | §2.5, ADR-001 | API |
| **P1** | Contrôle budgétaire d'achat et tolérances de réception absents | ACH-01, ACH-04 | Achats |
| **P2** | Dépendance `laravel/sanctum` inutilisée | hygiène | API |
| **P2** | Compte de tests SQL différent de la matrice (1 808 au lieu de 1 769) | suivi | Documentation |

## 9. Classement synthétique (conserver / corriger / étendre / encapsuler / remplacer)

- **Conserver** : clients, articles, produits et variantes, BOM et développement, MRP, sous-traitance, qualité (contrôles et non-conformités), stock (journal et isolation entrepôt), grand livre, administration des droits, GED, copilote et tableaux de bord.
- **Corriger** : commercial (devis versionnés), achats (budget et tolérances), stock (FEFO, comptage aveugle), qualité (blocage automatique), finance (clôture et réouverture), tests API.
- **Étendre** : commandes (reliquats), expédition (étiquettes, transporteurs), production (capacité finie, généalogie), authentification (MFA, SSO), terrain (hors ligne), sélecteur de société, séparation des tâches.
- **Encapsuler** (progressivement, module par module, vers l'API) : toutes les lectures et écritures directes du frontend.
- **Remplacer exceptionnellement** : **aucun** remplacement de module n'est justifié par ce constat. Le seul changement d'architecture recommandé est l'encapsulation progressive, déjà prévue par l'ADR-001.

## 10. Décisions et passation

- Aucune décision n'a été prise dans ce lot. Les décisions à valider : (1) calendrier d'encapsulation des modules dans l'API ; (2) choix de l'outil de planification (pg_cron, Laravel Scheduler ou autre) ; (3) fournisseur MFA/SSO ; (4) propriétaires métier de chaque module (CDC §12.1).
- Prochain lot proposé : **P002 — Référence de non-régression** (AUD-004) : figer les résultats actuels des suites (1 808 SQL, 168 unitaires, 41 smoke) et définir les jeux anonymisés à partir de copies autorisées, sans toucher à la production.
- Le lot P003 (backlog exécutable) était en cours et reste suspendu ; ses fichiers de travail sont dans `docs/erp360/backlog/` (non suivis, non commités).
