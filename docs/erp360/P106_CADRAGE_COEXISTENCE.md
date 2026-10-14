# P106 — ERP existants et coexistence : dossier de cadrage

Statut : **cadrage, aucune implémentation**. Le lot ne peut pas être livré sans les faits qui définissent la coexistence : quel ERP existant, quels objets, quelle source de vérité par objet, quels identifiants externes. Le dépôt ne les contient pas. Aucun code de connexion, aucune migration de coexistence, aucune donnée n'ont été créés.

## 1. Existant inspecté

| Élément | Constat | Preuve |
|---|---|---|
| Boîte d'événements | Existe : table `event_outbox`, clé d'idempotence unique par société, immuable ; consommateurs, livraisons, replay tracé. Réutilisable pour les flux sortants. | `supabase/migrations/0044_events_notifications.sql` ; `web/tests/sql/events_notifications.test.mjs` : **45 PASS, 0 FAIL** (dont « même clé : même événement, pas de doublon », « replay tracé dans l'audit ») |
| Import de référentiels | Existe : lots `import_batches` et lignes `import_rows`, reprise par clé, rejets motivés par ligne. Réutilisable pour les flux entrants. | `supabase/migrations/0042_imports_reference.sql` ; `web/tests/sql/imports_reference.test.mjs` : **52 PASS, 0 FAIL** (rejets « OWNER_NOT_FOUND », « IMPORT_DUPLICATE_IN_FILE ») |
| Mappings d'identifiants externes | **Absents**. Aucune table de correspondance entre identifiants d'un ERP externe et identifiants locaux. | Recherche `mapping` / `external` dans `supabase/migrations` : aucune table de correspondance |
| Source de vérité par objet | **Non décidée**. MIG-05 « Partiel », « Règle par objet à documenter ». | `docs/MATRICE_ECARTS_CDC.md` ligne 323 |
| Réconciliation par société | **Absente**. MIG-04 « Absent ». | `docs/MATRICE_ECARTS_CDC.md` (MIG-04) |
| Bascule et rollback | **Non réalisés**. MIG-06 « Non réalisé ». Feature flags : absents (MIG-02 « Partiel »). | `docs/MATRICE_ECARTS_CDC.md` (MIG-02, MIG-06) |
| Connecteurs existants | Un seul connecteur de réception est présent : transporteur, webhook signé (lot P-transport). Aucun connecteur d'ERP externe. | `web/src/lib/carrier/webhook.ts` ; `docs/MATRICE_ECARTS_CDC.md` (CON-05) |
| ERP existant | **Non identifié dans le dépôt** : ni nom, ni version, ni accès, ni schéma. | Aucun document ni configuration le décrit |

## 2. Blocages

1. **Identité de l'ERP existant** : nom, version, mode d'accès (API, export, base lue en lecture seule), propriétaire technique. Sans elle, aucun connecteur ni mapping réel ne peut être construit.
2. **Source de vérité par objet** (MIG-05) : pour chaque objet (clients, articles, commandes, factures, stock, comptes), le système qui fait foi pendant la coexistence. Décision du propriétaire, à consigner par écrit.
3. **Sens des flux et anti-boucle** : pour chaque objet, sens autorisé (entrant, sortant, bidirectionnel) et règle de non-rejeu. Une boucle existe dès qu'un événement créé par un système est réémis par l'autre.
4. **Identifiants externes** : clés fournies par l'ERP existant pour chaque objet, et règle de correspondance (clé unique, ou clé composite avec société).
5. **Périmètre de comptabilisation** : quels documents comptables restent dans l'ERP existant pendant la coexistence, pour éviter toute double comptabilisation. Décision comptable à valider par l'expert-comptable.
6. **Données de test** : un jeu anonymisé de l'ERP existant (OPEN-06, jamais en production) pour les preuves avant/après.

## 3. Proposition de conception (à valider, non implémentée)

- **Mappings** : table `external_mappings` (société, système externe, objet, identifiant externe, identifiant local, version de schéma, dates). Clé unique par société, système et identifiant externe. Historique : une correspondance n'est jamais écrasée ; une correction ajoute une ligne et ferme la précédente.
- **Source de vérité par objet** : table de règles versionnée et signée (objet, système faisant foi, sens autorisé, date d'effet). Une écriture entrante sur un objet dont la source est le système local est refusée.
- **Anti-boucle** : chaque événement porte l'origine (système émetteur) ; un événement dont l'origine est le système destinataire n'est jamais réémis. Clé d'idempotence réutilisée de `event_outbox`.
- **Versions de schéma** : registre des versions de schéma par système et par objet ; un message d'une version inconnue est rejeté et journalisé, pas interprété.
- **Journal des rejets** : réutilisation du modèle `import_rows` (ligne, code de motif, valeur), en ajout seul.
- **Coexistence sans double comptabilisation** : règle par objet ; les écritures comptables ne sont créées que pour les documents dont la source de vérité est le système local.

## 4. Décisions demandées au propriétaire

| # | Décision | Recommandation |
|---|---|---|
| D1 | Identité et mode d'accès de l'ERP existant | À fournir |
| D2 | Source de vérité par objet pendant la coexistence | À décider objet par objet ; ne pas inventer |
| D3 | Sens des flux et règle anti-boucle par objet | Une seule direction par objet dans une première phase |
| D4 | Clés d'identifiants externes | À fournir par l'ERP existant |
| D5 | Documents comptables restant dans l'ERP existant | Décision avec l'expert-comptable |
| D6 | Jeu de données anonymisé (OPEN-06) | À fournir |

## 5. Plan une fois D1 à D6 tranchées

1. Migration additive : mappings, règles de source de vérité versionnées et signées, registre des schémas, journal des rejets.
2. Services d'import et d'export entre l'ERP existant et le système local, sur la boîte d'événements et les lots d'import existants.
3. Écran de réconciliation par société et par objet (MIG-04), avec écarts visibles.
4. Tests : même événement jamais rejoué en boucle ; identifiants et historique conservés ; rejet d'un schéma inconnu ; écriture refusée hors source de vérité ; aucune double comptabilisation sur jeu anonymisé.

## 6. Preuves de ce cadrage

- `web/tests/sql/events_notifications.test.mjs` : 45 PASS, 0 FAIL (idempotence, replay visible).
- `web/tests/sql/imports_reference.test.mjs` : 52 PASS, 0 FAIL (rejets motivés, reprise).
- Recherche de mappings et d'ERP externe dans les migrations et les docs : aucun résultat.
- Aucun code modifié, aucune migration écrite pour P106.
