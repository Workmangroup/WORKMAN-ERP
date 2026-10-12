# Dossier de cadrage P003 — Backlog exécutable et traçabilité

Date : 12 octobre 2026. Statut : **livrable de cadrage**, sans modification de code ni de données.

## 1. Livrables et reproduction

| Fichier | Rôle |
|---|---|
| `BACKLOG.csv` | 181 éléments, une ligne par exigence : identifiant, partie, exigence, priorité/version de la matrice, constat, composant existant, écart, lot proposé, acteur, dépendances, estimation, responsable, expert, Given/When/Then, source |
| `BACKLOG.md` | Résumé généré : totaux, par lot, par constat, P0 hors V1, liaison avec le guide, contrôles |
| `PLAN_P003.md` | Ce dossier : doublons, experts, décisions, RACI, pilote, limites |
| `guide_mapping.tsv` | Liaison des 24 phases et des prompts du guide vers les identifiants du backlog |
| `enrichment_1..4.tsv` | Données saisies par lot : acteur, lot, dépendances, estimation, responsable, expert, Given/When/Then |
| `extract_matrix.mjs` | Extrait les 169 lignes de `docs/MATRICE_ECARTS_CDC.md` en suivant l'en-tête de chaque tableau |
| `build_backlog.mjs` | Assemble le backlog et contrôle la traçabilité (code de sortie 1 si anomalie) |

Reproduction : `cd docs/erp360/backlog && node build_backlog.mjs` (le CDC est lu depuis `CDC_PATH`, sinon depuis son emplacement local).

## 2. Contrôles exécutés et résultats

| Contrôle | Résultat |
|---|---|
| Extraction de la matrice | **169 lignes**, égal au total annoncé par la matrice |
| Réconciliation avec la synthèse de la matrice (sur ses 169 lignes, ligne ACC de regroupement incluse ; « Conforme (hors BAT) » compté avec les conformes) | Conforme 13, Partiel 79, Absent 58, Non vérifié 7, Non réalisé 12 : **identique** |
| Identifiants du CDC absents du backlog | **0** (126/126) ; les ACC-01…12 et EXT-001 sont ajoutés comme lignes individuelles |
| Identifiants en double | **0** |
| Acteur, responsable, lot, estimation, Given/When/Then vides ou incomplets | **0** |
| Dépendances vers un identifiant inexistant | **0** (deux erreurs saisies ont été corrigées pendant le lot) |
| P0 de la matrice non tracés | **0** ; 89 P0 au total |
| P0 non reliés au guide des prompts | **0** (une lacune trouvée, MTX-019, est corrigée dans `guide_mapping.tsv`) |
| Identifiants cités par le guide inexistants | **0** |

Résultat du générateur : `éléments=181 P0=89 cdc=126/126 erreurs=0 avertissements=0`, code de sortie 0.

Limite de ce contrôle : il vérifie la **cohérence** du backlog, pas la justesse des règles, des acteurs ou des estimations, qui doivent être validés par les responsables.

## 3. Répartition

- Lots proposés : **V1 111**, **V2 61**, **V3 7**, hors lot 2 (une ligne organisationnelle, une ligne « non nécessaire »).
- P0 : **V1 78**, **V2 9**, **V3 2**.
- Estimations en jours-personnes : somme de **1 420 pj** (V1), **1 355 pj** (V2), **195 pj** (V3). Ce sont des **hypothèses de l'auteur**, non validées. Elles ne constituent ni un budget ni un devis (CDC §12.5). Quatre éléments ne sont pas chiffrables : ils relèvent d'une décision ou d'une activité métier (MTX-001, MTX-025, ARC-J, NFR-09).

### P0 planifiés hors V1 (décision COPIL requise)

BI-01, BI-02, CON-06, PAY-01, PAY-02, PAY-03, PAY-04, RH-01, ACC-08 (V2) ; IA-02, ACC-09 (V3). Le cahier classe ces exigences P0 mais les place après la V1 : **le COPIL doit confirmer soit leur passage en V1, soit la dérogation** (CDC §12.8 : une réserve sur une capacité critique ne peut être masquée).

## 4. Doublons repérés

Aucun élément n'a été supprimé. Chaque doublon garde un **propriétaire** ; les autres lignes renvoient vers lui.

