# WORKVOICE — Portail Collaborateur Workman

Demandes RH, réclamations, suggestions et signalements, avec une vue Direction anonymisée.
Architecture détaillée : [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

| Phase | Contenu | État |
|------:|---------|------|
| 1 | Architecture, arborescences, scripts SQL, données de démo | ✅ |
| 2 | API REST Express : JWT, RBAC, CSRF, audit, notifications | ✅ |
| 3 | Frontend Next.js : socle, auth, layout, design system Workman | ✅ |
| 4 | Espace Employé | ✅ |
| 5 | Espace RH | ✅ |
| 6 | Espace Direction + graphiques | ✅ |
| 7 | Questionnaire de satisfaction du personnel (GRH-IFD-23, FR/AR) | ✅ |
| 8 | Kit de mise en ligne OVH (`deploy/`, `dist/workvoice-ovh.zip`) | ✅ |
| 9 | API PHP pour hébergement mutualisé OVH (`api-php/`, déploiement FTP) | ✅ |
| 10 | Gestion des collaborateurs et des accès par le RH (création, rôles, désactivation, import CSV) | ✅ |
| 11 | Module Congés (types paramétrables, solde historisé, workflow, alertes IA) | ✅ |
| 12 | Module Autorisations de sortie (motifs, cumul temps, workflow, alertes IA) | ✅ |
| 13 | Module Déclaration des retards (motifs, seuils configurables, alertes IA) | ✅ |
| 14 | Fiche collaborateur enrichie (identité, administratif, contrat, paie — RH uniquement) | ✅ |

## Mise en ligne sur OVH

Tout est prêt dans **`dist/workvoice-ovh.zip`** (interface compilée, API, base SQL unique, script d'installation).
Suivre [deploy/GUIDE_OVH.md](deploy/GUIDE_OVH.md). Pour régénérer l'archive : `bash deploy/build-package.sh`.

## Démarrage en local

Prérequis : **Node.js 20+** et **MySQL 8.0.16+**.

```bash
cd backend
npm install
cp .env.example .env          # renseigner DB_USER / DB_PASSWORD
npm run db:init               # crée la base workvoice + vues + données de démo
npm run dev                   # http://localhost:4000/api/health

cd ../frontend
npm install
npm run dev                   # http://localhost:3000 (redirige /api vers :4000)
```

Sans Node, on peut aussi exécuter à la main `database/01_schema.sql`, `02_views_security.sql`
puis `03_seed.sql` dans MySQL Workbench.

### Comptes de démonstration — mot de passe `Workman@2026`

| Matricule | Nom | Rôle |
|-----------|-----|------|
| `WM1001` | Amira Hammami (Confection · Production · Sousse) | Employé |
| `RH001` | Sana Ben Ammar | RH |
| `RH002` | Karim Trabelsi | RH |
| `DG001` | Hichem Gharbi | Direction |
| `DG002` | Leila Mansour | Direction |

`WM1002` à `WM1031` sont d'autres employés ; `WM1032` est désactivé (connexion refusée).

## API REST

Toutes les réponses sont en JSON. Erreurs : `{ "error": { "code", "message", "details?" } }`
(401 non authentifié, 403 interdit ou CSRF, 404, 409, 422 validation).

**Protocole client** : appeler `GET /api/auth/csrf` au chargement, puis envoyer le cookie
(`credentials: 'include'`) et l'en-tête `X-CSRF-Token: <valeur du cookie wv_csrf>` sur tout
POST / PUT / PATCH / DELETE.

### Authentification

| Méthode | Route | Rôle | Description |
|---|---|---|---|
| GET | `/api/auth/csrf` | public | Émet le jeton CSRF |
| POST | `/api/auth/login` | public | `{ matricule, password }` → cookie JWT httpOnly |
| POST | `/api/auth/logout` | tous | Supprime la session |
| GET | `/api/auth/me` | tous | Profil de l'utilisateur connecté |
| PUT | `/api/auth/password` | tous | `{ ancien, nouveau }` (10 car. min, maj., min., chiffre) |

### Espace collaborateur

| Méthode | Route | Description |
|---|---|---|
| GET | `/api/me/dashboard` | Compteurs (en cours, clôturées, en attente), 5 dernières réponses RH, 5 derniers tickets |
| GET | `/api/me/historique?kind=&statut=&termines=` | Historique unifié demandes + réclamations + suggestions |
| GET / PUT | `/api/me/profile` | Profil ; seuls `email` et `telephone` sont modifiables |

### Tickets — `demandes`, `reclamations`, `suggestions`

`:kind` = `demandes` | `reclamations` | `suggestions`

| Méthode | Route | Rôle | Description |
|---|---|---|---|
| POST | `/api/demandes` | tous | **multipart** : `type_demande`, `objet`, `description`, `piece_jointe` (PDF/JPG/PNG/DOC/DOCX, 5 Mo) |
| POST | `/api/reclamations` | tous | `categorie`, `objet`, `description`, `niveau_urgence`, `confidentielle` |
| POST | `/api/suggestions` | tous | `theme`, `objet`, `description` |
| GET | `/api/:kind/mine` | tous | Mes tickets |
| GET | `/api/:kind/:id` | auteur, RH | Détail + fil d'échange (identité de l'auteur pour le RH uniquement) |
| POST | `/api/:kind/:id/commentaires` | auteur, RH | `{ message }` — répondre |
| PATCH | `/api/:kind/:id/statut` | RH | `{ statut, commentaire? }` |
| GET | `/api/demandes/:id/piece-jointe` | auteur, RH | Téléchargement de la pièce jointe |

### Espace RH

| Méthode | Route | Description |
|---|---|---|
| GET | `/api/rh/dashboard` | Demandes / réclamations / suggestions ouvertes, critiques, délai moyen, répartitions, derniers tickets |
| GET | `/api/rh/:kind?statut=&type=&urgence=&ouverts=&site=&departement=&q=&page=&pageSize=` | Liste paginée avec auteur |
| GET | `/api/rh/referentiels` | Sites et départements (filtres) |

### Espace Direction (vues anonymisées uniquement)

| Méthode | Route | Description |
|---|---|---|
| GET | `/api/direction/dashboard` | KPI : total réclamations, total demandes, temps moyen, réclamations du mois, taux de résolution |
| GET | `/api/direction/stats?annee=2026` | Par service, catégorie, site, département, urgence ; évolution et temps moyen mensuels |
| GET | `/api/direction/reclamations?categorie=&urgence=&statut=&site=&departement=&q=&page=` | Liste anonymisée |
| GET | `/api/direction/reclamations/:id` | Détail anonymisé (sans échanges ni pièces jointes) |
| GET | `/api/direction/referentiels` | Sites et départements |

### Congés, sorties, retards (Modules 1-3)

Même schéma pour les trois modules : `POST /api/{conges|sorties|retards}` (création, statut
`EN_ATTENTE`), `GET /api/me/{...}` (mes déclarations), `POST /api/{...}/:id/annuler` (par le
collaborateur, tant que non traité), `GET /api/rh/{...}` (liste RH), `PATCH /api/rh/{...}/:id/statut`
(`VALIDE`/`REFUSE`/`ANNULE`), `GET /api/rh/{...}/dashboard`, `GET /api/rh/{...}/analyse` (alertes
IA à base de règles statistiques), et le paramétrage RH des types/motifs.

Spécificités :
- **Congés** : `POST /api/conges/calcul-jours` (aperçu des jours ouvrés avant envoi, hors samedi,
  dimanche et jours fériés configurés) ; le solde n'est décompté qu'à la **validation**, jamais à
  la création, et chaque mouvement est historisé dans `conges_mouvements` (table consultable via
  `GET /api/rh/conges/soldes/:userId/historique`, ajustable via `POST .../ajustement`).
- **Sorties** : `GET /api/me/sorties` renvoie aussi `cumul_mois_minutes` et `cumul_annee_minutes`.
- **Retards** : `GET /api/rh/retards/analyse?seuil=3|5|10` (seuil d'alerte configurable).

### Collaborateurs & accès (RH)

| Méthode | Route | Description |
|---|---|---|
| GET | `/api/rh/collaborateurs?q=&role=&actif=&site=&departement=&page=` | Liste paginée + statistiques |
| POST | `/api/rh/collaborateurs` | Crée un compte ; renvoie **une seule fois** `mot_de_passe_temporaire` |
| PUT | `/api/rh/collaborateurs/:id` | Modifie les informations et l'accès (`role`) |
| PATCH | `/api/rh/collaborateurs/:id/statut` | `{ actif }` : désactive / réactive (effet immédiat) |
| POST | `/api/rh/collaborateurs/:id/mot-de-passe` | Réinitialise : nouveau mot de passe provisoire |
| POST | `/api/rh/collaborateurs/import` | `{ lignes: [...] }` (100 max par envoi) → résultat ligne par ligne |

Un compte au mot de passe provisoire (`mdp_temporaire = 1`) ne peut appeler que `/auth/me`, `/auth/password`
et `/auth/logout` (erreur `403 PASSWORD_CHANGE_REQUIRED`) ; l'interface l'envoie choisir son mot de passe.
Garde-fous : un RH ne peut ni se désactiver ni retirer son propre accès RH, et le dernier RH actif est protégé.

### Questionnaire de satisfaction (GRH-IFD-23)

| Méthode | Route | Rôle | Description |
|---|---|---|---|
| GET | `/api/questionnaire/actif` | tous | Campagne ouverte, questions FR/AR, `deja_repondu` |
| POST | `/api/questionnaire/campagnes/:id/reponses` | tous | `{ reponses: [{ question_id, note 1–5 }], commentaire? }`, anonyme, une fois par campagne |
| GET | `/api/questionnaire/campagnes` | RH, Direction | Campagnes, participation, indice de satisfaction |
| POST | `/api/questionnaire/campagnes` | RH | `{ titre, date_debut, date_fin?, ouvrir? }` |
| PATCH | `/api/questionnaire/campagnes/:id/statut` | RH | `{ statut: OUVERTE \| CLOTUREE }` (notifie les collaborateurs à l'ouverture) |
| GET | `/api/questionnaire/campagnes/:id/resultats?site=&departement=` | RH, Direction | Répartition par question, indices par site/département (seuil ≥ 5), commentaires anonymes |

### Notifications

| Méthode | Route | Description |
|---|---|---|
| GET | `/api/notifications` | 30 dernières + `non_lues` |
| PATCH | `/api/notifications/:id/lu` | Marquer comme lue |
| PATCH | `/api/notifications/tout-lu` | Tout marquer comme lu |

## Exemple (curl)

```bash
# 1. jeton CSRF
curl -c jar.txt http://localhost:4000/api/auth/csrf
CSRF=$(grep wv_csrf jar.txt | awk '{print $7}')

# 2. connexion
curl -b jar.txt -c jar.txt -H "X-CSRF-Token: $CSRF" -H "Content-Type: application/json" \
     -d '{"matricule":"WM1001","password":"Workman@2026"}' http://localhost:4000/api/auth/login

# 3. réclamation confidentielle
curl -b jar.txt -H "X-CSRF-Token: $CSRF" -H "Content-Type: application/json" \
     -d '{"categorie":"SECURITE","objet":"Issue de secours bloquée","description":"Palettes devant l issue de secours du magasin depuis lundi.","niveau_urgence":"CRITIQUE","confidentielle":true}' \
     http://localhost:4000/api/reclamations
```
