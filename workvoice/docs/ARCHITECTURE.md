# WORKVOICE — Architecture

Portail Collaborateur Workman : demandes RH, réclamations, suggestions et signalements,
avec une vue Direction **anonymisée par construction**.

## 1. Vue d'ensemble

```
┌──────────────────────────┐        HTTPS         ┌──────────────────────────────┐
│  Frontend Next.js 16     │  /api/* (rewrite)    │  API Node.js / Express 5     │
│  React · Tailwind ·      │ ───────────────────▶ │                              │
│  shadcn/ui · Recharts    │  cookie JWT httpOnly │  helmet · cors · rate-limit  │
│                          │  + en-tête X-CSRF    │  CSRF double-submit          │
│  /employe  /rh  /direction│ ◀─────────────────── │  JWT → RBAC → zod → service  │
└──────────────────────────┘        JSON          │                              │
                                                  │  ┌──────────┐  ┌───────────┐ │
                                                  │  │ pool app │  │pool direct.│ │
                                                  │  └────┬─────┘  └─────┬─────┘ │
                                                  └───────┼──────────────┼───────┘
                                                          │ tables       │ vues v_direction_* uniquement
                                                  ┌───────▼──────────────▼───────┐
                                                  │          MySQL 8.0           │
                                                  │ users · demandes ·           │
                                                  │ reclamations · suggestions · │
                                                  │ commentaires · notifications │
                                                  │ audit_logs · questionnaire_* │
                                                  └──────────────────────────────┘
                                                          │
                                                  SMTP (nodemailer) → e-mails de notification
```

## 2. Modèle de confidentialité (le cœur du produit)

| Donnée                              | Employé (auteur) | RH  | Direction |
|-------------------------------------|:----------------:|:---:|:---------:|
| Contenu (objet, description)        | ✅ ses éléments  | ✅  | ✅ réclamations |
| Nom, prénom, e-mail, tél., matricule| ✅ lui-même      | ✅  | ❌ jamais |
| Service                             | ✅               | ✅  | ✅ sauf réclamation confidentielle |
| Département, site                   | ✅               | ✅  | ✅ |
| Commentaires / échanges RH          | ✅ ses éléments  | ✅  | ❌ |
| Pièces jointes                      | ✅ ses éléments  | ✅  | ❌ |

L'anonymisation est garantie à **trois niveaux** (défense en profondeur) :

1. **Base de données** — la Direction ne lit que les vues `v_direction_reclamations` et
   `v_direction_demandes`, qui ne contiennent physiquement aucune colonne d'identité.
   En production, un compte MySQL dédié (`workvoice_direction`) n'a le droit `SELECT`
   **que sur ces vues** (voir `database/02_views_security.sql`).
2. **API** — le module `direction` utilise un pool de connexions séparé (`directionPool`)
   et n'interroge que les vues. Aucun endpoint Direction ne renvoie de commentaire ni de pièce jointe.
3. **Frontend** — les écrans Direction n'ont aucun champ d'identité à afficher.

Règles complémentaires :
- Une réclamation **confidentielle** masque aussi le **service** côté Direction
  (dans un petit service, service + site suffiraient à ré-identifier la personne).
- La catégorie **Harcèlement** est **toujours** traitée comme confidentielle (forcé côté serveur).
- Les notifications envoyées à la Direction (réclamation critique) ne contiennent aucune identité.
- Chaque consultation d'une réclamation par un RH (donc de l'identité) est **journalisée**.

## 2 bis. Questionnaire de satisfaction du personnel (GRH-IFD-23)

Formulaire officiel bilingue FR/AR, 11 affirmations, échelle de 5 niveaux
(5 = « Tout à fait d'accord / Très satisfait(e) » … 1 = « Pas du tout d'accord »).

- **Campagnes** : le RH crée, ouvre et clôture une campagne (une seule ouverte à la fois) ; l'ouverture notifie tous les collaborateurs.
- **Anonymat par construction** : `questionnaire_participations` sait *qui* a participé (anti-doublon), `questionnaire_reponses`
  sait *ce qui* a été répondu, **sans `user_id`**. L'identifiant est un UUID aléatoire et la date est sans heure : aucune
  jointure ni tri ne permet de relier une réponse à une personne, même pour un administrateur de la base.