| # | Éléments qui se recoupent | Propriétaire proposé | Traitement |
|---|---|---|---|
| D1 | ORG-003, STK-05, FIN-11 (flux intersociétés) | ORG-003 | documents réciproques définis une seule fois |
| D2 | CON-06, PAY-03, RH-04 (pointage) | CON-06 | PAY-03 et RH-04 consomment le même flux |
| D3 | ADV-05, SAV-02, LOG-03 (retours) | ADV-05 (retour commercial) ; SAV-02 (réclamation) | séparer retour physique, décision et avoir |
| D4 | ORG-001, SEC-02, STK-07, NFR-07, ACC-04, IA-03 (isolation société/entrepôt) | SEC-02 | une seule règle ; les autres lignes sont des cas de test |
| D5 | MOB-01, MOB-02, POS-03, CRM-09, MTX-021 (hors ligne) | MOB-02 | un seul service de synchronisation |
| D6 | CRM-08, MTX-023 (portail client) | CRM-08 | même périmètre |
| D7 | MTX-024 (portail fournisseur) et ACH-03 (confirmation fournisseur) | ACH-03 | le portail n'est qu'un canal de ACH-03 |
| D8 | CRM-09, MTX-020, CRM-04 (commercial terrain) | CRM-09 | MTX-020 et CRM-04 sont des parcours de CRM-09 |
| D9 | MTX-021, STK-06, MOB-04 (entrepôt mobile) | STK-06 | MOB-04 porte l'ergonomie |
| D10 | MTX-015, MTX-017, FIN-08, SEC-03, ADV-03 (séparation des tâches, dérogations) | SEC-03 | règle unique ; les autres en sont les applications |
| D11 | MTX-002, FIN-10, CRM-02 (devises) | FIN-10 (taux et écarts) | CRM-02 ne porte que la devise de l'opportunité |
| D12 | MTX-004 et MTX-014 (recouvrement, relances) | MTX-004 (exigence) | MTX-014 est le scénario de workflow |
| D13 | MTX-007 à MTX-013 (workflows 8.2 à 8.10) et les exigences ADV-01, ACH-03/04, PRD-03/07, QUA-01/03, SAV-01/02, FIN-01/03 | les exigences | les workflows sont des **scénarios d'acceptation**, pas des développements séparés |
| D14 | BI-03, MTX-005 (copilote direction), MTX-022 (exécutif mobile), IA-01 | BI-03 (tableaux de bord) | le copilote et l'exécutif mobile consomment BI |
| D15 | MTX-006 (10 agents), IA-02, IA-05, API-03 | IA-05 (contrôle d'exécution) | mêmes garde-fous pour tous les agents |
| D16 | MIG-06 et ACC-11 (rollback) | MIG-06 | ACC-11 est la recette de MIG-06 |
| D17 | MTX-001 (conduite du changement) et ACC-10 (formation) | ACC-10 | ACC-10 est la recette de MTX-001 |
| D18 | MTX-029 (plan de tests) et ACC-01 | ACC-01 | le plan de tests est le moyen de ACC-01 |
| D19 | « Audit » (MTX-018) et les identifiants AUD-001…005 | — | **ambiguïté de nommage** : AUD désigne l'audit de l'existant, MTX-018 le journal d'audit. À renommer dans le cahier |

## 5. Experts nécessaires (non sollicités : leurs réponses ne sont pas inventées)

| Expert | Éléments concernés | Question à leur poser |
|---|---|---|
| Expert-comptable tunisien | FIN-01, FIN-03, FIN-05, FIN-10, MTX-002, ADV-04 | plan de comptes validé, règles de clôture et de réouverture, réévaluation, acomptes |
| Expert fiscal tunisien | FIN-02, FIN-06 | taux de TVA, retenues à la source, exonérations, déclarations, facturation électronique |
| Expert paie tunisienne (CNSS, IRPP) | PAY-01, PAY-02, PAY-04, ACC-08 | rubriques, barèmes, calendrier, cycle parallèle |
| Expert bancaire tunisien | CON-01, FIN-09 | formats d'échange réellement supportés, statuts de paiement |
| Expert qualité textile / EPI (normes) | QUA-01, QUA-04, BE-03 | plans de contrôle, tolérances, validité des certifications EN ISO 13688, EN 343, EN 14058, EN ISO 20471 ; la référence EN 13688 est à valider |
| Expert textile (collections, patronage, gammes) | BE-01, BE-02, BE-03, PRD-04, STK-06 | structure des collections, gammes, généalogie des rouleaux, intérêt de la RFID |
| Expert impression / broderie | BAT-01 | techniques, formats et contraintes de placement |
| Expert douane | LOG-03 | documents d'export validés par le responsable export |
| Juridique et DPO | MTX-019, CRM-06, CRM-07, RH-01, RH-04, CON-03 | durées de conservation, consentements, contrats, droit du travail, données médicales |
| Expert sécurité (fournisseur d'identité) | SEC-01 | choix du fournisseur SSO, MFA des comptes sensibles |
| Expert IA et statistiques | IA-02, IA-04, MTX-006 | jeux d'évaluation, référence naïve, seuils de gain |
| Expert consolidation | FIN-11 | périmètre de consolidation, méthode d'élimination |

Aucune de ces questions n'a de réponse dans le dépôt ni dans le cahier : elles sont des **points ouverts**.

## 6. Décisions nécessaires

| ID | Décision | Décideur | Bloque |
|---|---|---|---|
| D-01 | Périmètre V1 et choix du pilote | COPIL (sponsor, finance, opérations, commerce, RH, DSI) | tout planning |
| D-02 | Traitement des 11 P0 hors V1 (§3) | COPIL | planning V2/V3 |
| D-03 | Droit dédié à la gestion des sites (`warehouses.manage` ou `sites.manage`) | DSI | migration 0032 |
| D-04 | Hébergement et résidence des données | DSI, direction | ARC-G, ARC-J, NFR-01 |
| D-05 | Langues : français seul ou arabe/anglais | responsable métier | NFR-09 |
| D-06 | Fournisseur d'identité, MFA et SSO | DSI, lead sécurité | SEC-01 |
| D-07 | Seuils et délégations de séparation des tâches | DAF, DSI | SEC-03, MTX-015, MTX-017 |
| D-08 | Politique de conservation des données personnelles | DPO, juridique | MTX-019 |
| D-09 | Règles de libération qualité (qui libère, sous quelles conditions) | responsable qualité | QUA-03, ACH-04, LOG-01 |
| D-10 | Méthodes de sortie (FIFO, FEFO) et de valorisation | responsable stock, DAF | STK-03 |
| D-11 | Confirmation du backend Laravel (ADR-001) plutôt que NestJS | DSI | ARC-B, API-01 |
| D-12 | Validation des estimations par les responsables | responsables de domaine | toutes les estimations |
| D-13 | Nomination des responsables de domaine | direction, COPIL | colonne « responsable » |
| D-14 | Flux intersociétés et devise fonctionnelle de chaque société | DAF groupe | ORG-003, FIN-11 |

## 7. Responsables proposés (RACI, CDC §12.1)

Les rôles suivent le tableau de gouvernance du cahier. **Aucune personne n'est nommée** : les noms sont à confirmer (D-13).

| Type de décision | Exécution | Validation | Consultés |
|---|---|---|---|
| Périmètre et budget | Directeur programme | COPIL / sponsor | finance, métiers, DSI |
| Règles métier | Product owner | responsable de domaine | finance, qualité si impact |
| Données et mapping | lead data, stewards | propriétaires | métiers, finance |
| Architecture et sécurité | architecte, lead sécurité | DSI | exploitation, juridique |
| Recette métier | référents, QA | responsable métier | product owner |
| Bascule | programme, exploitation | COPIL sur avis métier et DSI | support, intégrateur |

Les responsables des éléments du backlog sont des **rôles** (ex. « Responsable ADV », « DAF », « Responsable qualité »). Le cahier demande de les nommer et de garder un propriétaire pour chaque module existant pendant la transition (§12.4).

## 8. Pilote : non choisi

Le guide demande de proposer un pilote selon la disponibilité des métiers, la représentativité et la qualité des données, sans déduire les activités d'une société de son nom. **Ces informations ne sont pas dans le dépôt** : la disponibilité des responsables, la représentativité des activités de chaque société et l'état des données réelles restent à fournir (OPEN-01, OPEN-02, AUD-003). Je ne propose donc aucun pilote.

## 9. Ce qui n'est pas produit dans ce lot (et pourquoi)

| Livrable du guide (phase 2) | Statut | Information manquante |
|---|---|---|
| RACI nommé | partiel (rôles seulement) | noms des responsables (D-13) |
| Planning 36 mois | non produit | dates, effectifs, disponibilités (CDC §12.4) |
| Budget révisable par lot | **non produit** | taux journaliers, coûts internes, matériel, réserve : non fournis. Le budget indicatif du cahier (1,73 à 3,26 MTND) n'est pas converti |
| Business case avec référence mesurée | non produit | aucune mesure de l'existant (temps de traitement, coûts) |
| Registre des décisions | partiel (§6) | validation par le COPIL |
| Dossier G0 | non produit | décisions D-01 et D-02 |

## 10. Passation

- État : P003 est un **cadrage en place**, vérifié par le générateur. Les estimations et responsables sont à valider (D-12, D-13).
- Prochaine action : obtenir D-01 (périmètre V1, pilote) et D-13 (nomination des responsables). Sans elles, le backlog ne peut pas être planifié.
- Les fichiers de ce lot ne sont pas encore commités.
