# Planning, budget et gouvernance — Lot P006 (WORKMAN ERP 360)

Date : 12 octobre 2026. Nature : **cadrage**. Aucun montant n'est inventé, aucune date n'est engagée. Les estimations en jours-personnes sont des **hypothèses** de l'auteur, à valider (D-P006-06). Le contrôle chiffré est dans `PLANNING_CHECKS.md`, reproduit par `build_planning.mjs`.

## 1. Ce qui a été contrôlé

| Contrôle | Résultat |
|---|---|
| Budget CDC §12.5 : arithmétique (réalisation, réserve, enveloppe) | **conforme** : 1 290 / 2 420 ; réserve 258 / 484 ; enveloppe 1 728 / 3 264 (k TND HT) |
| Dépendances du backlog : cycles | **0** après correction de 16 dépendances (journal : `dependency-corrections.json`) |
| Dépendances du backlog : cibles inconnues | **0** |
| Dépendances vers un lot ultérieur | **3** (BAT-01, BAT-04, ACC-06 vers PRD-03) : décision D-P006-01 |
| Priorités et versions du CDC face au backlog (36 identifiants qui en portent) | **0 écart** |
| Identifiants du CDC sans priorité ni version (67) | lot **proposé**, non déclaré par le CDC (D-P006-04) |
| Capacité de l'équipe cœur face à la charge V1 / V2 / V3 | tient en capacité basse pour les trois fenêtres (157,8 / 112,9 / 16,3 jours-personnes par mois, contre 178,5 de capacité basse) |
| Chemin critique du backlog | **225 jours-personnes** : MTX-023 → CRM-08 → ADV-04 → ADV-01 → CRM-05 → CRM-02 → FIN-10 → MTX-002 → FIN-02 → FIN-01 → ORG-001 (détail dans PLANNING_CHECKS.md) |

Limite de la capacité : 21 jours ouvrés par mois et une équipe cœur de 8,5 à 13 ETP (CDC §12.4) sont des **hypothèses** ; la charge exclut l'audit M1–M3, la recette et les métiers.

Lecture du chemin critique : 225 jours-personnes de travail en séquence représentent au moins plusieurs mois, même avec parallélisation, puisque chaque élément d'un chemin doit être fini avant le suivant. Ce n'est pas une durée calendaire.

## 2. Découpage 36 mois en lots et gates

Le découpage suit la roadmap du CDC (§12.3). Les jours-personnes viennent du backlog P003 par lot de version.

| Fenêtre CDC | Lot de version | Jours-personnes (hypothèses) | Gate CDC | Critères de sortie | État |
|---|---|---:|---|---|---|
| M1–M3 | (audit) | non chiffré dans le backlog | **G0** périmètre | inventaire, écarts, business case, cible, migration | inventaire et backlog faits (P001, P003) ; business case, pilote et budget révisé **non faits** (données manquantes) |
| M4–M6 | V1 (socle) | part de V1 | **G1** architecture et sécurité | sociétés, droits, référentiels, dictionnaire, tests de référence | non commencé (ORG, SEC, DAT surtout absents) ; référence de non-régression faite (P005) |
| M7–M9 | V1 | part de V1 | (pas de gate CDC ; « chaîne bout en bout, migration répétée ») | CRM/ADV, achat/stock, BAT, finance, BI initial | à faire |
| M10–M12 | V1 | part de V1 | **G2** V1 acceptée | ACC-01 à ACC-12 (V1) ; bénéfices de référence | à faire |
| M13–M15 | V2 (BE, qualité) | part de V2 | gate données (CDC) | produit approuvé, OF pilote, données | à faire |
| M16–M18 | V2 (production) | part de V2 | (pas de gate CDC) | lots et atelier testés, pilote industriel | à faire |
| M19–M21 | V2 (RH, paie, POS, portails) | part de V2 | gate confidentialité (CDC) | paie réconciliée, caisse, portails | à faire ; **paie : expert requis** |
| M22–M24 | V2 (intersociétés) | part de V2 | **G3** V2 | clôture multi-sociétés, stabilisation | à faire |
| M25–M27 | V3 (BI, IA) | part de V3 | gate IA (CDC) | évaluations, droits | à faire |
| M28–M30 | V3 (agents) | part de V3 | (pas de gate CDC) | résultats mesurés | à faire |
| M31–M33 | V3 (RFID, optimisation) | part de V3 | (pas de gate CDC) | gains vérifiés, tests adverses | à faire |
| M34–M36 | (transfert) | non chiffré | **G4** réception | audit final, PRA, réversibilité, bilan ROI | à faire |

