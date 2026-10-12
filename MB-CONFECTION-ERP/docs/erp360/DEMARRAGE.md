# Démarrage local — WORKMAN ERP 360 (lot P002)

Ce document décrit le démarrage reproductible du socle existant. Il ne contient aucun secret : les valeurs réelles restent dans les fichiers `.env` locaux, ignorés par git.

## 1. Décision de pile (constat)

Un ERP existe dans le dépôt. Il n'a donc **pas** été remplacé ni réinitialisé. Pile retenue, conforme à `docs/ADR-001-architecture-fullweb.md` :

| Couche | Technologie | Emplacement | Statut |
|---|---|---|---|
| Frontend | Next.js 15, React 19, TypeScript, Tailwind v4 | `web/` | existant, conservé |
| API | Laravel 12, API seule (sans Blade ni route web) | `api/` | existante, conservée |
| Données et identité | Supabase (PostgreSQL 15, Auth, Storage, RLS) | `supabase/`, stack Docker locale | existante, conservée |
| Conteneurs | Docker (image API) et Docker Compose de développement | `api/Dockerfile`, `docker-compose.dev.yml` | ajouté ce lot |

- **NestJS** : non introduit. Le cahier mentionne « Laravel ou NestJS, une seule pile par responsabilité » (matrice ARC-B) ; la décision approuvée est Laravel pour l'API. Changer de backend exigerait une décision écrite et un impact documenté.
- **Environnements** : seul l'environnement **local de développement** est défini ici. Test, préproduction et production ne sont pas créés (voir §5).

## 2. Prérequis

