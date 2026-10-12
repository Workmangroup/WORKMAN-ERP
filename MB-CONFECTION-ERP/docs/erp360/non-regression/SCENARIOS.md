# Scénarios de non-régression métier — Lot P005

Date : 12 octobre 2026. Nature : **référence de comportement actuel**. Les scénarios décrivent ce que le système fait aujourd'hui quand il est juste, et ce que le cahier exige. Un défaut connu est marqué **Défaut** : il n'est jamais présenté comme cible.

## 1. Périmètre et limites de la preuve

- Les données utilisées sont **les données locales de développement** (9 clients, 3 factures, 7 écritures, 10 entrepôts). Ce ne sont **ni une copie de production, ni une copie anonymisée autorisée**. Les résultats chiffrés ne représentent donc pas l'activité réelle.
- Les preuves sont les **suites de tests existantes** (PGlite en mémoire, 1 808 contrôles SQL et 168 unitaires) et les contrôles de l'API (41 smoke). Elles sont rejouées par `scripts/non-regression.sh`.
- Une preuve marquée « rejouée au lot précédent » n'a pas été relancée dans ce lot.
- **Attendus signés** : aucun attendu finance ou paie n'est signé. La signature est un acte du DAF et du responsable paie ; elle est demandée en section 5.

## 2. Scénarios obligatoires du cahier (CDC §12.9)

