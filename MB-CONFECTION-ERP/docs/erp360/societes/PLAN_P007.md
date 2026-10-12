# Sociétés, sites et contexte actif — Lot P007 (WORKMAN ERP 360)

Date : 12 octobre 2026. Statut : **partiellement réalisé**. La partie qui ne dépend pas de données manquantes est livrée et testée. Le reste est bloqué par des informations que je ne peux pas inventer (pays, identifiants légaux, sites réels, choix de conception).

## 1. Constat

| Élément | Constat | Preuve |
|---|---|---|
| Sociétés en base | **1** (MB Confection) | `companies` |
| Colonnes de `companies` | `name`, `country` **obligatoire**, `legal_id` optionnel | schéma local |
| Rattachement des utilisateurs | 1 société par utilisateur (`profiles.company_id`), 2 utilisateurs | `profiles` |
| Société dans le jeton | prise dans le profil à la connexion : **pas de choix de société actif** | fonction `custom_access_token_hook` |
| Documents | `company_id NOT NULL` dans les 13 tables de documents contrôlées ; aucune ligne sans société | schéma et comptage |
| Sites | table `sites` créée (migration 0032), **0 site** | base locale |

## 2. Ce qui est livré

### Migration `supabase/migrations/0034_company_scope.sql` (additive, versionnée)

1. **`public.user_company_access`** : accès d'un utilisateur à une société, avec `active`, `granted_by`, `revoked_at`. RLS : chaque utilisateur ne voit que ses propres lignes. Écriture réservée à `service_role`.
2. **Reprise** : une ligne par rattachement existant (`profiles.company_id`). Aucune supposition : 2 utilisateurs, 2 lignes.
3. **`private.has_company_access(company)`** : vrai si l'utilisateur connecté est actif sur la société.
4. **Verrou de société** `private.forbid_company_change()` sur **13 tables de documents** (commandes, factures, devis, achats, réceptions, factures fournisseur, OF, expéditions, avoirs, demandes d'achat, sous-traitance, contrôles et non-conformités). Un `UPDATE` qui change `company_id` est refusé avec `COMPANY_CHANGE_FORBIDDEN`.

Application : sauvegarde du schéma (`scratchpad/pre_0034_schema.sql`), transaction, ligne de registre 0034. Registre : 34 lignes pour 34 fichiers. Les avis `NOTICE` affichés pendant l'application signalent seulement qu'aucun verrou n'existait encore : ils sont bénins.

### Tests exécutés (transaction annulée, base locale)

| Contrôle | Résultat |
|---|---|
| 1. Reprise : accès = rattachements existants (2 = 2) | **réussi** |
| 2. Changement de société d'une demande d'achat refusé, motif `COMPANY_CHANGE_FORBIDDEN` | **réussi** |
| 3. Mise à jour sans changement de société acceptée | **réussi** |
| 4. `has_company_access` : vrai pour la société rattachée, faux pour une autre | **réussi** |
| 5. RLS : les accès d'un autre utilisateur ne sont pas visibles | **réussi** |
| Après annulation : sociétés = 1, accès = 2 (aucune donnée de test restante) | **vérifié** |
| Présence des 13 verrous en base | **13 / 13** |

Remarque : sur `invoices`, c'est la garde existante `COMMERCIAL_LOCKED` (facture validée) qui répond en premier. Le changement de société est refusé dans tous les cas, mais le motif affiché n'est pas `COMPANY_CHANGE_FORBIDDEN`. Le test a donc été fait sur `purchase_requests`, qui n'a pas d'autre garde bloquante.

## 3. Ce qui est bloqué (et pourquoi)

| Élément demandé | Blocage | Information nécessaire |
|---|---|---|
| Créer WORKMAN, STID EXPORT, SOMICO | `country` obligatoire, pas fourni ; `legal_id` inconnu | pays, identifiant légal, devise de chaque société (OPEN-01) |
| Créer les sites et établissements | liste inconnue | sites, ateliers, boutiques, entrepôts par société (OPEN-02) |
| Distinguer propriété juridique, site physique, société exploitante | **choix de modèle non tranché** : deux options possibles (voir D-P007-04) | validation DAF |
| Contexte actif visible (sélecteur) | **choix de conception non tranché** : le jeton porte une seule société (D-P007-03) | décision DSI |
| Rattacher les données anciennes par mapping validé | **rien à rattacher** : toutes les lignes existantes sont déjà dans MB Confection (NOT NULL) ; un futur rattachement exige un fichier de mapping validé | aucune pour l'instant |
| Écran d'administration des accès | non fait : décision d'écriture (D-P007-02) | décision DSI |

## 4. Décisions à prendre

| ID | Décision | Décideur |
|---|---|---|
| D-P007-01 | Pays, identifiant légal et devise de WORKMAN, STID EXPORT, SOMICO (création des sociétés) | DAF, direction |
| D-P007-02 | Qui administre `user_company_access` (écran, procédure, journal) | DSI |
| D-P007-03 | Contexte actif : (a) choix à la connexion et nouveau jeton, ou (b) en-tête de requête validé côté serveur contre `user_company_access` (recommandé : pas de nouveau jeton, vérification à chaque requête) | DSI, architecte |
| D-P007-04 | Modèle des trois notions : **propriétaire juridique** du stock et des documents = `company_id` ; **site physique** = `sites` ; **société exploitante** = à ajouter comme colonne distincte sur le site (non ajoutée : décision DAF) | DAF |
| D-P007-05 | Liste des sites, ateliers, boutiques, entrepôts par société | direction opérations |
| D-P007-06 | Règle de rattachement des données anciennes en cas de nouvelle société : mapping validé par le propriétaire, jamais par défaut | propriétaire des données |

## 5. Limites

- Le verrou protège **13 tables** de documents, pas les 123 tables qui ont un `company_id` ; les autres (référentiels, journaux) restent à traiter selon leur nature.
- Le verrou lève une erreur mais **n'est pas journalisé** dans `audit_logs` : à ajouter (tentative de changement = événement d'audit).
- Aucun écran, aucune route d'API et aucun sélecteur de société n'ont été ajoutés : ce lot est de la **base de données et de la sécurité**.
- Les tests sont des tests de base (un seul utilisateur réel, une seule société en base). Le scénario « deux sociétés réelles » ne peut pas être démontré sans les sociétés (D-P007-01).

## 6. Passation

- Fichiers : `supabase/migrations/0034_company_scope.sql` ; `docs/erp360/societes/PLAN_P007.md`.
- Base locale : migration 0034 appliquée, registre à 34 lignes, 13 verrous présents, 2 accès repris.
- Prochaine action : obtenir OPEN-01 et OPEN-02, puis trancher D-P007-03 et D-P007-04, avant toute création de société.
