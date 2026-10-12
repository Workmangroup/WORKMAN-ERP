# WORKMAN ERP 360 — Module Authentification

Next.js 15 · TypeScript · Tailwind 4 · Supabase Auth (JWT) · PostgreSQL (RLS)

## Fonctionnalités
| Besoin | Où |
|---|---|
| Connexion (e-mail + mot de passe), verrouillage après 5 échecs / 15 min | `features/auth/actions.ts` → `loginAction` |
| Déconnexion (session courante / tous les appareils / inactivité) | `signOutAction`, `signOutEverywhereAction`, `idleSignOutAction` |
| Mot de passe oublié → e-mail → réinitialisation | `/forgot-password`, `/auth/callback`, `/auth/confirm`, `/reset-password` |
| Changement de mot de passe (+ changement obligatoire) | `/account/security`, `/change-password` |
| Gestion des sessions (lister, révoquer, révoquer les autres) | `/account/security`, RPC `list_my_sessions` / `revoke_session` / `revoke_other_sessions` |
| JWT enrichi (rôles, société, `must_change_password`) | hook SQL `custom_access_token_hook` |
| Middleware Next.js (garde de routes, inactivité, récupération, rôles) | `src/middleware.ts`, `lib/supabase/middleware.ts` |
| Guards serveur | `features/auth/guards.ts` (`requireAuth`, `requireRole`, `requirePermission`) |
| Hooks / guards client | `features/auth` (`useAuth`, `usePermission`, `useHasRole`, `useIdleTimeout`, `PermissionGate`) |
| Journal d'authentification | table `auth_events` (page « Activité récente ») |

## Module RBAC (rôles, permissions, audit)
| Besoin | Où |
|---|---|
| 8 rôles système + rôles personnalisés, catalogue de 49 permissions | `0003_rbac_audit.sql`, `src/lib/rbac/permissions.ts` |
| Gestion des rôles / permissions (éditeur par module, matrice) | `/admin/roles`, `/admin/roles/[id]` |
| Affectation des rôles, activation/désactivation, révocation de sessions | `/admin/users`, `/admin/users/[id]` |
| Contrôle d'accès du menu | `src/lib/rbac/menu.ts` → `SideNav` (filtré par permissions) |
| Contrôle d'accès des routes | middleware (claim JWT `app_permissions`) + `requirePermission()` |
| Contrôle d'accès des actions | `<Can permission=…>`, `useCan()`, RLS et RPC `rbac_*` |
| Audit complet (append-only, triggers + RPC, export CSV) | `/admin/audit`, table `audit_logs` |

Ajouter un module : déclarer ses permissions (SQL + `permissions.ts`), son entrée dans `menu.ts`, puis protéger ses pages avec `requirePermission(P.X_READ)`.

