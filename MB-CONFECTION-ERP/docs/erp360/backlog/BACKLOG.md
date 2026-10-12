# BACKLOG exécutable — WORKMAN ERP 360 (lot P003)

Généré par `build_backlog.mjs` à partir de la matrice d'écarts et des fichiers `enrichment_*.tsv`. Ne pas modifier à la main : éditer les sources puis relancer le script.

## Résumé

- Éléments : **181** (168 lignes de la matrice, 12 critères d'acceptation ACC-01…ACC-12, 1 user story EXT-001 hors matrice).
- Exigences P0 tracées : **89** (aucune exigence P0 de la matrice absente).
- Identifiants du CDC couverts : **126 / 126**.
- Estimations non chiffrables (organisationnelles) : 4.

### Par lot proposé

| Lot | Éléments | Somme des estimations (pj, hypothèse) |
|---|---:|---:|
| V1 | 111 | 1420 |
| V2 | 61 | 1355 |
| V3 | 7 | 195 |
| hors lot (non nécessaire) | 1 | n/c |
| hors lot (organisationnel) | 1 | n/c |

### Par constat de la matrice

| Statut | Éléments |
|---|---:|
| Absent | 59 |
| Conforme | 12 |
| Conforme (hors BAT) | 1 |
| Non réalisé | 23 |
| Non vérifié | 7 |
| Partiel | 79 |

### P0 planifiés hors V1 (décision COPIL requise)

- BI-01 (V2) : Modèle sémantique certifié, entrepôt BI séparé de la production
- BI-02 (V2) : Dictionnaire KPI : formule, grain, source, propriétaire
- CON-06 (V2) : Pointage
- IA-02 (V3) : Au moins 30 cas métier par agent, cas adverses
- PAY-01 (V2) : Rubriques de paie versionnées (CNSS, IRPP)
- PAY-02 (V2) : Cycle de paie : collecte, simulation, validation, bulletins
- PAY-03 (V2) : Contrats, pointage, coordonnées de paiement
- PAY-04 (V2) : Deux cycles parallèles avec la solution actuelle
- RH-01 (V2) : Dossier employé : matricule, contrat, affectation, accès restreint
- ACC-08 (V2) : Paie parallèle validée
- ACC-09 (V3) : IA sans fuite ni action critique autonome

### Liaison avec le guide des prompts

| Phase ou prompt | Référence CDC | Identifiants reliés |
|---|---|---:|
| Phase 1 Audit | CDC parties 1 2 3 9 10 | 19 |
| Phase 2 Cadrage et backlog | CDC parties 1 et 12 | 21 |
| Phase 3 Architecture et migration | CDC parties 2 et 10 | 13 |
| Phase 4 Socle multi sociétés et permissions | CDC parties 1 9 et 10 | 13 |
| Phase 5 Référentiels et qualité des données | CDC partie 10 | 6 |
| Phase 6 Moteur de validation et contrats API | CDC parties 2 8 et 10 | 9 |
| Phase 7 CRM et pipeline | CDC partie 3 section 3.1 | 11 |
| Phase 8 ADV et BAT | CDC partie 3 sections 3.2 et 3.6 | 11 |
| Phase 9 Achats | CDC partie 3 section 3.3 | 8 |
| Phase 10 Stocks et traçabilité | CDC partie 3 section 3.4 | 9 |
| Phase 11 Finance initiale et pilotage V1 | CDC parties 4 et 7 | 12 |
| Phase 12 Recette et pilote V1 | CDC parties 10 et 12 | 13 |
| Phase 13 Conception produits | CDC partie 3 section 3.5 | 5 |
| Phase 14 Production et sous-traitance | CDC partie 3 section 3.7 | 7 |
| Phase 15 Qualité, logistique, SAV | CDC partie 3 sections 3.8 à 3.10 | 13 |
| Phase 16 RH et paie tunisienne | CDC partie 5 | 11 |
| Phase 17 POS | CDC partie 3 section 3.11 | 4 |
| Phase 18 Mobiles et portails | CDC parties 3 et 11 | 11 |
| Phase 19 Contrôle de gestion et V2 | CDC parties 4 et 12 | 7 |
| Phase 20 BI et Workman Insight | CDC partie 7 | 5 |
| Phase 21 Socle IA et copilotes | CDC partie 6 | 5 |
| Phase 22 Agents métiers et recouvrement | CDC partie 6 | 4 |
| Phase 23 Optimisation et RFID | CDC parties 3 6 et 12 | 3 |
| Phase 24 Réception finale et transfert | CDC partie 12 | 6 |
| Prompt maître | toutes sessions | 6 |
| Prompt : petit lot de réalisation | toutes phases | 3 |
| Prompt : reprise de session | toutes phases | 2 |
| Prompt : correction de régression | toutes phases | 3 |
| Prompt : contrôle de lot avant réception | toutes phases | 3 |
| Prompt : migration sans lancement | toutes phases | 7 |
| Prompt : passation de fin de session | toutes phases | 3 |

## Avertissements

- Les estimations en jours-personnes sont **des hypothèses de l'auteur**, non validées par les responsables (CDC §12.4).
- Les responsables sont des **rôles**, non des personnes : ils doivent être nommés (CDC §12.1).
- Les lots V1/V2/V3 sont **proposés** ; le planning et les gates sont à valider par le COPIL.

## Contrôles

Aucune anomalie : identifiants uniques, acteur/responsable/lot/estimation/Given-When-Then présents, dépendances valides, 126/126 identifiants CDC couverts, aucun P0 non tracé.

