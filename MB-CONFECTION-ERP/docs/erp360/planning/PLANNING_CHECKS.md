# Contrôles du planning et du budget (P006)

Généré par `build_planning.mjs`. Sources : `docs/erp360/backlog/BACKLOG.csv` (P003) et CDC §12.4–12.5. Aucun montant n’est inventé.

## 1. Charge par lot (jours-personnes, hypothèses P003)

| Lot | Éléments | Jours-personnes | Éléments non chiffrés |
|---|---:|---:|---:|
| V1 | 111 | 1420 | 9 |
| V2 | 61 | 1355 | 4 |
| hors lot | 2 | 0 | 2 |
| V3 | 7 | 195 | 0 |
| **Total** | 181 | **2970** | |

## 2. Capacité de l’équipe cœur (CDC §12.4 ; 21 jours par mois : hypothèse)

Équipe cœur : 8.5 à 13 ETP, soit 178.5 à 273 jours-personnes par mois.

| Fenêtre | Lot | Jours-personnes | Par mois | Tient dans la capacité basse ? | Tient dans la capacité haute ? |
|---|---|---:|---:|---|---|
| M4–M12 | V1 | 1420 | 157.8 | oui | oui |
| M13–M24 | V2 | 1355 | 112.9 | oui | oui |
| M25–M36 | V3 | 195 | 16.3 | oui | oui |

Limites : la charge exclut l’audit M1–M3, les activités métiers (10–20 % du temps, CDC §12.4) et la recette ; elle ne porte que sur le backlog P003.

## 3. Dépendances

- Cycles de dépendances : **0**
- Dépendances vers un lot ultérieur (conflits de planning, à décider) : **3**
  - BAT-01 (V1) dépend de PRD-03 (V2)
  - BAT-04 (V1) dépend de PRD-03 (V2)
  - ACC-06 (V1) dépend de PRD-03 (V2)
- Chemin critique (jours-personnes cumulés le long des dépendances) : **225 pj** ; chemin : MTX-023 → CRM-08 → ADV-04 → ADV-01 → CRM-05 → CRM-02 → FIN-10 → MTX-002 → FIN-02 → FIN-01 → ORG-001

## 4. Budget CDC §12.5 (k TND HT) : arithmétique et séparation

| Poste | Bas | Haut |
|---|---:|---:|
| Audit/conception | 100 | 180 |
| Conservation/remédiation/socle | 180 | 320 |
| Modules métier | 450 | 850 |
| Data/intégrations | 120 | 240 |
| Mobiles/portails | 120 | 220 |
| BI/IA | 150 | 300 |
| QA/sécurité/résilience | 90 | 160 |
| Formation/déploiement | 80 | 150 |
| **Sous-total réalisation** | **1290** | **2420** |
| Réserve 20 % de la réalisation | 258 | 484 |
| Exploitation, cloud, licences 36 mois | 180 | 360 |
| **Enveloppe totale 36 mois** | **1728** | **3264** |
| Matériel (scanners, RFID, réseau) | exclu | exclu |
| Coûts internes (référents, masse salariale utilisateurs) | exclu (TCO séparé) | exclu (TCO séparé) |
| Maintenance après M36 (hors enveloppe, k TND par an) | 180 | 320 |

Contrôle : les totaux recalculés coïncident avec le CDC (1 290 / 2 420 ; 1 728 / 3 264).

## 5. Contrôle de cohérence (pas un taux journalier)

Le budget de réalisation (1290 à 2420 k TND) rapporté aux 2970 jours-personnes du backlog donne **434 à 815 TND par jour-personne**. Valeur implicite à confronter aux taux réels : ce n’est ni un taux validé ni un devis.

## 6. Cohérence avec les priorités déclarées par le CDC

- Identifiants du CDC portant une priorité ou version : **36** ; sans priorité déclarée : **67** (AUD-002, AUD-003, AUD-004, AUD-005, CRM-03, CRM-09, ADV-02, ADV-03, ADV-04, ADV-05, ACH-03, ACH-04, ACH-05, STK-02, STK-03, STK-04, STK-05, BE-02, BE-03, BE-04, BAT-02, BAT-03, BAT-04, PRD-02, PRD-03, PRD-04, PRD-05, PRD-06, PRD-07, QUA-02, QUA-03, QUA-04, LOG-03, SAV-02, SAV-03, POS-02, POS-03, FIN-02, FIN-03, FIN-04, FIN-06, FIN-07, FIN-08, FIN-09, FIN-10, RH-03, RH-04, PAY-02, PAY-03, PAY-04, IA-01, IA-02, IA-04, IA-05, SEC-02, SEC-03, SEC-04, MIG-02, MIG-03, MIG-04, MIG-05, MIG-06, MIG-07, MOB-01, MOB-02, MOB-03, MOB-04).
- Écarts entre le lot du CDC et le lot du backlog (à décider, non bloquants) : **0**

## 7. Résultat des contrôles

Aucune anomalie bloquante : budget conforme au CDC, aucun cycle, aucun identifiant en double, aucune dépendance inconnue.

Conflits de planning à décider (non bloquants) : 3.