## Module Clients
| Besoin | Où |
|---|---|
| Fiche client (général, devise, pays, paiement, commercial affecté, notes) | `/clients/[id]`, formulaire `/clients/new` et `/clients/[id]/edit` |
| Contacts (principal automatique), adresses (siège, facturation, livraison, par défaut) | onglets Contacts / Adresses |
| Documents (Storage privé, 10 Mo, signature vérifiée, URL signée 60 s, alerte d'expiration) | onglet Documents, bucket `client-docs` |
| Recherche, filtres (statut, pays, devise, commercial, paiement), tri, pagination | `/clients` (cartes sur mobile, tableau sur bureau) |
| Archivage / restauration (`clients.delete`), suppression définitive d'un client archivé | boutons de la fiche, RPC `client_archive/restore/delete` |
| Historique des modifications (avant → après, par champ, contacts/adresses/documents inclus) | onglet Historique (table `audit_logs`, lisible avec `clients.read`) |
| Schéma | `supabase/migrations/0004_clients.sql` : `clients`, `client_contacts`, `client_addresses`, `client_documents`, `payment_terms`, `company_sequences`, vue `company_directory` |

Droits : `clients.read` (voir), `clients.write` (créer/modifier, contacts, adresses, documents), `clients.delete` (archiver, restaurer, supprimer). Le code client (`CLI-0001`) est généré automatiquement et immuable ; un client archivé est en lecture seule.

## Module Fournisseurs
| Besoin | Où |
|---|---|
| Fiche fournisseur (identité, adresse, catégorie, qualification, note) | `/suppliers/[id]`, formulaires `/suppliers/new` et `/suppliers/[id]/edit` |
| Conditions d'achat : devise, paiement, mode de règlement, **délai de livraison**, **Incoterm + lieu**, minimum de commande, acheteur référent | même formulaire (catalogue de paiements partagé avec les clients) |
| Contacts (principal automatique) | onglet Contacts |
| Documents (Storage privé `supplier-docs`, 10 Mo, signature vérifiée, alerte d'expiration) | onglet Documents |
| Historique des commandes + statistiques (total acheté, ponctualité, délai réel vs annoncé, retards, histogramme 12 mois) | onglets Commandes / Statistiques (droit `purchases.read`) |
| Recherche, filtres (statut, catégorie, pays, qualification, acheteur), tri, pagination | `/suppliers` (cartes mobile, tableau bureau) |
| Archivage / restauration / suppression définitive (`suppliers.delete`, uniquement si jamais commandé) | boutons de la fiche, RPC `supplier_archive/restore/delete` |
| Historique des modifications (champ par champ) | onglet Historique (`audit_logs`, lisible avec `suppliers.read`) |
| Schéma | `supabase/migrations/0006_suppliers.sql` : `suppliers`, `supplier_contacts`, `supplier_documents`, `purchase_orders` (en-têtes, enrichie par le futur module Achats) |

## Module Articles client
| Besoin | Où |
|---|---|
| Article par client : **référence client** (ex. `LAF-HV-JKT-2027`) + **référence interne** (ex. `JKT001`, unique, immuable) | `/articles`, `/articles/new`, `/articles/[id]` |
| Fiche : **couleurs** (teinte, Pantone, codes), **tailles**, **normes** (EN ISO 20471…, classe, certificat, validité), **packaging**, **instructions de lavage** | éditeur `/articles/[id]/spec` (JSON validé par zod puis par `article_spec_valid` en base) |
| **Photos** (Storage privé `article-photos`, 8 Mo, 20 max, photo principale, glisser-déposer, agrandissement) | onglet Photos |
| **Version article** : brouillon → validée (`articles.validate`) → obsolète ; la production utilise la dernière version validée ; une version validée est figée | onglet Versions, RPC `article_new_version / article_validate_version / article_discard_draft` |
| **Relation avec la GED** : rattacher des documents existants, déposer directement dans un dossier (lié automatiquement), lien depuis le document | onglet Documents (GED), colonne `ged_documents.article_id` |
| Recherche (références, désignation), filtres client / famille / statut / norme | `/articles` |
| Historique (identité, sections de la fiche modifiées, versions, photos, documents liés) | onglet Historique (`audit_logs`, entity_type `article`) |
| Schéma | `supabase/migrations/0007_articles.sql` |

Droits : `articles.read`, `articles.write` (commercial et production par défaut), `articles.validate` (direction et qualité). Un client possédant des articles ne peut pas être supprimé définitivement.

## Module BOM (nomenclatures produit)
| Besoin | Où |
|---|---|
| **Création** d'une nomenclature (produit fini rattaché à un article client, ou **sous-ensemble** : capuche, doublure…) ; code `BOM-0001` généré | `/bom/new`, `/bom` (recherche, filtres type / état) |
| **Catalogue de composants** (tissu, doublure, zip, bouton / pression, fil, bande réfléchissante, étiquette…) : unité, couleur, fournisseur, **prix** | `/bom/materials`, table `bom_materials` + `bom_material_prices` |
| **Composition** : composants (quantité, perte %), sous-ensembles multi-niveaux (8 niveaux max, boucles refusées), opérations de main-d'œuvre (minutes) | onglet Composition (brouillon uniquement) |
| **Version BOM** : brouillon → validée (`bom.validate`) → obsolète ; une version validée est figée ; le brouillon démarre en copie de la dernière version | onglet Versions, RPC `bom_new_version / bom_validate_version / bom_discard_draft` |
| **Duplication** (version source au choix, article de la copie au choix) | bouton « Dupliquer », RPC `bom_duplicate` |
| **Archivage** / restauration (refus si le BOM sert de sous-ensemble) ; suppression d'un BOM jamais validé | RPC `bom_archive / bom_restore / bom_delete` |
| **Coûts** : matière = Σ qté × (1 + perte) × prix ; main-d'œuvre = minutes / 60 × taux horaire ; frais généraux = % de (matière + MO) ; **coût de revient** = somme. Figé à la validation, comparé aux prix actuels | onglet Coûts, RPC `bom_cost` (fonction SQL `private.bom_calc`) |
| **Vue arbre interactive** : déplier / replier, filtre, besoin par pièce finie, panneau de détail, navigation clavier (flèches, Entrée) ; coûts ramenés à la pièce finie | onglet Arbre (défaut), RPC `bom_tree` |
| Historique (lignes, opérations, versions, paramètres de coût, archivage) | onglet Historique (`audit_logs`, entity_type `bom` / `material`) |
| Schéma | `supabase/migrations/0008_bom.sql` |

Exemple : *Veste HV* = tissu jaune 2,2 m (perte 5 %), zip 60 cm, 6 boutons pression, fil polyester, + capuche (sous-ensemble) + coupe / assemblage / finitions.

Droits : `bom.read` (structure, arbre), `bom.write` (production, achat), `bom.validate` (qualité, direction). **Les montants exigent en plus `costs.read`** : prix des composants, taux horaire, frais généraux et coûts sont dans des tables séparées protégées par RLS ; sans ce droit, l'arbre et la composition s'affichent sans aucun montant. L'achat (`costs.read` + `bom.write`) tient les prix. Un article ne peut avoir qu'une nomenclature active ; monnaie de calcul unique : EUR.

## Module Stock
| Besoin | Où |
|---|---|
| **Entrepôts** (WH-01…) et **emplacements** (allée / rack / réception / expédition / quarantaine), archivage uniquement si vides | `/stock/warehouses`, tables `warehouses`, `stock_locations` |
| **Stocks disponibles / réservés / de sécurité** par composant et entrepôt ; disponible = en stock − réservé ; alerte sous le seuil ; valorisation FIFO (costs.read) | `/stock`, vue `stock_overview` |
| **Entrée** (lot FIFO créé, coût = saisi ou prix du catalogue BOM), **Sortie** (consomme les lots les plus anciens, respecte les réservations), **Transfert** (le lot garde sa date de réception et son coût), **Ajustement** (+/−, motif obligatoire, `stock.adjust`), **Inventaire** (comptage puis validation `stock.adjust` ; écarts = mouvements) | `/stock/movements`, RPC `stock_move`, `stock_inventory_*` |
| **FIFO** : couches `stock_lots` consommées par date de réception ; détail des lots de chaque mouvement | `/stock/lots`, `stock_movement_allocations` |
| **Réservations** (ordre de fabrication, commande) consommables par une sortie, libérables | `/stock/reservations`, RPC `stock_reserve / stock_release` |
| **Stock de sécurité** par composant et entrepôt | bouton « Seuil », RPC `stock_set_safety` |
| **Historique complet** : mouvements immuables (même `service_role` ne peut ni modifier ni supprimer), acteur, date, référence, motif ; entrepôts / emplacements / inventaires / réservations dans `audit_logs` | `/stock/movements`, onglet Historique d'administration |
| Schéma | `supabase/migrations/0009_stock.sql` |

Droits : `stock.read` (voir), `stock.write` (entrées, sorties, transferts, réservations, comptages, entrepôts — magasin), `stock.adjust` (ajustements et validation d'inventaire — direction, séparation des tâches). Les coûts des lots et des mouvements exigent `costs.read`. Les articles stockés sont les composants du catalogue BOM (pas de stock de produits finis à ce stade) ; les lots et les quantités ne s'écrivent que par fonctions SQL.

## Moteur MRP
| Besoin | Où |
|---|---|
| **Sources** : commandes client confirmées (socle minimal `/orders`), prévisions, BOM validées (explosion multi-niveaux, pertes incluses), stock (lots, réservations, stock de sécurité), réceptions planifiées | `/orders`, `/mrp/forecasts`, `/mrp/parameters` |
| **Besoin brut** : demande × composants de la BOM validée, daté (livraison − délai de production) | `mrp_run`, table `mrp_run_pegging` (origine de chaque besoin) |
| **Besoin net** : projection datée du stock (disponible = en stock − réservé, + réceptions, − besoins) ; commande déclenchée dès que le projeté passe sous le stock de sécurité, arrondie au MOQ / multiple | onglet Besoins, `mrp_run_materials` |
| **Stock de sécurité** : somme des seuils par entrepôt (module Stock) ; désactivable dans une simulation | option de la simulation |
| **Simulation MRP** : horizon, délai de production, prévisions oui/non, brouillons oui/non, sécurité oui/non ; résultat figé et comparable | `/mrp/runs`, RPC `mrp_run` |
| **Besoins d'achat / Suggestions d'achat** : par composant, groupées par fournisseur, date de besoin et date limite de commande (besoin − délai), retards signalés, accepter / rejeter, export CSV | onglet Suggestions d'achat, RPC `mrp_suggestion_decide` |
| **Alertes de rupture** : *imminente* (rupture avant la livraison possible d'une commande), *prévue* (commande encore possible), *sous le stock de sécurité* | tableau de bord `/mrp`, onglet Alertes |
| **Dashboard MRP** : KPI, alertes, couverture des plus gros besoins, articles sans BOM validée | `/mrp` |
| Schéma | `supabase/migrations/0010_mrp.sql` |

Délai d'approvisionnement : paramètre du composant, sinon délai du fournisseur, sinon délai par défaut de la simulation. Droits : `mrp.read`, `mrp.write` (production, achat) ; commandes : `orders.read / write / confirm`. Les valeurs estimées exigent `costs.read`. Les suggestions ne créent pas de commande d'achat (module Achats à venir) et les commandes d'achat en cours se déclarent comme réceptions planifiées.

## Module Achats
| Besoin | Où |
|---|---|
| **Demande d'achat** (DA-0001) : brouillon → soumise → **validée / rejetée** (motif obligatoire) ; saisie par la production, le magasin ou l'achat ; ou **créée depuis les suggestions MRP acceptées** | `/purchases/requests`, droit `purchases.request` |
| **Validation** : droit `purchases.approve` (direction) ; **auto-validation interdite** (séparation des tâches) | bouton « Valider / rejeter » |
| **Bon de commande fournisseur** (PO-AAAA-xxxxx) : généré depuis la DA validée (un par fournisseur, prix du catalogue) ou créé directement ; brouillon éditable → envoyé (verrouillé) ; annulation libère la DA | `/purchases/orders`, RPC `purchase_request_to_orders / purchase_order_send / purchase_order_cancel` |
| **Réception** (REC-0001) : quantités par ligne, entrepôt / emplacement, n° de bon de livraison ; **entrée en stock automatique** (lot FIFO au **prix de la commande**) ; commande partielle ou soldée | commande → « Réceptionner », RPC `purchase_receive` |
| **Retour fournisseur** (RET-0001) : motif obligatoire ; **sortie de stock automatique** ; la commande est rouverte pour la quantité retournée | fiche de réception, RPC `purchase_return` |
| **Statistiques** : montants par mois, ponctualité, délai moyen, retards, valeur réceptionnée / retournée, top fournisseurs et composants, entonnoir des demandes | `/purchases`, RPC `purchase_stats` |
| Historique | `audit_logs` (entity_type `purchase`) |
| Schéma | `supabase/migrations/0011_purchases.sql` (étend `purchase_orders` du module Fournisseurs : l'historique et les statistiques fournisseur restent valables) |

Droits : `purchases.read` (commandes, réceptions, statistiques), `purchases.request` (production, magasin, achat), `purchases.write` (achat : commandes), `purchases.approve` (direction), `purchases.receive` (magasin, achat : réceptions et retours). Le statut, le montant et les quantités reçues d'une commande ne s'écrivent que par les fonctions SQL ; réceptions et retours sont immuables.

## Module Commercial

Prospects → Devis → Commande → Facture → Avoir, avec pipeline et dashboard (`/commercial`).

| Élément | Détail |
|---|---|
| Schéma | `supabase/migrations/0012_commercial.sql` (étend `sales_orders` : prix, remises, totaux, lien devis, statut de facturation) |
| Prospects | étapes nouveau → contacté → qualifié → proposition → négociation → gagné/perdu, journal d'activités, conversion en client, pipeline kanban pondéré |
| Devis | client ou prospect, lignes article ou libres, remise, TVA, validité ; envoi, acceptation/refus, duplication, transformation en commande |
| Factures | totale ou partielle depuis une commande confirmée/livrée, ou libre ; numéro `FAC-AAAA-NNNN` attribué à l'émission (sans trou) ; encaissements |
| Avoirs | depuis une facture émise ; numéro `AV-AAAA-NNNN` à l'émission ; réouverture optionnelle des quantités de la commande |
| Droits | `prospects.*`, `quotes.*` ; réutilise `clients.*`, `orders.*`, `invoices.*`, `payments.*` (la finance écrit les factures, le commercial les lit) |

Limites : un seul taux de TVA par document ; pas de module d'expédition ; encaissements minimaux (pas de rapprochement bancaire) ; un avoir ne déclenche pas de remboursement ; pas de génération PDF ; l'expiration d'un devis est calculée à l'affichage.

## Module Product Master Management (PDM textile)

Référentiel technique unique d'un produit (`/products`) : fiche 360°, fiche technique versionnée, photos, nomenclature, patronages, documents GED, certifications, comparaison de versions et timeline.

| Élément | Détail |
|---|---|
| Schéma | `supabase/migrations/0013_pdm.sql` : `product_master`, `product_versions`, `product_photos`, `product_documents`, `product_certifications` (+ bucket Storage privé `product-photos`) |
| Fiche technique | version (JSON validé en base) : matière/tissu/grammage, couleurs, tailles, variantes (SKU couleur × taille), tableau de mesures par taille, entretien, packaging |
| Versions | brouillon unique → validation (`products.validate`) : version figée + instantané des certifications, documents et de l'entête ; la version précédente devient obsolète |
| Comparaison | `product_compare_versions` : écarts par rubrique (ajouté / retiré / modifié), éléments identifiés par nom, SKU ou point de mesure |
| Duplication | nouveau code PRD-xxxx, version 1 = copie de la dernière fiche (SKU re-préfixés) ; photos, documents, certifications et article lié ne sont pas copiés |
| Archivage | lecture seule (`products.archive`), restauration possible ; suppression réservée aux produits jamais validés |
| Liens | article client (→ nomenclature BOM, arbre et coût si `costs.read`), documents GED (patronage, marqueur, gradation, fiche technique, rapport d'essai…), justificatifs de certification |
| Historique | tout est tracé dans `audit_logs` (`entity_type = 'product'`, avant/après) et affiché en timeline |
| Droits | `products.read` / `products.write` / `products.validate` / `products.archive` |

## Module Développement Produit

De la demande client à la production série (`/development`) : tableau de bord, Kanban, projets, validations client et alertes.

| Élément | Détail |
|---|---|
| Schéma | `supabase/migrations/0014_development.sql` : `development_projects`, `prototypes`, `samples`, `customer_validations`, `industrialization` + `prototype_costs`, `development_exchanges`, `development_documents` |
| Workflow | Demande client → Projet → Prototype → Échantillon → BAT → Validation client → Industrialisation → Production série ; on n'avance que d'une étape, sous conditions imposées par la base (prototype approuvé, échantillon approuvé par le client, BAT soumis puis approuvé, industrialisation « prête ») ; tout retour en arrière exige un motif |
| Versions | prototypes, échantillons et BAT numérotés par projet (v1, v2…) ; chaque refus ou demande de modification appelle une nouvelle version |
| Validations client | échantillon ou BAT : soumission (échéance de réponse), relances tracées, décision (approuvé / modifications / refusé + contact + commentaire) |
| Industrialisation | liste de contrôle (8 points), série pilote, délai, nomenclature liée ; « prête » exige 100 % ; lien optionnel vers la fiche produit PDM (version validée exigée pour la série) |
| Coûts de prototype | matière, main-d'œuvre, sous-traitance, transport ; saisie `development.costs`, lecture `development.costs` ou `costs.read` ; jamais dans l'historique ni les listes |
| Échanges | historique des échanges avec le client, saisie seule (ni modification ni suppression), possible après clôture |
| Pièces jointes | documents de la GED du client (dépôt direct ou rattachement) |
| Alertes | validation en retard, échéance proche (3 j), sans réponse depuis 7 j ; projet, prototype et échantillon en retard ; étape bloquée (21 j) |
| Droits | `development.read` / `development.write` / `development.costs` |

## Module Variantes Textile

Déclinaisons taille × couleur des produits (`/variants`) : matrice moderne, stock, prix, codes-barres et nomenclature par variante.

| Élément | Détail |
|---|---|
| Schéma | `supabase/migrations/0015_variants.sql` : `sizes`, `colors`, `product_variants`, `variant_stock` (+ `variant_stock_moves`, journal append-only) |
| Catalogues | tailles (XS → 4XL, 36 → 60) et couleurs de la société, codes utilisés dans les SKU (`PRD-0001-JAU-XL`), activation / désactivation |
| Matrice | 4 vues sur la même grille couleurs × tailles : Stock (disponible, réservé, alertes), Prix (tarification rapide : base + supplément par taille), Codes-barres (validation GTIN en direct), Nomenclature |
| Génération | cases à cocher couleurs × tailles (combinaisons manquantes seulement) ou import des couleurs, tailles et variantes de la fiche technique du PDM |
| Prix | prix HT par variante ; enregistrement groupé en une transaction ; historique avant/après |
| Codes-barres | GTIN 8 / 12 / 13 / 14 avec somme de contrôle, unicité par société ; génération d'EAN-13 internes (préfixe 29) ; aperçu EAN-13 en SVG |
| Nomenclature | une variante utilise la nomenclature de l'article du produit, ou la sienne (copie adaptable, affectable à une variante, une couleur ou toutes) ; coût de revient affiché avec `costs.read` |
| Stock | par entrepôt : entrée, sortie, ajustement (motif obligatoire), inventaire, transfert, réservation, stock de sécurité ; le disponible = stock − réservé ; jamais négatif |
| Droits | `variants.read` / `variants.write` / `variants.stock` |

## Module Sous-traitance

Broderie, sérigraphie, impression, lavage, finition : suivi des envois et des retours, contrôle qualité, entrée en stock, coûts et performance des sous-traitants (`/subcontracting`).

| Élément | Détail |
|---|---|
| Schéma | `supabase/migrations/0016_subcontracting.sql` : `subcontractors`, `subcontract_orders`, `subcontract_shipments` (envois), `subcontract_receipts` (retours), `subcontract_costs` (prestation, transport, autres) |
| Workflow | Production → Envoi sous-traitant → Réception → Contrôle qualité → Stock → Clôture ; annulation possible tant qu'aucun envoi n'est fait |
| Quantités | reçu ≤ envoyé ≤ commandé ; les envois et réceptions ne s'enregistrent que par RPC, les compteurs restent cohérents |
| Contrôle qualité | chaque retour est ventilé en acceptées et rejetées ; seule la part acceptée entre en stock, via le module Variantes (`variant_stock_move`) |
| Clôture | seulement après contrôle de tous les retours et entrée en stock de toutes les pièces acceptées |
| Coûts | prestation (une par commande) et frais de transport rattachables à un envoi ; visibles avec `subcontract.costs` ou `costs.read` |
| Performance | ponctualité, délai moyen (envoi → clôture), retard moyen, taux de rejet, coût total et coût par pièce, par sous-traitant |
| Tableau de bord | commandes en cours, en retard, retours à contrôler, indicateurs, répartition par prestation, historique mensuel, coûts |
| Droits | `subcontract.read` / `subcontract.write` / `subcontract.qc` / `subcontract.costs` |

Limites : pas de bon de transport ni d'étiquette ; le contrôle qualité est une saisie de quantités (ni photos ni plan de contrôle) ; une entrée en stock par variante et par entrepôt ; pas de facturation fournisseur (les coûts sont des saisies de suivi).

## Module Multi-entrepôts

Entrepôts, zones, emplacements, responsables et accès par entrepôt (`/warehouses`). Les entrepôts et emplacements existants (module Stock) sont étendus, pas dupliqués.

| Élément | Détail |
|---|---|
| Schéma | `supabase/migrations/0017_warehouses.sql` : `warehouses` (+ type : tissus, fournitures, produits finis, mixte, autre), `warehouse_locations` (zones), `stock_locations` (emplacements, rattachables à une zone via `zone_id`), `user_warehouses` (accès par entrepôt : lecteur, opérateur, responsable) |
| Accès | un utilisateur ne voit que les entrepôts qui lui sont affectés ; un entrepôt non affecté répond 404 (aucun nom révélé) |
| Garde en base | politiques RESTRICTIVES de lecture sur toutes les tables portant un entrepôt (stock, achats, variantes, sous-traitance, zones, emplacements) : elles s'ajoutent aux politiques existantes, donc toutes les requêtes sont filtrées automatiquement |
| Écriture | déclencheurs : mouvements de stock en opérateur ou responsable de l'entrepôt (y compris par les fonctions) ; emplacements et zones en responsable ; création d'entrepôt réservée à `warehouses.manage` ; modification en responsable de l'entrepôt |
| Responsables | rôle `manager` sur l'entrepôt ; le créateur d'un entrepôt en devient responsable ; un entrepôt garde au moins un responsable (`WAREHOUSE_LAST_MANAGER`) |
| Affectation | `wh_assign_user` / `wh_revoke_user` (le responsable affecte dans ses entrepôts ; l'administrateur partout) ; retrait historisé (ligne inactive, date, auteur) |
| Traçabilité | création, modifications, zones, emplacements, accords et retraits d'accès dans `audit_logs` (entité `warehouse`) |
| Droits | `warehouses.manage` (créer, gérer tous les entrepôts), `warehouses.all` (voir tous les entrepôts, sans écrire) |

Reprise : à l'installation, chaque utilisateur habilité sur le stock reçoit les entrepôts de la société (responsable pour le magasinier, opérateur pour qui écrit, lecteur sinon). Limites : pas de réservation d'emplacement par lot ; les coûts restent gouvernés par `costs.read`.

## Module Mouvements de stock

Mouvements numérotés, journal, historique complet, annulation contrôlée et validation hiérarchique (`/stock/requests`). Les tables `stock_movements` et `stock_reservations` (module Stock) sont étendues, et le moteur de stock (`private.stock_apply`) reste l'unique chemin d'écriture des nouveaux flux.

| Élément | Détail |
|---|---|
| Schéma | `supabase/migrations/0018_stock_movements.sql` : `stock_movements` (+ numéro `MVT-AAAA-000001`, type métier, lien vers la demande, réversion, demandeur, valideur), `stock_reservations` (+ numéro `RES-000001`), `stock_movement_requests` (demandes, numéro `DEM-AAAA-000001`), `stock_movement_policies` (règles de validation) ; vue `stock_journal` |
| Types métier | entrée achat, sortie production, retour production, ajustement, transfert, retour fournisseur, rebut, sous-traitance ; l'annulation est une réversion |
| Numérotation | automatique par société (`company_sequences`) ; les mouvements existants reçoivent leur numéro à la migration |
| Journal | `stock_movements` est immuable (toute modification est refusée) ; `stock_journal` affiche numéro, type métier, référence et valideur |
| Validation | niveau 0 : publication immédiate (sous seuil, règle sans validation) ; niveau 1 : `stock.approve` ; niveau 2 : `stock.approve_high`, par une personne distincte du niveau 1 ; le demandeur ne valide jamais sa propre demande |
| Seuils par défaut | ajustement, rebut, retour fournisseur et annulation exigent une validation ; valeur ≥ 1 000 : niveau 1 ; valeur ≥ 10 000 : niveau 2 (valeur = quantité × coût unitaire renseigné). Modifiables par `stock_policy_set` (niveau 2 requis) |
| Annulation | `stock_cancel_movement` : motif de 5 caractères minimum ; crée une réversion (sens inverse, même entrepôt et emplacement) soumise aux mêmes validations ; un mouvement n'est annulable qu'une fois, ni un inventaire, ni une réversion |
| Refus et retrait | `stock_request_reject` (motif obligatoire) ; `stock_request_cancel` par l'auteur, ou par un validateur de niveau 2 |
| Droits d'entrepôt | règles du module Multi-entrepôts : opérateur pour écrire, lecture limitée aux entrepôts affectés |
| Traçabilité | `audit_logs` : création, validations, refus, retrait de demande, annulation, modification des règles (entités `stock_request`, `stock_movement`, `stock_policy`) |

Limites : les mouvements posés directement par `stock_move` (flux existants des écrans Stock) ne passent pas par la validation hiérarchique ; ils restent réservés à `stock.write` et `stock.adjust`. Une réversion de sortie recrée le lot au coût de la sortie d'origine (coût du catalogue si l'utilisateur n'a pas `costs.read`) ; elle n'annule pas une réservation déjà consommée. La page de traçabilité d'une demande affiche l'action, l'auteur et la date, sans le détail des champs.

## Module Production

Ordres de fabrication, planification, lancement, suivi et clôture (`/production`). Le module ne consomme pas encore le stock : la consommation de matières reste à faire via le module Stock.

| Élément | Détail |
|---|---|
| Schéma | `supabase/migrations/0019_production.sql` : `work_centers` (postes : heures par jour, rendement de référence), `production_orders` (numéro `OF-AAAA-000001`, article, quantité, temps standard, dates, statut), `production_logs` (journal de suivi, immuable) ; vue `production_order_metrics` |
| Statuts | Planifié (`planned`), Lancé (`launched`), En cours (`in_progress`), Suspendu (`suspended`), Terminé (`done`) ; la clôture (`closed_at`) verrouille l'ordre |
| Transitions | créer et replanifier (avant lancement) ; lancer (poste requis) ; saisir le suivi (passe en cours) ; suspendre (motif obligatoire) et reprendre ; terminer (au moins une saisie) ; clôturer (ordre terminé) |
| Garde-fous | saisie refusée hors statut lancé ou en cours, au-delà de la quantité planifiée, datée du futur ou plus de 30 jours avant le début ; journal de suivi immuable |
| Calculs | charge atelier : heures planifiées ouvertes ÷ (heures par jour × rendement du poste) = jours de charge (surcharge au-delà de 20 jours) ; rendement : bonnes ÷ (bonnes + rebut) ; productivité : pièces bonnes par heure travaillée ; retards : ordre ouvert dont la fin prévue est dépassée, ou terminé après sa fin |
| Droits | `production.read` (voir), `production.write` (saisir le suivi, suspendre, terminer), `production.plan` (créer, replanifier, lancer, clôturer, postes) |
| Traçabilité | `audit_logs` : création, replanification, lancement, suspension, reprise, fin, clôture (entité `production_order`) |

Limites : pas de consommation de matières ni de réservation de stock au lancement ; pas de lien automatique avec les commandes clients (le champ existe mais n'est pas alimenté) ; pas de gammes opératoires ni de calendrier de jours non ouvrés (la charge est exprimée en jours d'atelier).

## Module Qualité

Contrôles réception, production et final, défauts, non-conformités, actions correctives, plans d'actions, indicateurs et historique des défauts (`/quality`).

| Élément | Détail |
|---|---|
| Schéma | `supabase/migrations/0020_quality.sql` : `quality_defect_codes` (référentiel), `quality_inspections` (contrôles, numéro `QC-AAAA-000001`), `quality_defects` (défauts constatés, immuables), `quality_nonconformities` (`NC-AAAA-000001`), `quality_action_plans` (`PA-AAAA-000001`), `quality_corrective_actions` (`CA-AAAA-000001`) ; vue `quality_defect_history` |
| Contrôles | réception (matière, bon de livraison), production (ordre de fabrication), final (article ou ordre) ; échantillon, défauts, décision |
| Règles de décision | un défaut critique impose le rejet ; un défaut majeur interdit l'acceptation pleine ; acceptation sous réserve : rebut estimé = nombre de défauts, plafonné à l'échantillon ; rejet : tout l'échantillon est rebuté |
| Non-conformités | un rejet ouvre automatiquement une non-conformité (gravité = pire défaut) ; ouverture manuelle possible ; cycle ouverte → confinée (action immédiate et cause probable) → close |
| Actions | corrective ou préventive, rattachée à une non-conformité et éventuellement à un plan actif ; à faire → en cours → faite → vérifiée (efficace ou non), ou annulée (motif obligatoire) |
| Clôture NC | seulement si la non-conformité est confinée et que toutes ses actions sont vérifiées efficaces ou annulées ; sans action vérifiée, une justification de 10 caractères minimum est exigée |
| Plans | brouillon → actif (requis avant de rattacher une action) → clos (toutes les actions vérifiées ou annulées) |
| Indicateurs | conformité au premier passage par type, défauts par unité, pareto des défauts, non-conformités ouvertes par gravité, actions en retard, efficacité des actions, plans par statut |
| Historique | chaque défaut est conservé avec son contrôle, sa famille et sa gravité ; toute modification est refusée (`QUALITY_IMMUTABLE`) |
| Droits | `quality.read` (voir), `quality.write` (ouvrir, constater, confiner, proposer des actions, référentiel), `quality.approve` (décider, vérifier, clore, annuler une action, clore un plan) |
| Traçabilité | `audit_logs` : ouverture et décision de contrôle, non-conformité, actions, plans (entités `quality_inspection`, `quality_nonconformity`, `quality_corrective_action`, `quality_action_plan`, `quality_defect_code`) |

Limites : un contrôle ne bloque pas encore le lot de stock ni la réception d'achat (le module Stock reste inchangé) ; la quantité rebutée d'une acceptation sous réserve est une estimation (nombre de défauts) ; les défauts ne sont pas rattachés à une unité précise de l'échantillon.

## Module Expédition

Préparation des commandes, picking, colisage, expédition avec bon de livraison, packing list, facture export, suivi du transport et indicateurs logistiques (`/shipments`).

| Élément | Détail |
|---|---|
| Schéma | `supabase/migrations/0021_shipping.sql` : `shipments` (numéro `SHP-AAAA-000001`, commande, entrepôt, incoterm, pays, transport, colis, poids, bon de livraison `BL-AAAA-000001`, facture export `EXP-AAAA-000001`), `shipment_lines` (variante, demandé / prélevé / expédié, prix unitaire figé), `shipment_events` (journal de suivi immuable) |
| Flux | préparer (commande confirmée) → ajouter les lignes → prélever (réservation du stock) → coliser (toutes les lignes prélevées) → expédier (sortie de stock, bon de livraison) → livrer ; annulation possible tant que l'expédition n'est pas expédiée |
| Garde-fous | l'article d'une variante doit figurer dans la commande ; le cumul des lignes ne dépasse pas la quantité commandée pour l'article ; prélèvement limité au stock disponible (en stock − réservé) et à la quantité de la ligne |
| Stock | prélèvement = `variant_stock.qty_reserved` ; expédition = sortie de `qty_on_hand`, journalisée dans `variant_stock_moves` (référence : numéro d'expédition) ; annulation = libération des réservations |
| Documents | bon de livraison (à l'expédition), packing list, facture export (sur expédition expédiée, incoterm et pays de destination requis), présentés en pages imprimables |
| Suivi | évènements de transport (en transit, incident) et livraison, dans un journal immuable ; l'incident non suivi d'une livraison est compté dans les indicateurs |
| Indicateurs | livraisons à temps (date d'expédition ≤ échéance de la commande), taux de remplissage (pièces expédiées ÷ commandées), délai moyen de préparation, expéditions ouvertes en retard, colis, poids moyen, incidents non résolus, factures export et montant |
| Droits | `shipments.read` (voir), `shipments.write` (tout le flux) ; visibilité limitée aux entrepôts affectés |
| Traçabilité | `audit_logs` : création, expédition, facture export, annulation via la base (entité `shipment`) |

Limites : la facture export est un document interne (numéro, total, données d'incoterm) ; elle n'alimente pas le module Commercial. Le remplissage compare des pièces : une commande en plusieurs articles n'est pas pondérée par article. L'expédition ne change pas le statut de la commande : la clôture de commande reste à la charge du module Commercial.

## Module Finance

Encaissements clients, factures et règlements fournisseurs, balances âgées clients et fournisseurs, relances, trésorerie, prévisions et tableau de bord financier (`/finance`).

| Élément | Détail |
|---|---|
| Schéma | `supabase/migrations/0022_finance.sql` : `supplier_invoices` (numéro `FF-AAAA-000001`, référence du fournisseur unique par fournisseur, solde), `supplier_payments` (`RGF-AAAA-000001`), `supplier_payment_allocations` (affectations, immuables), `cash_accounts`, `cash_movements` (immuables), `finance_reminders` ; vues `finance_receipts` (journal des encaissements) |
| Encaissements | `customer_receipt_record` : le montant est affecté aux factures les plus anciennes via `invoice_record_payment` ; surpaiement refusé ; exige `finance.write` et `payments.write` |
| Règlements fournisseurs | `supplier_payment_record` : affectation FIFO aux factures échues, factures en litige exclues, pas d'avance (surpaiement refusé) |
| Litiges | `supplier_invoice_dispute` (motif obligatoire) rend la facture non payable ; `supplier_invoice_resolve` la remet en paiement |
| Balances âgées | `finance_aging_clients` et `finance_aging_suppliers` : à échoir, 1-30, 31-60, 61-90, plus de 90 jours après l'échéance, à une date choisie ; litiges isolés côté fournisseurs |
| Relances | `finance_generate_reminders` : une relance par niveau et par facture échue (niveau 1 : 1-30 j, niveau 2 : 31-60 j, niveau 3 : plus de 60 j), idempotent ; `finance_reminder_mark_sent` confirme l'envoi |
| Trésorerie | `treasury_position` : soldes d'ouverture + encaissements − règlements ± mouvements manuels (immuables) |
| Prévisions | `treasury_forecast` : semaines à partir de la date du jour ; encaissements par échéance (retards dans la première semaine), taux d'encaissement réglable, décaissements hors litiges ; solde projeté |
| Tableau de bord | `finance_dashboard` : trésorerie, créances et échues, DSO (créances ÷ ventes des 90 derniers jours × 90), dettes, dettes à 14 jours, litiges, prévision 4 semaines, relances en attente, principaux clients en retard |
| Droits | `finance.read` (voir), `finance.write` (saisir, affecter, litiges, relances, trésorerie) ; `payments.write` en plus pour les encaissements clients |
| Traçabilité | `audit_logs` : factures et règlements fournisseurs, litiges, encaissements, mouvements, relances (entités `supplier_invoice`, `supplier_payment`, `cash_account`, `finance_reminder`, `company`) |

Limites : les relances ne sont **pas envoyées** par le module : elles restent « à envoyer » jusqu'à ce qu'un utilisateur les marque envoyées, et aucune planification automatique n'est en place (la génération se lance à la demande). La trésorerie est consolidée : les encaissements et règlements ne sont pas rattachés à un compte bancaire. Les factures fournisseurs sont saisies à la main (pas de rapprochement automatique avec les réceptions). La prévision ne tient pas compte des flux non encore saisis.

## Tableau de bord DG

Vue exécutive multi-modules (`/dashboard/dg`, accessible depuis le tableau de bord) : chiffre d'affaires, marge, stocks, production, achats, MRP, finance, qualité, expéditions, avec graphiques interactifs, indicateurs en temps réel et alertes stratégiques.

| Élément | Détail |
|---|---|
| Schéma | `supabase/migrations/0023_executive.sql` : permission `dashboard.executive` (admin, direction) et fonction `executive_dashboard(p_months)` qui assemble les indicateurs |
| Droits | un bloc n'est renvoyé que si l'utilisateur détient aussi le droit de lecture du module (`invoices.read`, `costs.read`, `stock.read`, `production.read`, `purchases.read`, `mrp.read`, `finance.read`, `quality.read`, `shipments.read`) ; sinon le bloc vaut `null` et n'apparaît pas |
| Réutilisation | production, qualité, expéditions et finance reprennent leurs fonctions de tableau de bord existantes (aucun calcul dupliqué) |
| CA et marge | CA mensuel sur la période (factures émises, partiellement réglées ou réglées) ; marge **estimée** = CA − factures fournisseurs du même mois |
| Graphiques | barres du CA (survol, clic pour le détail d'un mois), tableau de marge par mois, courbe de trésorerie prévisionnelle à 13 semaines, jauges (rendement, livraisons à temps, remplissage, efficacité des actions), barres horizontales (charge atelier, défauts, statuts d'expédition) |
| Temps réel | la page interroge la fonction toutes les 30 secondes et à chaque changement de période ; l'horodatage de la dernière mise à jour est affiché. Il ne s'agit pas d'un abonnement en base : un changement est visible au plus 30 secondes après |
| Alertes | calculées par la fonction : trésorerie négative (critique) ; point bas prévisionnel négatif (critique) ; créances échues > 30 % (avertissement) ; litiges fournisseurs (info) ; CA à mi-mois < 60 % du mois précédent (avertissement) ; marge négative du mois (critique) ; ordres en retard et poste surchargé (avertissement) ; non-conformité critique (critique) ; actions correctives en retard (avertissement) ; expéditions en retard (critique) et incidents de transport (avertissement) ; commandes MRP en retard (avertissement) ; aucun produit fini en stock (info) |

Limites : la marge est une estimation (le coût de revient par article n'est pas suivi) ; les seuils d'alerte sont fixes dans la fonction et ne sont pas encore paramétrables ; le temps réel repose sur une interrogation périodique, sans notification push ; les graphiques sont des SVG sans bibliothèque externe (pas de zoom ni d'export).

## WORKMAN ERP 360 Copilot IA

Assistant conversationnel (`/copilot`, « Copilote IA » au menu) : questions en français sur les clients, articles, nomenclatures, achats, stocks, MRP, production, qualité et finance. Interface en fil de conversation, avec historique personnel.

| Élément | Détail |
|---|---|
| Schéma | `supabase/migrations/0024_copilot.sql` : `copilot_conversations` et `copilot_messages` (visibles par leur auteur seul, RLS), permission `copilot.use` (tous les rôles métier), fonctions d'analyse `copilot_client_profit`, `copilot_product_profit`, `copilot_purchase_suggestions`, `copilot_production_suggestions` |
| Moteur | règles, sans modèle de langage : détection d'intention en français (accents ignorés), puis requêtes sur les données de la société. **Aucune réponse n'est générée hors données** : une source sans droit est signalée, pas inventée |
| Questions naturelles | « rentabilité des clients », « que dois-je acheter ? », « que dois-je produire ? », « où en est la trésorerie ? », « état du stock », « défauts qualité », « colis expédiés », « fais une analyse de la situation »… |
| Analyse automatique | synthèse du chiffre d'affaires, du client le plus rentable, et des alertes des modules accessibles, triées par gravité |
| Prévisions | tendance linéaire sur 12 mois du chiffre d'affaires, projection sur 3 mois, et prévision de trésorerie à 13 semaines (si droit finance) |
| Alertes intelligentes | regroupe les alertes de finance, production, qualité, expéditions, achats et MRP, avec lien vers l'écran concerné |
| Suggestions d'achat | besoins MRP non commandés (critiques si la date de commande est dépassée) et composants sous leur seuil de sécurité |
| Suggestions de production | demande client confirmée non couverte par les ordres planifiés ni par le stock de produits finis |
| Rentabilité client | CA TTC, avoirs, encours, retards, marge estimée et couverture des coûts |
| Rentabilité produit | quantité, CA HT, coût unitaire standard BOM, marge estimée et couverture des coûts |
| Historique | liste des conversations (la plus récente en premier), réouverture, suppression |
| Droits | chaque analyse respecte le droit de son module (ex. marge seulement avec `costs.read`) |

Limites : ce n'est **pas** un modèle de langage : le copilote comprend des formulations couvertes par ses règles (une question hors de ces règles reçoit l'aide). Les marges sont estimées à partir du coût standard des nomenclatures validées et figées ; un article sans coût figé n'est pas valorisé. Les prévisions sont des tendances simples, sans saisonnalité. La liste des suggestions de production ne tient pas compte des capacités des postes.

## Tableaux de données

Composant unique `DataTable` (`src/components/data/data-table.tsx`), appliqué à la liste des ordres de fabrication (`/production/ordres`). Cellules : statut couleur, avatar, progression, alerte (`src/components/data/cells.tsx`).

| Fonction | Détail |
|---|---|
| Recherche instantanée | sans accents ni casse, plusieurs mots, touche « / » |
| Filtres avancés | cases à cocher par colonne, jetons de filtres actifs |
| Tri | par colonne, nombres et dates comparés comme tels, valeurs vides en fin |
| Colonnes | affichage personnalisable ; la colonne identifiant reste fixe |
| Export | Excel (XML 2003, ouvrable dans Excel), CSV « ; », PDF par impression (« Enregistrer en PDF ») ; exporte les lignes filtrées et triées |
| Vues | recherche, filtres, tri, colonnes et taille de page enregistrés dans le navigateur de l’utilisateur |
| Pagination | fenêtre autour de la page courante, taille 10 à 100 |
| Actions rapides | menu par ligne (ouvrir la fiche, actions propres à la liste) |

Limites : les vues sont locales au navigateur (pas partagées entre utilisateurs) ; l’export Excel est au format XML 2003, sans mise en forme avancée ; le tri et le filtre portent sur les lignes chargées (limite de 200 lignes côté serveur) ; les autres listes n’utilisent pas encore ce composant.

## Fiche client 360°

Une seule page par client (`/clients/[id]`), navigation par onglets : informations générales (avec adresses), contacts, commandes, factures, documents GED, articles client, nomenclatures, réclamations, historique, performance commerciale, marge, activité récente.

| Élément | Détail |
|---|---|
| Schéma | `supabase/migrations/0026_client_complaints.sql` : `client_complaints` (numéro `REC-AAAA-000001`, objet, gravité, statut ouverte → en cours → résolue → close, solution obligatoire pour résoudre) |
| Droits | `clients.read` pour voir, `clients.write` pour ouvrir et traiter les réclamations ; chaque onglet respecte le droit de son module (commandes, factures, GED, articles, coûts pour la marge) |
| Chargement | seules les données de l’onglet affiché sont lues |
| Marge | même calcul que le copilote (coût standard BOM figé) ; la couverture des coûts est affichée quand elle est partielle |
| Performance | facturation et commandes sur 12 mois, panier moyen, taux de transformation des devis |

Limites : les nomenclatures sont celles des articles du client, sans détail des lignes ; la performance ne compare pas au client moyen ; l’activité récente combine les commandes, factures, réclamations et la traçabilité (vingt-cinq évènements au plus).

## Recommandations stratégiques (Strategic Recommendation Engine)

Page `/strategie`, réservée à la direction (`dashboard.executive`). Le moteur analyse les données de la société et produit des recommandations complètes : titre, description, cause détectée, impact estimé, priorité (critique, élevé, moyen, faible), action recommandée, responsable, date limite et indicateur de suivi.

| Élément | Détail |
|---|---|
| Moteur | `src/lib/strategy/engine.ts` : fonctions pures, sans accès base. Seuils regroupés dans `THRESHOLDS` |
| Collecte | `src/features/strategy/services/strategy.service.ts` : lit les tables et fonctions existantes avec les droits de l’utilisateur ; une source sans droit est omise et signalée sur la page |
| Affichage | `src/features/strategy/components/strategy-board.tsx` : synthèse, filtre par domaine, cartes par priorité, périmètre de l’analyse |
| Commercial | client en perte d’activité (baisse ≥ 15 % sur 3 mois), client dormant (≥ 180 jours sans commande), client à fort potentiel, cross-selling (famille achetée par ≥ 40 % des clients), upselling (volume en hausse, panier sous la médiane), produit à forte croissance, produit à faible marge (< 15 %), produit à faible performance, prévision de baisse ou de hausse du CA |
| Finance | encours client en retard (≥ 5 000 €), dettes fournisseur échues |
| Achats et production | besoins MRP non couverts, seuils de sécurité, commandes fournisseur en retard, OF en retard, demande non couverte |
| Qualité, GED, expédition | non-conformités ouvertes, certificats expirés ou qui expirent sous 30 jours, expéditions bloquées depuis 7 jours |

Priorité d’un impact chiffré : critique à partir de 50 000 €, élevé à partir de 10 000 €, moyen à partir de 2 000 €, faible en dessous. Échéance : 7 jours (critique), 14 (élevé), 30 (moyen), 60 (faible), à partir de la date d’analyse.

Règles de calcul : la perte d’activité vaut le CA annuel du client multiplié par la baisse en pourcentage. Les impacts marqués « hypothèse » (fort potentiel +10 %, cross-selling 25 %, upselling +10 %) sont des estimations : le libellé indique le calcul. Un impact sans montant (rupture, retard, non-conformité) est affiché sans chiffre inventé.

Limites : aucun schéma ni aucune table ajoutés, donc pas de suivi du statut des recommandations (acquittées, traitées) : chaque affichage recalcule tout. Les RH ne sont pas analysées (aucune table RH dans le modèle ERP). Les entrepôts ne sont couverts qu’à travers les seuils de stock et le MRP. Les prévisions reposent sur une tendance linéaire sur 12 mois, sans saisonnalité ni portefeuille de commandes.

## Command Center (page d’accueil)

Page `/command-center`, page d’accueil par défaut de tous les utilisateurs (`ROUTES.home`). Chaque bloc n’apparaît que si les droits le permettent, donc le contenu suit le rôle : direction, commercial, achat, production, magasin, qualité, finance.

| Bloc | Source | Droit |
|---|---|---|
| Briefing IA | texte généré à partir des chiffres des autres blocs (pas de modèle de langage) | `copilot.use` |
| Mes tâches | actions correctives assignées (`quality_corrective_actions`) | `quality.read` |
| Mes validations | demandes d’achat, bons de commande, mouvements de stock, nomenclatures, documents GED, ordres de fabrication en attente | approbations correspondantes |
| Mes alertes | recommandations du moteur stratégique (hors priorité faible) : rouge critique, orange élevé, bleu information | données de chaque domaine |
| Mes commandes | devis à relancer, commandes ouvertes, bons de commande, réceptions sous 7 jours, commandes à risque (direction) | `quotes.read`, `purchases.read`, `orders.read` |
| Mes OF | à lancer, en cours, bloqués, en retard, terminés (30 jours), avancement par quantités bonnes | `production.read` |
| Stocks critiques | besoins MRP et seuils de sécurité, avec bouton « Générer demande achat » | `purchases.read` |
| Mon agenda | réceptions fournisseurs, jalons OF, livraisons clients ; vues jour, semaine, mois | selon les blocs |
| Mes KPI | CA, marge, transformation des devis, achats, rendement, mouvements, trésorerie… | un droit par indicateur |
| Actions rapides | nouveau devis, commande, article, demande achat, fournisseur ; étoile pour les favoris | droit de création |

Personnalisation : glisser-déposer ou flèches pour réordonner, bouton pour masquer, « Réinitialiser ». La disposition et les favoris sont enregistrés dans le navigateur (`localStorage`), pas sur le compte : ils ne suivent pas l’utilisateur d’un poste à l’autre.

Logique pure dans `src/lib/command-center/logic.ts` (visibilité, ordre, urgence, fenêtres d’agenda, briefing). Collecte dans `src/features/command-center/services/command-center.service.ts`.

Non livré, faute de modèle de données : table de tâches personnelles (donc Kanban éditable, glisser-déposer entre colonnes, statuts « En attente » et « Terminé », filtres et recherche sur des tâches saisies) ; validation ou refus en un clic depuis le Command Center (la décision se prend sur la fiche du module, pour garder le circuit d’approbation) ; inventaires et BAT client ; réunions, visites clients et contrôles qualité dans l’agenda ; jalons projets ; alertes « résolues » (pas de suivi d’alerte) ; écrans de création « Nouvel OF », « Nouveau document GED » et « Nouvel inventaire » ; stock actuel et minimum par entrepôt (le calcul agrège les entrepôts). La demande d’achat depuis une rupture s’ouvre vierge.

## Devises et fiscalité

Page `/finance/devises` (onglet « Devises et fiscalité » de la finance, droit `finance.read` ; la saisie des taux demande `finance.write`). Devises gérées : EUR, TND, USD, GBP. Devise de base : EUR, modifiable tant qu’aucune facture n’a de taux figé.

| Élément | Détail |
|---|---|
| Schéma | `supabase/migrations/0027_multicurrency.sql` : `currencies` (3 décimales pour le TND), `vat_rates` (TVA tunisienne : 19 %, 13 %, 7 %, export, exonérée), `finance_settings`, `exchange_rates` |
| Convention | un taux = combien vaut 1 unité de la devise en devise de base. Une seule valeur par jour et par devise. Le taux applicable est le plus récent publié à la date demandée |
| Figement | chaque facture client prend son taux à l’émission ; chaque facture fournisseur prend le taux du jour de la facture. Les équivalents base sont `base_total` (figés, ne bougent plus) |
| Taux manquant | émettre une facture ou enregistrer une facture fournisseur dans une devise sans taux à cette date est refusé (`FX_RATE_MISSING`) |
| Écart réalisé | au règlement : montant × (taux du jour du règlement − taux figé). Perte négative |
| Écart latent | solde ouvert réévalué au taux du jour (`fx_open_positions`). Dette qui augmente = perte |
| TVA | `vat_summary` : base HT, TVA et TTC par taux, converties en base au taux figé |
| Export | client dans un autre pays que la société : traitement export. `export_controls` signale la TVA facturée sur un export et l’absence de BL émis pour la commande |
| Reporting | `multicurrency_report` : CA facturé en devise et en base, créances et dettes ouvertes, écarts réalisés et latents, par devise |

Tests : `tests/sql/multicurrency.test.mjs` (44 contrôles : saisie et droits, recherche du taux, conversion, figement à l’émission, refus sans taux, verrou de la devise de base, écarts latents et réalisés, TVA, contrôles export, reporting, isolation).

Limites connues :
- les règlements fournisseur n’ont pas de devise propre : ils sont imputés aux factures dans l’ordre (FIFO). Un règlement partagé entre deux devises n’est donc pas ventilé correctement ;
- les montants fournisseur restent à 2 décimales (colonnes existantes) : le TND, à 3 décimales, y est arrondi. Passer ces colonnes à 3 décimales demande de recréer les vues qui les utilisent ;
- les avoirs ne sont pas déduits de la TVA ; la TVA déductible sur achats n’est pas calculée (les factures fournisseur ne portent pas de taxe) ;
- les taux de TVA et leur application sont à valider par l’expert-comptable : le module les affiche, il ne remplace pas la déclaration ;
- les taux de change sont saisis à la main (pas d’import automatique de la banque centrale).

## Comptabilité générale

Page `/finance/comptabilite` (onglet « Comptabilité », droit `finance.read` ; clôture : `finance.write`). Socle v1 de l'exigence FIN-01.

| Élément | Détail |
|---|---|
| Schéma | `supabase/migrations/0031_general_ledger.sql` : `gl_accounts`, `gl_journals`, `gl_periods`, `gl_entries`, `gl_entry_lines` |
| Plan comptable | provisoire : 9 comptes (411, 401, 445, 521, 531, 607, 666, 701, 766), statut « à valider » tant que l'expert-comptable ne l'a pas confirmé |
| Écritures automatiques | facture client émise (VT : 411 / 701 / 445), facture fournisseur (AC : 607 / 401), encaissement client (BQ : 521 / 411, écart de change en 766 ou 666), règlement fournisseur affecté (BQ : 401 / 521, écart en 766 ou 666), avoir émis (VT : contrepassation) |
| Garanties | écriture équilibrée (débit = crédit), numérotation par journal (`VT-AAAA-000001`), une seule écriture par document, écriture validée immuable, période clôturée refusée |
| États | balance des comptes (avec contrôle débit = crédit), grand livre par compte avec solde progressif |
| Reprise | les documents déjà émis avant la migration reçoivent leur écriture ; relancer la reprise est sans effet |

Tests : `tests/sql/general-ledger.test.mjs` (34 contrôles : plan, écritures automatiques, écart de change, contrepassation d'avoir, balance, grand livre, immutabilité, déséquilibre, compte inconnu, rejeu, clôture).

Limites v1 :
- pas d'écritures manuelles (journal OD) ;
- pas d'exercices comptables, de bilan ni de compte de résultat ;
- TVA déductible non comptabilisée (les factures fournisseur ne portent pas de taxe) ;
- le compte 607 reçoit le montant HT des factures fournisseur, faute de ventilation ;
- pas de comptabilisation des amortissements, des stocks ni de la paie ;
- les règlements fournisseur sont imputés aux factures dans l'ordre (FIFO) : un règlement partagé entre deux devises n'est pas ventilé.

## Installation

1. **Base de données** — appliquer dans l'ordre `../supabase/migrations/0001_auth_core.sql`, `0002_auth_seed.sql`, `0003_rbac_audit.sql` puis `0004_clients.sql`, `0005_ged.sql`, `0006_suppliers.sql`, `0007_articles.sql`, `0008_bom.sql`, `0009_stock.sql`, `0010_mrp.sql` `0011_purchases.sql`, `0012_commercial.sql`, `0013_pdm.sql`, `0014_development.sql` puis `0015_variants.sql` (crée les buckets Storage privés `ged`, `supplier-docs`, `article-photos` et `product-photos`)
   (`supabase db push` en local/CLI, ou SQL Editor du Dashboard).
2. **Hook JWT** — Dashboard → *Authentication → Hooks → Custom Access Token* → fonction `public.custom_access_token_hook`
   (déjà déclaré dans `supabase/config.toml` pour le développement local).
3. **Réglages Auth** (Dashboard → Authentication) :
   - désactiver *Allow new users to sign up* ;
   - longueur minimale du mot de passe 10, exiger minuscule/majuscule/chiffre/symbole ;
   - *URL Configuration* : Site URL + Redirect URLs `…/auth/callback` et `…/auth/confirm`.
4. **Variables** — `cp .env.example .env.local` et renseigner URL, clé anon, clé `service_role` (serveur uniquement).
5. **Premier administrateur** :
   ```bash
   npm install
   node --env-file=.env.local scripts/create-admin.mjs admin@mbconfection.com 'Mdp-Temporaire-1!' "Nom Prénom" admin --force-change
   ```
6. `npm run dev` → http://localhost:3000

### Modèle d'e-mail « Reset password » (recommandé)
Pour que le lien fonctionne même ouvert dans un autre navigateur, utiliser le flux `token_hash` :
```
<a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery">Réinitialiser mon mot de passe</a>
```
Le lien par défaut (`/auth/callback?code=…`, PKCE) fonctionne dans le navigateur qui a fait la demande.

## Sécurité mise en œuvre
- Session validée côté serveur à chaque requête (`getUser()`), jamais le seul cookie.
- RLS sur toutes les tables ; `profiles` modifiable seulement sur `full_name/phone/locale` ; pas d'écriture sur rôles/permissions/journal côté client.
- Le trigger de profil lit `raw_app_meta_data` (serveur) et **ignore** `user_metadata` (modifiable par l'utilisateur).
- Pas d'énumération de comptes (messages génériques, réponse identique au « mot de passe oublié »).
- Redirections `?next=` filtrées (`safeNext`), cookies `HttpOnly`, en-têtes de sécurité (`next.config.ts`).
- Session de récupération limitée à `/reset-password` (cookie `mb_recovery`) ; toutes les sessions sont révoquées après réinitialisation.
- Timeout d'inactivité : middleware (`AUTH_IDLE_TIMEOUT_MINUTES`) + avertissement côté client avec battement de cœur.

## Tests
- `npm run test:sql` — exécute les migrations dans PGlite (Postgres WASM, `auth` simulé) : authentification (25 contrôles) et RBAC/audit (58 contrôles) et Clients (93 contrôles : RLS, droits de colonnes, commercial affecté, contact/adresse principal, documents + Storage, archivage, suppression, historique, isolation société).
- `npm run test:sql` (dont `tests/sql/client360.test.mjs`, 10 contrôles : réclamations, cycle de traitement, commande d’un autre client refusée, visibilité et droits ; et `tests/sql/copilot.test.mjs`, 15 contrôles : historique privé par utilisateur, droits, rentabilité client et masquage des marges, suggestions d’achat et de production) ; `npm run test:unit` (moteur du copilote : intentions, tendance, 27 contrôles).
- `npm run test:sql` (dont `tests/sql/executive.test.mjs`, 18 contrôles : permissions DG, CA et marge du mois, tendance, prévision, alerte de créances, masquage des modules sans droit, paramètre de période).
- `npm run test:sql` (dont `tests/sql/finance.test.mjs`, 42 contrôles : affectation FIFO des règlements, litiges, surpaiements refusés, encaissements clients, balances âgées, relances idempotentes, trésorerie, prévisions hebdomadaires, tableau de bord).
- `npm run test:sql` (dont `tests/sql/shipping.test.mjs`, 43 contrôles : préparation, garde-fous de commande et d’article, picking et réservation, colisage, bon de livraison, sortie de stock, facture export, annulation et libération des réservations, indicateurs, isolation par entrepôt).
- `npm run test:sql` (dont `tests/sql/quality.test.mjs`, 46 contrôles : référentiel, décisions et règles de gravité, non-conformité automatique, actions et vérifications, plans, justification de clôture, indicateurs, historique immuable).
- `npm run test:sql` (dont `tests/sql/production.test.mjs`, 44 contrôles : statuts et transitions, garde-fous de quantité, date et motif, journal immuable, rendement, productivité, charge atelier, retards et droits).
- `npm run test:sql` (dont `tests/sql/stock_movements.test.mjs`, 58 contrôles : numérotation, journal immuable, validation en deux niveaux, auto-validation refusée, refus et retrait, annulation par réversion, visibilité par entrepôt, règles de validation).
- `npm run test:unit` (dont `tests/unit/strategy.test.mjs`, 46 contrôles : baisse de client à 22 % = 85 000 € critique, seuils de priorité, échéances, cross-selling, prévisions, produits, tri et synthèse).
- `npm run typecheck`, `npm run build`.

## Limites connues
- Pas encore de MFA ni de SSO (prévu : Supabase MFA TOTP).
- Pas de CSP stricte (nécessite des nonces avec Next) ; à ajouter avant la mise en production.
- Le verrouillage est basé sur l'e-mail (pas sur l'IP) ; ajouter un rate-limit au niveau CDN/proxy en production.
