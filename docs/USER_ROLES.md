# USER_ROLES — Rôles et permissions (RBAC)

> Statut : implémenté (migration `0003_rbac_audit.sql`). Les droits sont appliqués par **PostgreSQL (RLS + fonctions `rbac_*`)** ; le menu, le middleware et les guards ne font que refléter ces droits.

## 1. Rôles système (8)
| Code | Libellé | Périmètre |
|---|---|---|
| `admin` | Administrateur | Accès complet : utilisateurs, rôles, permissions, audit |
| `direction` | Direction | Lecture globale + validations (commandes, achats, qualité, articles, ajustements de stock) et archivage / restauration des clients (`clients.delete`) |
| `commercial` | Commercial | Clients, commandes, expéditions |
| `achat` | Achat | Fournisseurs, achats |
| `production` | Production | Ordres de fabrication, planification, saisie atelier |
| `qualite` | Qualité | Contrôles, certifications, libération/blocage des lots |
| `magasin` | Magasin | Stock, réceptions, expéditions |
| `finance` | Finance | Factures, paiements, coûts |

Les rôles système ne peuvent ni être supprimés ni renommés ; leurs permissions restent modifiables (sauf le socle d'administration du rôle `admin`). On peut créer des **rôles personnalisés**.

## 2. Catalogue de permissions (`module.action`, 43)
`admin` : users.read/write, roles.read/write/assign, audit.read, sessions.manage ·
`dashboard.read` · `clients.read/write/delete` · `articles.read/write/validate` ·
`documents.read/write`, `certifications.read/write` · `orders.read/write/confirm` ·
`suppliers.read/write`, `purchases.read/write/approve` · `stock.read/write/adjust` ·
`production.read/write/plan` · `quality.read/write/approve` · `shipments.read/write` ·
`invoices.read/write`, `payments.read/write`, `costs.read` · `reports.read`

Source de vérité : table `permissions` (et `web/src/lib/rbac/permissions.ts`, vérifié identique par `npm run test:sql`). La matrice par défaut est dans la migration ; la vue **Rôles → Matrice** de l'application l'affiche en direct.

## 3. Règles de sécurité
1. **Contrôle en base** : chaque fonction `rbac_*` vérifie la permission de l'appelant (`roles.write`, `roles.assign`, `users.write`, `sessions.manage`).
2. **Anti-escalade** : on ne peut accorder (à un rôle ou via un rôle à un utilisateur) que des permissions qu'on détient soi-même.
3. **Dernier administrateur** : impossible de retirer le rôle `admin` au dernier admin actif ou de le désactiver ; on ne peut pas désactiver son propre compte.
4. Le rôle `admin` conserve toujours `roles.read/write/assign`, `users.read`, `audit.read` (anti-verrouillage).
5. Isolation par société (`company_id`) sur rôles, utilisateurs et audit.
6. Désactiver un compte révoque immédiatement ses sessions ; « forcer la reconnexion » applique les nouveaux droits sans attendre.
7. Les permissions sont aussi dans le JWT (`app_permissions`) pour le middleware ; en cas de décalage, `/auth/refresh` renouvelle le jeton avant de refuser. Les guards serveur lisent la base.

## 4. Audit
Table `audit_logs` **en ajout seul** (UPDATE/DELETE/TRUNCATE interdits, même pour le propriétaire). Alimentée par triggers (capture aussi les écritures SQL/`service_role`) et par les RPC (une entrée agrégée avec « ajouté / retiré »). Événements : `role.create|update|delete|permissions_update|permission_grant|permission_revoke`, `user.create|update|delete|activate|deactivate|roles_update|role_assign|role_revoke|sessions_revoked`, `access.denied`. Chaque entrée : acteur, cible, avant/après, IP, user-agent, origine. Consultable et exportable (CSV) avec `audit.read`.