Décalage à signaler : le CDC place la **BI initiale en V1 (M7–M9)** alors que le backlog place BI-01 et BI-02 (P0) en V2 : décision D-P006-03.

Un gate ne se franchit pas parce que sa date est atteinte (CDC §12.3) : les dates sont des fenêtres, pas des engagements.

## 3. Budget : séparation des postes (sans double comptage)

| Poste | Bas | Haut | Inclus dans | Remarque |
|---|---:|---:|---|---|
| Réalisation (8 postes du CDC) | 1 290 | 2 420 | budget | comprend l'équipe de livraison : **les jours-personnes du backlog en font partie, ils ne s'ajoutent pas une seconde fois** |
| Réserve 20 % de la réalisation | 258 | 484 | budget | calculée uniquement sur la réalisation |
| Exploitation, cloud, licences (36 mois) | 180 | 360 | budget | séparée de la réalisation |
| **Enveloppe 36 mois** | **1 728** | **3 264** | | somme vérifiée |
| Matériel (scanners, RFID, réseau) | exclu | exclu | hors enveloppe | à chiffrer séparément |
| Coûts internes (référents, masse salariale des utilisateurs) | exclu | exclu | TCO séparé | non chiffrés |
| Maintenance après M36 | 180 / an | 320 / an | hors enveloppe | ne s'ajoute pas aux 36 mois |

Contrôle de cohérence : 1 290 k TND rapporté à 2 970 jours-personnes du backlog donne environ **434 TND par jour-personne** (haut : 815). Ce chiffre n'est **pas un taux** : il sert seulement à confronter le budget aux taux réels, qui ne sont pas fournis (D-P006-04).

**Omission connue** : les jours-personnes du backlog ne couvrent pas l'**encapsulation des 26 autres modules derrière l'API** (ADR-003), ni l'audit de l'existant au-delà de AUD-001 à 005. Si cette encapsulation n'est pas dans le budget de réalisation, le budget est sous-estimé : décision D-P006-02.

## 4. Lots : contenu, dépendances, risques

| Lot | Éléments | Jours-personnes | Dépendances critiques | Risque principal |
|---|---:|---:|---|---|
| V1 | 111 | 1 420 | chemin critique CRM-02 → FIN-10 → MTX-002 → FIN-02 → FIN-01 → ORG-001 ; ADV-01 → STK-05 ; QUA-03 → ACH-04 | experts fiscal et comptable non disponibles (FIN-02, FIN-06) |
| V2 | 61 | 1 355 | PRD-03 ← BE-02 ← BE-01 ; PAY-01 ← RH-01 | paie : expert requis, cycles parallèles (PAY-04) |
| V3 | 7 | 195 | IA-02 ← IA-01 ; MTX-006 ← IA-05 | évaluations IA non définies |

Les 3 conflits V1 → V2 (BAT-01, BAT-04, ACC-06 vers PRD-03) sont réels : la personnalisation (BAT) demande des nomenclatures et gammes figées (PRD-03). Options : avancer la figure des versions (PRD-03, partie figement) en V1, ou reporter BAT-01 et BAT-04 en V2. **Décision D-P006-01**, pas un choix de ma part.

## 5. Pilote

**Non choisi.** Le pilote doit reposer sur la disponibilité des métiers, la représentativité et la qualité des données (CDC §12.7). Ces informations ne sont pas dans le dépôt. Les activités d'une société ne se déduisent pas de son nom.

Critères à évaluer pour chaque candidat : disponibilité des responsables (10 à 20 % de leur temps, §12.4), données réelles accessibles et anonymisables (AUD-003), volume d'opérations représentatif, support disponible. **Décision D-01.**

## 6. RACI (rôles, CDC §12.1)

Repris de `docs/erp360/backlog/PLAN_P003.md` §7. Les personnes ne sont pas nommées (D-13).

| Décision | Exécution | Validation | Consultés |
|---|---|---|---|
| Périmètre et budget | directeur programme | COPIL, sponsor | finance, métiers, DSI |
| Règles métier | product owner | responsable de domaine | finance, qualité si impact |
| Données et mapping | lead data, stewards | propriétaires | métiers, finance |
| Architecture et sécurité | architecte, lead sécurité | DSI | exploitation, juridique |
| Recette métier | référents, QA | responsable métier | product owner |
| Bascule | programme, exploitation | COPIL sur avis métier et DSI | support, intégrateur |

Cadence (CDC §12.1) : COPIL mensuel (sponsor, finance, opérations, commerce, RH, DSI, directeur programme) ; comité opérationnel hebdomadaire ; comité architecture et sécurité pour les décisions structurantes et les exceptions.

## 7. Risques

