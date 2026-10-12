# ADR-001 — Architecture Full Web, API first

**Statut** : accepté (12 octobre 2026) — migration progressive (option 2).
**Contexte** : directive « Full Web Enterprise » (Next.js 15, React 19, Laravel 12 API only, PostgreSQL, Redis, S3/MinIO, PWA, API first, SaaS ready).

## Décision

1. **Backend** : Laravel 12, API uniquement (`api/`). Aucune route web, aucune vue Blade.
2. **Frontend** : Next.js 15 / React 19 (`web/`). Il consomme **uniquement l'API**. Il n'appelle plus directement la base.
3. **Identité** : les utilisateurs restent gérés par Supabase Auth. L'API vérifie le jeton d'accès Supabase (ES256 via JWKS, HS256 accepté pour l'ancien mode). Aucun second annuaire.
4. **Droits** : les règles d'accès PostgreSQL (RLS, fonctions `private.has_perm`, `private.current_company`) restent la source de vérité. L'API exécute chaque requête avec `set local role authenticated` et le contexte du jeton (`request.jwt.claims`). Un utilisateur sans droit obtient des résultats vides.
5. **Logique métier** : les règles déjà testées (fonctions SQL, triggers, comptabilité, TVA, MRP…) restent en base. Laravel les appelle, il ne les réécrit pas.
6. **Migration progressive** : un module à la fois. Le pilote est `clients` : module terminé côté API et écran ; les onglets 360° des autres modules restent en lecture directe jusqu'à leur migration.

## Conséquences

- **Positives** : un seul modèle de sécurité ; pas de réécriture massive ; la logique métier reste testée (1 808 contrôles SQL).
- **Coûts** : le frontend doit être réécrit module par module pour passer par l'API ; les server actions existantes restent en place jusqu'à leur migration.
- **Faits depuis** : écriture des clients (`POST /api/v1/clients`, `PATCH /api/v1/clients/{id}`), avec les mêmes règles de saisie que le formulaire web, contrat OpenAPI rédigé (`docs/api/openapi.yaml`, non généré), script de vérification `api/tests/smoke/clients.sh` (9 contrôles réussis).
- **Faits ensuite** : la liste des clients (filtres, tris, compteurs, facettes, contact principal) est désormais lue via l'API par l'écran Next.js (`web/src/features/clients/services/clients-api.ts`, appel serveur avec le jeton de session). Vérifié dans le navigateur : liste et filtre pays.
- **Faits depuis** : la création et la modification d'un client depuis l'écran passent par l'API (`apiWrite` dans `web/src/lib/api/server.ts`). Vérifié dans le navigateur : création (CLI-0006) et modification (téléphone), avec les requêtes reçues par l'API.
- **Faits ensuite (module Clients terminé côté API)** : fiche (`GET /api/v1/clients/{id}`), archivage et restauration (`POST .../archive`, `POST .../restore`), suppression définitive (`DELETE /api/v1/clients/{id}`, confirmation « SUPPRIMER », client archivé exigé, fichiers GED renvoyés pour nettoyage du stockage), contacts et adresses (`/clients/{client}/contacts`, `/clients/{client}/addresses`, `/contacts/{id}`, `/addresses/{id}`), conditions de paiement, commerciaux et annuaire (`/payment-terms`, `/sales-reps`, `/users/directory?ids=`). Les actions serveur de l'écran passent toutes par l'API ; `clients.service.ts` ne lit plus la base.
- **Correctif** : les erreurs métier de la base (ex. `CLIENT_NOT_ARCHIVED`) étaient renvoyées sous le code `SQLSTATE` ; `App\Support\DatabaseError` lit désormais le code après `ERROR:`.
- **Vérifications de ce lot** : `api/tests/smoke/clients.sh` : 45 contrôles réussis (droits 401/403/404, validation 422, règle CLIENT_NOT_ARCHIVED, cycle complet). Navigateur : ajout puis suppression d'un contact, archivage puis restauration d'un client, fiche chargée depuis l'API. Ajout d'adresse non testé au navigateur (mêmes règles que les contacts, testé par l'API).
- **Hors du module Clients, encore en lecture directe** : les onglets 360° Commandes, Factures, Documents GED, Articles, Nomenclatures, Réclamations, Performance et Marge (`client360.service.ts`), à migrer avec leurs modules.
- **Restent à faire (plateforme)** : Redis (cache), MinIO (stockage), PWA et hors ligne, CORS (pour les appels navigateur), rôle PostgreSQL à privilèges minimaux pour l'API, tests PHPUnit, image de production sans dépendances de développement, génération de la documentation OpenAPI à partir du code, adoption de ShadCN, TanStack Query et Zustand.

## Vérifications déjà faites

- API Laravel 12.69 démarrée dans un conteneur PHP 8.4 avec `pdo_pgsql`.
- `GET /api/v1/health` : 200, base joignable.
- `GET /api/v1/clients` : sans jeton → 401 ; jeton admin → 3 clients ; jeton sans rôle → liste vide.
- Vérification de jeton ES256 à partir du JWKS de Supabase, testée sur un jeton réel.

## Points de sécurité à traiter avant la production

- L'API se connecte aujourd'hui avec le compte `postgres` (superutilisateur) pour le développement. En production, il faut un rôle dédié, membre de `authenticated`, sans droits d'administration.
- Le secret `SUPABASE_JWT_SECRET` et la clé `service_role` ne doivent jamais être exposés côté navigateur.
- Le fichier `.env` de l'API contient des valeurs locales : à remplacer par des secrets de production.