- **Seuil de confidentialité k = 5** : aucun résultat publié pour un périmètre (site, département) de moins de 5 réponses.
- **Indice de satisfaction 0–100** = moyenne des notes ramenée sur 100 ; la question 11 (« J'ai déjà pensé à quitter mon poste »),
  formulée négativement, est **inversée**. « % favorable » = part de réponses 4–5 (1–2 pour la question 11).
- Résultats visibles par le **RH** et la **Direction** ; seul le RH gère les campagnes.
- Les questions sont stockées en base (`questionnaire_questions`) : une nouvelle version du formulaire ne demande pas de redéveloppement.

## 2 ter. Congés, sorties, retards, fiche collaborateur enrichie

Trois workflows identiques (Collaborateur → RH → Validé/Refusé, avec une étape Brouillon pour
les congés) et des règles propres à chaque domaine :

- **Congés** : jours ouvrés calculés côté serveur (hors week-end et jours fériés configurables par
  le RH) ; solde décompté uniquement à la validation, jamais à la création ; chaque mouvement
  (initial, déduction, annulation, ajustement manuel) est historisé, jamais réécrit en place.
- **Sorties** : durée calculée automatiquement, cumul mensuel/annuel affiché au collaborateur.
- **Retards** : pièce jointe élargie au ZIP ; seuil d'alerte RH configurable (3, 5 ou 10).
- **Fiche collaborateur (Module 4)** : champs identité, administratif, contrat et paie ajoutés à
  `users`, visibles et modifiables **uniquement par le RH** (jamais par `/auth/me`, jamais par la
  Direction) — cohérent avec le modèle de confidentialité de la section 2.
- **Analyse IA** : alertes fondées sur des règles statistiques (seuils, fréquences, chevauchements),
  pas sur un modèle de langage — décrit ainsi à l'utilisateur pour rester honnête sur la mécanique.
- Migration additive pour les bases déjà installées : `database/05_migration_modules_rh.sql`,
  appliquée aussi automatiquement par l'API PHP (`api-php/lib/schema.php`, `SCHEMA_VERSION = 3`).

## 3. Rôles et routes

| Rôle        | Espace frontend | Préfixe API principal                     |
|-------------|-----------------|-------------------------------------------|
| *(tous)*    | `/employe/questionnaire` · `/rh/questionnaire` · `/direction/questionnaire` | `/api/questionnaire` |
| `EMPLOYE`   | `/employe`      | `/api/me`, `/api/demandes`, `/api/reclamations`, `/api/suggestions` |
| `RH`        | `/rh`           | `/api/rh` + actions de traitement sur les tickets |
| `DIRECTION` | `/direction`    | `/api/direction` (vues anonymisées)       |

Tout utilisateur authentifié peut déposer une demande / réclamation / suggestion (un RH ou un
directeur est aussi un collaborateur).

**Gestion des accès** : seul le RH crée les comptes (`/rh/collaborateurs`) et attribue le rôle.
Chaque compte créé ou réinitialisé reçoit un mot de passe provisoire, affiché une seule fois au RH, que le
collaborateur doit remplacer à sa première connexion (l'API refuse tout le reste tant que ce n'est pas fait).
Un compte désactivé perd l'accès immédiatement, car chaque requête revérifie le compte en base.

## 4. Cycle de vie d'un ticket

```
NOUVEAU ──▶ EN_COURS ──▶ EN_ATTENTE ──▶ RESOLU ──▶ CLOTURE
   │            ▲             │            │
   └────────────┴─────────────┘            └── réouverture possible par RH (date_cloture remise à NULL)
```

- `date_cloture` est renseignée au premier passage en `RESOLU` ou `CLOTURE`.
- Délai moyen de traitement = `AVG(date_cloture − date_creation)` en jours.
- Une réponse RH sur un ticket `NOUVEAU` le passe automatiquement `EN_COURS`.
- Numérotation atomique par année : `DEM-2026-0001`, `REC-2026-0154`, `SUG-2026-0007`
  (table `sequences` + `LAST_INSERT_ID(expr)`, sans condition de course).

## 5. Notifications

| Événement                          | Destinataires | Canal            |
|------------------------------------|---------------|------------------|
| Nouvelle demande / réclamation / suggestion | tous les RH actifs | in-app + e-mail |
| Réponse RH ajoutée                 | auteur        | in-app + e-mail  |
| Changement de statut               | auteur        | in-app + e-mail  |
| Réponse de l'auteur                | tous les RH   | in-app           |
| Réclamation `CRITIQUE`             | Direction (anonymisé) + RH | in-app + e-mail |

Les e-mails partent **après** le commit de la transaction et en mode *fire-and-forget* :
une panne SMTP ne bloque jamais l'enregistrement. Sans `SMTP_HOST`, les e-mails sont
affichés dans la console (mode développement).

## 6. Sécurité

| Exigence                   | Mise en œuvre |
|----------------------------|---------------|
| Hashage des mots de passe  | bcrypt (coût 12), comparaison à temps constant, hash factice si matricule inconnu |
| Authentification           | JWT HS256 (`iss=workvoice`, 8 h) dans un cookie `httpOnly`, `SameSite=Lax`, `Secure` en prod |
| Contrôle d'accès par rôle  | middleware `authorize(...roles)` + contrôle de propriété (404 plutôt que 403 pour ne pas révéler l'existence d'un ticket) |
| Révocation                 | chaque requête revérifie en base que le compte est actif et que le rôle n'a pas changé |
| Protection CSRF            | double-submit cookie (`wv_csrf` lisible + en-tête `X-CSRF-Token`, comparaison `timingSafeEqual`) |
| Validation des formulaires | zod côté API (source de vérité) + mêmes règles côté frontend |
| Journalisation             | table `audit_logs` : connexions (réussies/échouées), créations, réponses, statuts, consultations d'identité, téléchargements |
| Brute force                | `express-rate-limit` sur `/api/auth/login` (10 essais / 15 min / IP) |
| Uploads                    | 5 Mo max, liste blanche MIME + extension, nom aléatoire (UUID), stockage hors webroot, téléchargement contrôlé |
| En-têtes HTTP              | helmet, CORS restreint à `FRONTEND_URL` |
| Injection SQL              | requêtes paramétrées exclusivement ; les noms de tables viennent d'une constante interne |

## 7. Arborescence Backend

```
backend/
├── package.json
├── .env.example
├── scripts/
│   ├── generate-seed.js        # génère database/03_seed.sql (données de démo)
│   └── db-init.js              # exécute 01 → 02 → 03 sur la base configurée
├── uploads/                    # pièces jointes (hors webroot, ignoré par git)
└── src/
    ├── server.js               # démarrage HTTP + arrêt propre
    ├── app.js                  # assemblage Express (sécurité, routes, erreurs)
    ├── config/
    │   ├── env.js              # lecture/validation des variables d'environnement
    │   ├── db.js               # pools MySQL (app + direction), helper transaction
    │   └── constants.js        # rôles, statuts, types, catégories, libellés FR
    ├── middlewares/
    │   ├── auth.js             # authenticate (JWT) + authorize (RBAC)
    │   ├── csrf.js             # émission + vérification du jeton CSRF
    │   ├── validate.js         # validation zod (body / query / params)
    │   ├── upload.js           # multer sécurisé
    │   ├── rateLimit.js
    │   └── errorHandler.js     # format d'erreur JSON unique
    ├── utils/
    │   ├── httpError.js
    │   ├── numbering.js        # DEM-/REC-/SUG-AAAA-NNNN
    │   ├── audit.js
    │   └── pagination.js
    ├── services/
    │   ├── mailer.js
    │   └── notification.service.js
    └── modules/
        ├── auth/               # login, logout, me, mot de passe
        ├── me/                 # dashboard employé, profil, historique
        ├── tickets/            # logique commune demandes/réclamations/suggestions
        │   ├── tickets.config.js
        │   ├── tickets.service.js
        │   └── tickets.schemas.js
        ├── demandes/
        ├── reclamations/
        ├── suggestions/
        ├── rh/                 # dashboard + listes RH
        ├── direction/          # dashboard exécutif + stats (vues anonymisées)
        ├── questionnaire/      # satisfaction du personnel (GRH-IFD-23)
        └── notifications/
```

## 8. Arborescence Frontend (phases 3 à 6)

```
frontend/
├── next.config.ts              # rewrite /api/* → API (même origine → cookies first-party)
├── tailwind.config.ts          # palette Workman (bleu, jaune, gris)
├── components.json             # shadcn/ui
└── src/
    ├── middleware.ts           # redirection selon présence de session
    ├── app/
    │   ├── layout.tsx
    │   ├── login/page.tsx
    │   ├── (portal)/
    │   │   ├── layout.tsx      # shell : sidebar + topbar + cloche notifications
    │   │   ├── employe/
    │   │   │   ├── page.tsx                    # dashboard
    │   │   │   ├── demandes/nouvelle/page.tsx
    │   │   │   ├── reclamations/nouvelle/page.tsx
    │   │   │   ├── suggestions/nouvelle/page.tsx
    │   │   │   ├── historique/page.tsx
    │   │   │   ├── [kind]/[id]/page.tsx        # détail + fil d'échange
    │   │   │   └── profil/page.tsx
    │   │   ├── rh/
    │   │   │   ├── page.tsx                    # dashboard RH
    │   │   │   ├── demandes/page.tsx
    │   │   │   ├── reclamations/page.tsx
    │   │   │   ├── suggestions/page.tsx
    │   │   │   └── [kind]/[id]/page.tsx        # traitement : identité, réponse, statut
    │   │   └── direction/
    │   │       ├── page.tsx                    # dashboard exécutif + graphiques
    │   │       └── reclamations/
    │   │           ├── page.tsx
    │   │           └── [id]/page.tsx
    ├── components/
    │   ├── ui/                 # shadcn (button, card, input, select, badge, dialog, table…)
    │   ├── layout/             # Sidebar, Topbar, NotificationBell, RoleGuard
    │   ├── tickets/            # StatusBadge, UrgencyBadge, TicketTable, CommentThread, StatusSelect
    │   ├── dashboard/          # KpiCard, charts (Recharts)
    │   └── forms/              # DemandeForm, ReclamationForm, SuggestionForm
    ├── lib/
    │   ├── api.ts              # fetch + CSRF + gestion d'erreurs
    │   ├── auth.tsx            # AuthProvider / useAuth
    │   ├── constants.ts        # libellés FR (miroir de config/constants.js)
    │   └── validators.ts       # schémas zod partagés avec les formulaires
    └── types/index.ts
```

## 9. Choix d'architecture

- **Node.js / Express plutôt que Laravel** : un seul langage (JavaScript) sur toute la chaîne,
  schémas zod et constantes réutilisables entre API et frontend.
- **Cookie httpOnly plutôt que JWT en localStorage** : un script injecté (XSS) ne peut pas
  voler le jeton. Le prix à payer est la protection CSRF, assurée par double-submit.
- **Rewrite Next.js `/api` → API** : le navigateur ne voit qu'une origine, pas de CORS
  en production, cookies first-party.
- **Tickets génériques** : demandes, réclamations et suggestions partagent le même cycle de vie ;
  une configuration (`tickets.config.js`) évite de dupliquer trois fois la même logique.
- **Écarts assumés par rapport au cahier des charges** (tous additifs) :
  - `reclamations` : ajout de `confidentielle`, `date_cloture`, `date_maj` (nécessaires au
    périmètre fonctionnel et au calcul du temps moyen).
  - `commentaires` : `demande_id` **ou** `reclamation_id` **ou** `suggestion_id` (contrainte CHECK :
    exactement un), pour pouvoir répondre aussi aux réclamations et suggestions.
  - Tables ajoutées : `suggestions`, `notifications`, `audit_logs`, `sequences`, et les 5 tables `questionnaire_*`.
  - `users` : ajout de `actif`, `derniere_connexion`, `updated_at`.
  - `demandes` : ajout du nom d'origine et du type MIME de la pièce jointe.