| # | Scénario | Statut | Preuve | Commentaire |
|---|---|---|---|---|
| 1 | Dernière quantité réservée simultanément | **Vérifié** (lot précédent) | `web/tests/concurrency/reserve-concurrency.sh` : refus de la survente sur deux connexions réelles | rejoué au lot précédent sur la base locale ; non relancé ici pour ne pas écrire de mouvements supplémentaires |
| 2 | Commande mobile retransmise | **Non implémenté** | — | mobile hors ligne absent (MOB-01, MOB-02) |
| 3 | Webhook de paiement répété | **Non implémenté** | — | connecteur paiement absent (CON-07) |
| 4 | Facture en période close | **Vérifié** | `web/tests/sql/general-ledger.test.mjs` : « période clôturée : nouvelle facture refusée » | |
| 5 | Accord après changement de montant | **Défaut** (non implémenté) | — | les devis versionnés et la revalidation après modification sont partiels (CRM-05) |
| 6 | A demande le stock de B | **Vérifié** | `web/tests/sql/stock.test.mjs` : `WAREHOUSE_FORBIDDEN` | |
| 7 | BAT modifié | **Partiel** | `web/tests/sql/development.test.mjs` : « BAT v2 (le BAT se resoumet à l'étape Validation client) » | vérifié pour la validation client en développement ; **le BAT de personnalisation est absent** (BAT-01 à BAT-04) |
| 8 | Lot bloqué en picking | **Défaut** | `web/tests/sql/quality.test.mjs` : « Lot 12 mis en quarantaine » | la quarantaine est enregistrée mais **ne bloque pas le picking** (QUA-03, matrice : partiel) |
| 9 | Instruction malveillante dans un PDF lu par l'IA | **Non implémenté** | — | le copilote fonctionne par règles ; aucun agent ne lit de PDF (IA-02, IA-05) |
| 10 | Rollback après nouvelles transactions | **Non implémenté** | — | MIG-06 non réalisé |

Bilan : **4 vérifiés** (1, 4, 6, 7 partiel), **2 défauts** (5, 8), **4 non implémentés** (2, 3, 9, 10). Aucun n'est présenté comme réussi s'il ne l'est pas.

## 3. Scénarios métier actuellement couverts

| ID | Scénario | Attendu | Preuve | Statut |
|---|---|---|---|---|
| FIN-S01 | Écritures comptables équilibrées | total débit = total crédit | `general-ledger.test.mjs` ; snapshot local : 63 990,00 = 63 990,00 | Vérifié |
| FIN-S02 | Clôture refusée tant qu'une écriture est en brouillon | refus | `general-ledger.test.mjs` : « clôture : refusée tant qu'une écriture est en brouillon » | Vérifié |
| FIN-S03 | Période clôturée : pas de nouvelle facture | refus | `general-ledger.test.mjs` | Vérifié (= scénario 4) |
| FIN-S04 | Correction par avoir, sans effacement | avoir créé, facture conservée | `general-ledger.test.mjs`, `commercial.test.mjs` (avoirs) | Vérifié |
| FIN-S05 | TVA lue par date d'effet ; taux absent bloquant | refus si taux manquant | `fiscal-rate.test.mjs` (`VAT_RATE_MISSING`) | Vérifié |
| FIN-S06 | Devise : taux figé sur la facture | montant et taux conservés | `multicurrency.test.mjs` | Vérifié |
| FIN-S07 | Paie : calcul et bulletins | — | aucun module | **Non implémenté** (PAY-01 à PAY-04) |
| STK-S01 | Ajustement négatif au-delà du stock refusé | refus | `stock.test.mjs` : « ajustement négatif au-delà du stock refusé » | Vérifié |
| STK-S02 | Comptage négatif refusé | refus | `stock.test.mjs` : « comptage négatif refusé » | Vérifié |
| STK-S03 | Picking réserve le stock | réservation | `shipping.test.mjs` : « Picking : réservation du stock » | Vérifié |
| STK-S04 | Zone d'un autre entrepôt refusée | refus `WAREHOUSE_ZONE_MISMATCH` | `warehouses.test.mjs` | Vérifié |
| STK-S05 | Dernier responsable d'entrepôt non supprimable | refus | `warehouses.test.mjs` : « dernier responsable » | Vérifié |
| VTE-S01 | Devis expiré refusé | refus `QUOTE_EXPIRED` | `commercial.test.mjs` | Vérifié |
| VTE-S02 | Devis sur prospect non converti refusé | refus `QUOTE_PROSPECT_NOT_CONVERTED` | `commercial.test.mjs` : « Devis sur prospect » | Vérifié |
| QUA-S01 | Clôture de non-conformité avec action vérifiée | NC fermée | `quality.test.mjs` : « clôture NC : action vérifiée efficace » | Vérifié |
| QUA-S02 | Clôture de non-conformité refusée si action non vérifiée | refus | `quality.test.mjs` : « clôture NC refusée » | Vérifié |
| ART-S01 | Version verrouillée non modifiable | refus `VERSION_LOCKED` | `articles.test.mjs` | Vérifié |
| GED-S01 | Version de document immuable | refus `VERSION_IMMUTABLE` | `ged.test.mjs` | Vérifié |
| SEC-S01 | Accès API sans jeton | 401 | `api/tests/smoke/clients.sh` | Vérifié |
| SEC-S02 | Fiche client invisible sans droit | 404, pas de fuite | `api/tests/smoke/clients.sh` (41 contrôles) | Vérifié |
| SEC-S03 | Contact et adresse supprimés sans droit | 404 | `api/tests/smoke/clients.sh` | Vérifié |
| SEC-S04 | Refus par défaut pour `anon` sur les sites | refus | migration 0032, test en transaction annulée (8 contrôles) | Vérifié au lot 0032 |
| API-S01 | Suppression d'un client actif refusée | `CLIENT_NOT_ARCHIVED` | `api/tests/smoke/clients.sh` | Vérifié |
| DEF-01 | Client sans droit reçoit 404 au lieu de 403 sur la modification | — | voir smoke | Comportement volontaire (pas de fuite), **non un défaut** |

## 4. Défauts connus (non cibles)

| ID | Défaut | Impact | Référence |
|---|---|---|---|
| DEF-A | Quarantaine n'empêche pas le picking ni l'expédition | risque d'expédier un lot bloqué | matrice QUA-03, scénario 8 |
| DEF-B | Devis modifié après acceptance sans nouvelle version ni revalidation | engagement client non revalidé | matrice CRM-05, scénario 5 |
| DEF-C | Frontend lit et écrit la base directement (544 `.from`, 171 `.rpc`) | contournement possible de la logique API | INVENTAIRE_P001 |
| DEF-D | Aucune tâche planifiée (relances, réconciliations, sauvegardes) | processus non automatisés | INVENTAIRE_P001 |
| DEF-E | Test PHP par défaut en échec | pas de tests API métier | INVENTAIRE_P001 §6 |
| DEF-F | Matrice annonce 1 769 tests SQL, réel 1 808 | documentation à corriger | INVENTAIRE_P001 §6 |

Ces défauts sont des **points à corriger** : leur comportement actuel n'est pas figé comme attendu.

## 5. Attendus finance et paie : à signer

| Attendu | Signataire attendu | Statut de signature |
|---|---|---|
| FIN-S01 à FIN-S06 (écritures, clôture, avoirs, TVA, devise) | DAF et expert-comptable tunisien | **non signé** |
| FIN-S05 : taux de TVA et règles d'exonération | expert fiscal tunisien | **non signé** (FIN-02) |
| FIN-S07 et PAY-01 à PAY-04 : paie | responsable paie et expert paie tunisien | **non applicable** : paie non implémentée |
| DEF-A (quarantaine) et QUA-S01/S02 | responsable qualité | **non signé** |

Aucun succès finance ou paie n'est déclaré sans signature. Les scénarios FIN restent des **preuves techniques**, à valider par les signataires.

## 6. Reproduction

- Tests : `bash scripts/non-regression.sh` rejoue les suites et compare à `docs/erp360/non-regression/baseline.json`.
- Photographie des totaux locaux : `docs/erp360/non-regression/snapshot-local.json` (lecture seule, données de développement).
- Concurrence stock : `web/tests/concurrency/reserve-concurrency.sh` (base locale, écrit des mouvements de test : à lancer sur base de test seulement).