| ID | Risque | Probabilité / impact | Propriétaire proposé | Traitement |
|---|---|---|---|---|
| R1 | Experts (fiscal, paie, comptable) non disponibles dans les délais | élevée / élevé | DAF | engager les experts avant M4 ; sans eux, FIN-02, FIN-06 et PAY-* ne démarrent pas |
| R2 | Décisions COPIL en retard (D-01, D-02) | élevée / élevé | directeur programme | calendrier de décision avant G0 |
| R3 | Disponibilité des métiers non confirmée (10–20 %) | élevée / élevé | sponsor | engagement écrit des responsables |
| R4 | Estimations en jours-personnes non validées | élevée / élevé | product owner | validation par domaine (D-P006-06) |
| R5 | Taux journaliers inconnus : budget non convertible | certaine / moyen | DAF | obtenir les taux (interne et prestataires) |
| R6 | Encapsulation des 26 modules non estimée | moyenne / élevé | architecte | décision D-P006-02 |
| R7 | Cycle `auth` ↔ `rbac` non traité avant les chantiers de droits | moyenne / élevé | lead sécurité | décision D-P004-01 avant G1 |
| R8 | Données de production inconnues (volumes, qualité) | élevée / élevé | lead data | AUD-003 en lecture seule |
| R9 | Sauvegardes et restauration non testées (MIG-01, NFR-04) | moyenne / élevé | DSI | test de restauration avant tout changement |
| R10 | Authentification sans MFA ni SSO (SEC-01, P0) | certaine / élevé | lead sécurité | décision D-06 |
| R11 | Défauts existants (quarantaine non bloquante, devis non revalidé) | certaine / moyen | responsable qualité, ADV | corriger dans les lots V1 (voir SCENARIOS.md) |

## 8. Décisions

Registre complet : `backlog/PLAN_P003.md` §6 (D-01 à D-14). Ajoutées par P006 :

| ID | Décision | Décideur | Bloque |
|---|---|---|---|
| D-P006-01 | Conflit BAT / ACC-06 vers PRD-03 : avancer le figement des versions ou reporter BAT | COPIL, responsable production | planning V1 |
| D-P006-02 | Inclure ou non l'encapsulation des 26 modules dans le budget de réalisation | COPIL, DSI | budget |
| D-P006-03 | BI initiale : V1 (CDC) ou V2 (backlog) | COPIL, DSI | planning BI |
| D-P006-04 | Lots proposés pour les 67 identifiants sans priorité dans le CDC ; taux journaliers | COPIL ; DAF | planning, budget |
| D-P006-05 | Valider les 16 corrections de dépendances (`dependency-corrections.json`) | product owner | backlog |
| D-P006-06 | Valider les jours-personnes par domaine et l'hypothèse de capacité (21 jours, équipe cœur) | responsables de domaine, directeur programme | planning |

## 9. Règles de changement

1. Tout changement de lot, de gate, d'estimation, de budget ou de périmètre fait l'objet d'une **demande** indiquant son impact sur le coût, le délai et le risque, puis d'une **décision du COPIL** (CDC §12.1).
2. Aucune exigence n'est supprimée : une exigence abandonnée est marquée, datée et justifiée.
3. Toute correction de dépendance est **journalisée** avec l'ancienne valeur (`dependency-corrections.json`). `apply-dep-fixes.mjs` refuse la correction si la valeur a changé entre-temps.
4. Les estimations sont révisées après l'audit (CDC §12.5) ; chaque révision du budget reçoit un numéro de version.
5. Le budget n'affiche aucun montant sans taux documenté ; un poste exclu reste visible avec la mention « exclu ».
6. Chaque gate a un propriétaire, des critères mesurables et une décision écrite ; il ne se franchit pas à date fixe.

## 10. Limites

- Aucune date calendaire n'est engagée : les fenêtres sont celles du CDC.
- Pas de budget révisé, pas de business case mesuré, pas de dossier G0 : ils demandent des données absentes.
- Les jours-personnes sont des hypothèses non validées ; le backlog ne couvre pas tout (encapsulation des modules, audit complémentaire, recette).
- Le contrôle de capacité suppose 21 jours ouvrés par mois et une équipe cœur indicative.

## 11. Passation

- Fichiers : `PLANNING_P006.md`, `PLANNING_CHECKS.md` (généré), `build_planning.mjs`, `apply-dep-fixes.mjs`, `dependency-corrections.json`.
- Modifications du backlog : 16 dépendances corrigées (listées, anciennes valeurs conservées) ; aucune exigence, aucun lot ni aucune estimation modifiés.
- Prochaine action : obtenir D-01 (pilote et périmètre V1), D-P006-01 (conflit PRD-03) et les taux journaliers (D-P006-04).
