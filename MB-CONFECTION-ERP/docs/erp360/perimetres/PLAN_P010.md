# Rôles, permissions et périmètres — Lot P010 (WORKMAN ERP 360)

Date : 12 octobre 2026. Statut : **contrôle et cadrage**. Deux écarts majeurs au cahier sont mesurés ; leur correction change l'accès des administrateurs et demande une décision. Aucun droit n'a été modifié.

## 1. Ce qui est vérifié (preuves)

Fichier : `docs/erp360/perimetres/test-p010-acces-direct.sql` (transaction annulée).

| Contrôle | Résultat |
|---|---|
| A1 : lecture d'un client d'un autre locataire par son identifiant direct | **0 ligne** |
| A2 : modification d'un client d'un autre locataire par son identifiant direct | **0 ligne modifiée** |
| A3 : archivage d'un client d'un autre locataire (paramètre falsifié) | **refusé : `CLIENT_NOT_FOUND`** |
| B0 : stock de l'entrepôt autorisé pour un utilisateur de magasin | **visible** (contrôle de non-vacuité) |
| B1 : stock d'un entrepôt non autorisé demandé par son identifiant | **0 ligne** |
| B2 : entrepôt non autorisé demandé par son identifiant (table `warehouses`) | **0 ligne** |
| Après annulation : locataires = 1, clients = 9, affectations d'entrepôt = 10, rôles du compte de test = 0 | **état initial restauré** |

Tests existants déjà référencés : 56 contrôles RBAC (escalade de droits, dernier administrateur, rôle inconnu) et les refus `WAREHOUSE_FORBIDDEN` / `WAREHOUSE_ZONE_MISMATCH`.

## 2. Écarts mesurés

| # | Exigence du cahier | Constat mesuré | Gravité |
|---|---|---|---|
| E1 | Admin technique sans droit métier automatique (SEC-03) | le rôle `admin` possède **79 permissions sur 79** : tout droit métier, y compris ceux des finances et des achats | **majeure** |
| E2 | Export, marge, salaire, banque : droits distincts | aucune permission d'export ; aucune permission « marge » ; **aucune permission de paie** (la paie n'est pas implémentée) ; banque couverte par `payments.*` et `finance.*`, sans distinction | **majeure** |
| E3 | Scope par propriétaire | aucune notion de propriétaire opérante (seul `created_by` existe) | moyenne |
| E4 | Scope par site | la table `sites` (0032) n'est référencée par **aucune** politique RLS | moyenne |
| E5 | Recherche, pièces, exports, tâches : même contrôle | **non vérifié** dans ce lot (chaque canal doit être testé séparément) | à mesurer |

Le contrôle de non-vacuité (B0) est important : il montre que le test « stock invisible » ne réussit pas simplement parce que rien n'est visible.

## 3. Pourquoi aucun droit n'a été modifié

- **E1** : retirer les droits métier du rôle `admin` supprimerait l'accès du compte administrateur existant à toute l'application. Il faut d'abord créer un rôle d'administration technique distinct, affecter les administrateurs, puis retirer les droits métier de `admin`. C'est une décision de DSI et de direction (D-P010-01).
- **E2** : créer des permissions (export, marge, paie, banque) change le catalogue des droits. Il faut valider la liste et l'affectation par rôle (D-P010-02).
- **E3 et E4** : un scope par propriétaire ou par site change les règles de lecture de tables existantes. Il faut une règle écrite par domaine (D-P010-03).

## 4. Proposition (non implémentée)

1. **Rôle `admin_technique`** : gestion des utilisateurs, des rôles, des sessions et du journal d'audit ; **aucune** permission métier ; affectation tracée.
2. **Permissions distinctes** : `export.<domaine>.read`, `margin.read`, `payroll.read` (à créer avec la paie), `bank.read` / `bank.write`, séparées de `costs.read` et de `payments.*`.
3. **Scope** : chaque requête est limitée à la société active, puis à l'entrepôt ou au site de l'utilisateur quand le rôle l'exige ; une absence de scope se traduit par zéro ligne (refus par défaut).
4. **Tests de non-régression** : pour chaque table exposée, un test par identifiant direct d'un autre périmètre, un test de paramètre falsifié, et un test de non-vacuité.

## 5. Décisions nécessaires

| ID | Décision | Décideur |
|---|---|---|
| D-P010-01 | Création du rôle `admin_technique` et retrait des droits métier de `admin` (procédure de transition, compte administrateur de test inclus) | DSI, direction |
| D-P010-02 | Liste des permissions distinctes (export, marge, paie, banque) et rôles associés | DSI, DAF, responsable paie |
| D-P010-03 | Règle de scope par propriétaire et par site, par domaine | responsables de domaine |
| D-P010-04 | Périmètre de vérification de E5 (recherche, pièces, exports, tâches) et calendrier | QA, DSI |

## 6. Limites

- Une seule société existe en base : le test inter-locataires utilise un locataire temporaire annulé.
- Le scope par site ne peut pas être testé tant qu'il n'existe aucun site réel (OPEN-02).
- Le canal « recherche » et les pièces (GED) n'ont pas été contrôlés ici (E5).
- Les tests ont été exécutés sur la base locale de développement, pas sur une copie anonymisée.

## 7. Passation

- Fichiers : `docs/erp360/perimetres/PLAN_P010.md`, `docs/erp360/perimetres/test-p010-acces-direct.sql`.
- Aucune migration, aucun droit modifié.
- Prochaine action : obtenir D-P010-01 et D-P010-02 ; ensuite créer le rôle `admin_technique` par migration additive.