- Docker Desktop (Compose v2).
- Node.js et npm (version utilisée pour ce démarrage : Node v24.16.0 ; la version minimale requise par Next.js 15 n'a pas été re-vérifiée ici).
- Supabase CLI (le projet utilise la stack locale `supabase start`).
- Un fichier `web/.env.local` et un fichier `api/.env` créés à partir des modèles (voir §3).

## 3. Variables d'environnement

Les modèles ne contiennent que des noms et des valeurs vides ou fictives. Aucune valeur réelle n'est versionnée.

| Variable | Fichier | Rôle | Secret ? |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `web/.env.local` | URL de Supabase (publique) | non |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `web/.env.local` | clé anonyme (publique par conception, soumise à la RLS) | non (mais ne pas diffuser) |
| `SUPABASE_SERVICE_ROLE_KEY` | `web/.env.local` | contourne la RLS ; lue uniquement côté serveur (`server-only`) | **oui** |
| `NEXT_PUBLIC_SITE_URL` | `web/.env.local` | adresse publique de l'application | non |
| `WORKMAN_API_URL` | `web/.env.local` | adresse de l'API Laravel | non |
| `AUTH_IDLE_TIMEOUT_MINUTES`, `AUTH_MAX_FAILED_ATTEMPTS`, `AUTH_LOCKOUT_MINUTES` | `web/.env.local` | politique de session et de verrouillage | non |
| `APP_KEY` | `api/.env` | clé de chiffrement Laravel (générée par `php artisan key:generate`) | **oui** |
| `DB_HOST`, `DB_PORT`, `DB_DATABASE`, `DB_USERNAME` | `api/.env` | connexion PostgreSQL. Compte `workman_api` (migration 0033) en local | non |
| `DB_PASSWORD` | `api/.env` | mot de passe du compte `workman_api` | **oui** |
| `SUPABASE_URL`, `SUPABASE_JWT_SECRET` | `api/.env` | vérification des jetons Supabase. Le secret HS256 n'est nécessaire qu'en mode legacy | `SUPABASE_JWT_SECRET` : **oui** |

Règles appliquées :
- Les fichiers `.env`, `.env.local` et `supabase/.temp/` sont exclus par `.gitignore`.
- `SUPABASE_SERVICE_ROLE_KEY` n'apparaît que dans `web/src/lib/supabase/admin.ts` et `web/src/features/ged/services/storage.service.ts` (modules `server-only`) et dans `web/scripts/create-admin.mjs` (script exécuté localement par un administrateur). Aucun composant client ne lit l'environnement.
- Rotation : toute clé ayant été affichée ou partagée doit être régénérée (procédure hors de ce document).

## 4. Démarrage pas à pas

```bash
# 1. Base et identité locales (Supabase CLI)
supabase start

# 2. API (conteneur de développement, durcissement plus tard)
docker compose -f docker-compose.dev.yml up -d --build api

# 3. Web (Next.js, port 3002 ; configuration « mb-confection-web » dans .claude/launch.json de l'espace de travail)
cd web && npm install && npm run dev -- -p 3002

# 4. Contrôles de santé
set -a; . web/.env.local; set +a
SUPABASE_URL="$NEXT_PUBLIC_SUPABASE_URL" SUPABASE_ANON_KEY="$NEXT_PUBLIC_SUPABASE_ANON_KEY" \
  WEB_URL=http://localhost:3002 API_URL=http://localhost:8000 bash scripts/check-health.sh
```

Le script `scripts/check-health.sh` vérifie :
1. l'API répond (`GET /api/v1/health` = 200) et la base est joignable (`"database":"up"`) ;
2. une route protégée refuse un appel sans jeton (401) ;
3. la page de connexion du web répond (200) ;
4. le service de santé de Supabase Auth répond (200), si la clé anon est fournie.

Il ne publie aucune valeur de secret. Son code de sortie vaut 0 si tous les contrôles passent, 1 sinon.

## 5. Environnements

| Environnement | Statut | Remarque |
|---|---|---|
| Local (développement) | **défini et démontré** (§6) | stack Supabase Docker, API en conteneur, web en `npm run dev` |
| Test / recette | non créé | à définir avec les référents recette (CDC §12.9) |
| Préproduction | non créé | à définir avec la DSI ; la base doit être une copie anonymisée autorisée |
| Production | non créé | aucune mise en production sans décision du COPIL (CDC §12.1) |

Chaque environnement doit avoir ses propres clés, sa propre base et son propre fichier de variables. Aucune donnée de production ne doit être utilisée en développement.

## 6. Démarrage démontré (preuves)

Exécuté le 12 octobre 2026 sur la machine de développement :

| Contrôle | Résultat |
|---|---|
| `docker compose -f docker-compose.dev.yml config -q` (validation sans affichage de la configuration) | valide |
| `docker compose -f docker-compose.dev.yml up -d --build api` | conteneur `workman-api-dev` créé, démarré, état **healthy** (contrôle de santé du conteneur) |
| `GET http://localhost:8000/api/v1/health` | `{"status":"ok","database":"up","version":"v1"}` |
| Web `npm run dev` (port 3002), `GET /login` | HTTP 200 |
| `scripts/check-health.sh` (conditions normales) | 5/5 contrôles réussis, code de sortie 0 |
| `scripts/check-health.sh` avec une API absente (port 8099) | 3 échecs signalés, code de sortie 1 (le script détecte bien les pannes) |
| Recherche de motifs de clés (JWT, clés privées, clés Stripe, clés AWS, `APP_KEY` réel) dans les nouveaux fichiers | aucun |
| Recherche dans les fichiers suivis par git et dans l'historique | aucun `.env` réel n'est suivi ; seuls les modèles `.env.example` figurent dans l'historique |

## 7. Limites

- `php artisan serve` est un serveur de développement : il ne convient pas à la production. Le conteneur n'exécute pas encore un serveur de production (PHP-FPM ou équivalent).
- Le web n'est pas conteneurisé : il tourne en `npm run dev` (ARC-F reste partiel).
- Le mot de passe local du compte `workman_api` est dans `api/.env` : acceptable en local seulement (voir migration 0033 et `PROJECT_STATE.md`, §6ter).
- Les contrôles de santé ne couvrent pas la sauvegarde, la supervision ni les tâches planifiées (aucune n'existe à ce stade, voir `INVENTAIRE_P001.md`).
- Le démarrage dépend de la stack Supabase locale, dont les versions d'images sont celles de la CLI installée.

## 8. Décisions à valider

1. Confirmer Laravel comme backend API (ADR-001) plutôt que NestJS.
2. Définir les environnements test, préproduction et production (propriétaires, données autorisées, calendrier).
3. Choisir le serveur PHP de production (PHP-FPM, Octane ou autre) pour le conteneur API.
4. Décider la conteneurisation du web (image Node) et son intégration au Compose.
