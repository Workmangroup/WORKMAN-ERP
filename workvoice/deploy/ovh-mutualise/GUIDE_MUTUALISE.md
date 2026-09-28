# WORKVOICE — Installation sur hébergement mutualisé OVH (FTP)

Aucun serveur à administrer : tout se fait avec **phpMyAdmin** et **FileZilla**.

## Les fichiers

| Fichier | Contenu |
|---|---|
| `1-BASE-workmagrh.sql` | La base de données complète (installation initiale uniquement) |
| `2-FTP-www-workvoice.zip` | Tout ce qui va dans le dossier `www/` : le site + l'API PHP (`api/`) |
| `05_migration_modules_rh.sql` | Migration de secours pour les modules Congés/Sorties/Retards/Fiche (normalement automatique, voir plus bas) |
| `06_migration_multi_tenant.sql` | Migration de secours pour le Multi-société (table `companies`, `company_id` — normalement automatique, voir plus bas) |

## Étape 1 — Base de données (phpMyAdmin)

1. phpMyAdmin → onglet **Importer** → `1-BASE-workmagrh.sql` → **Exécuter**.
2. Vérifier à gauche, dans `workmagrh` : 15 tables + 2 vues.

## Étape 2 — Renseigner le mot de passe de la base

1. Dézipper `2-FTP-www-workvoice.zip` sur votre PC.
2. Ouvrir **`www/api/config.php`** avec le Bloc-notes et remplacer :
   ```php
   'db_password' => 'METTRE_ICI_LE_MOT_DE_PASSE_DE_LA_BASE',
   ```
   par le mot de passe de la base (celui choisi à sa création dans l'espace client OVH).
3. Vérifier `db_host` : espace client OVH → **Hébergements** → votre hébergement → onglet
   **Bases de données** → colonne **Adresse du serveur** (en général `workmagrh.mysql.db`).
   Même chose pour `db_user` (colonne **Utilisateur**).
4. Remplacer `https://www.votre-domaine.tn` (`site_url`) et `noreply@votre-domaine.tn` (`mail_from`) par votre domaine.

## Étape 3 — Envoi FTP (FileZilla)

Connectez-vous avec les identifiants FTP OVH, puis envoyez **le contenu** du dossier `www/`
de votre PC dans le dossier **`www/`** du serveur (remplacer les fichiers existants).

⚠️ Pensez aux fichiers cachés **`.htaccess`** et **`.ovhconfig`** : dans FileZilla, menu
**Serveur → Forcer l'affichage des fichiers cachés**. Le fichier `.ovhconfig` active PHP 8.2 :
sans lui, l'API ne fonctionne pas.

## Étape 4 — Vérifier

1. Ouvrir `https://votre-domaine.tn/api/health` : vous devez lire
   `"status":"ok","database":"up"` avec `"tables":17`.
   - `DATABASE_UNAVAILABLE` → mot de passe, serveur ou utilisateur incorrect dans `config.php`.
   - `PHP_VERSION` → le fichier `.ovhconfig` n'a pas été envoyé.
   - `"uploads_writable":false` → donner les droits d'écriture (755) au dossier `www/api/uploads`.
2. Ouvrir `https://votre-domaine.tn` et se connecter (mot de passe **`Workman@2026`**) :
   `WM1001` (employé), `RH001` (RH), `DG001` (Direction).

## Étape 5 — HTTPS (recommandé, gratuit)

Espace client OVH → **Hébergements** → **Multisite** → activer le **SSL**. Une fois actif,
décommenter les 2 lignes `RewriteCond` / `RewriteRule` de `www/.htaccess` pour forcer le HTTPS.

## Mettre à jour un site déjà en ligne (nouveaux modules)

1. Envoyez le contenu de `www/` du nouveau paquet par FTP, en choisissant **« Écraser »** —
   `config.php` n'y est jamais inclus, votre configuration reste intacte.
2. Rechargez `/api/health` : les nouvelles tables (`conges_*`, `sorties_*`, `retards_*`,
   `companies`, les colonnes de fiche collaborateur et `company_id`) sont créées
   **automatiquement** au premier appel.
3. Si `/api/health` indique des objets manquants (droit `ALTER` refusé par l'hébergeur) :
   exécutez `05_migration_modules_rh.sql` puis `06_migration_multi_tenant.sql` dans
   phpMyAdmin, onglet **SQL**, dans cet ordre (aucun n'efface de donnée existante).

## Avant l'ouverture aux collaborateurs

- Supprimer les données de démonstration (comptes au mot de passe public) : requête dans
  phpMyAdmin, onglet **SQL** :
  ```sql
  SET FOREIGN_KEY_CHECKS=0; TRUNCATE commentaires; TRUNCATE notifications; TRUNCATE audit_logs;
  TRUNCATE demandes; TRUNCATE reclamations; TRUNCATE suggestions; TRUNCATE sequences;
  TRUNCATE questionnaire_reponses_detail; TRUNCATE questionnaire_reponses;
  TRUNCATE questionnaire_participations; TRUNCATE questionnaire_campagnes;
  TRUNCATE conges_mouvements; TRUNCATE conges_demandes; TRUNCATE sorties_demandes;
  TRUNCATE retards_declarations; SET FOREIGN_KEY_CHECKS=1;
  ```
- Charger les vrais collaborateurs dans la table `users` (ou via **Collaborateurs & accès**).
- Renseigner au moins un jour férié par an dans **Congés → Paramétrage** (les fêtes religieuses
  mobiles ne sont pas préremplies : à ajouter chaque année par le RH).

## Dépannage

Pour afficher le détail d'une erreur : mettre `'debug' => true` dans `config.php`, recharger
`/api/health`, puis **remettre `false`** une fois le problème réglé.
