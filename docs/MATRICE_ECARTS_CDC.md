# Matrice d'écarts — WORKMAN ERP 360 (cahier des charges v1.0, 12 octobre 2026)

Source : `WORKMAN_ERP_360_CDC.md`. État constaté dans le dépôt `MB-CONFECTION-ERP` (web + supabase/migrations 0001–0029 + tests SQL 1 769 contrôles, unitaires 7 suites).

**Statuts** : *Conforme* = présent et testé · *Partiel* = présent en partie · *Absent* = non présent dans le dépôt · *Non vérifié* = impossible à constater sans environnement ou donnée réels · *Non réalisé* = activité de processus du cahier, pas encore engagée.

**Priorités** (cahier) : P0 indispensable au lot · P1 cible · P2 optimisation. **Versions** : V1 (M4–M12), V2 (M13–M24), V3 (M25–M36).

Aucune conclusion ne vaut audit : la phase AUD (inventaire réel, parcours utilisateurs, données de production) reste à faire.

---

## Synthèse

Décompte relevé ligne à ligne sur les tableaux ci-dessous : **169 exigences**.

| Statut | Nombre |
|---|---:|
| Conforme | 13 |
| Partiel | 85 |
| Absent | 52 |
| Non vérifié | 7 |
| Non réalisé (processus) | 12 |

| Partie | Conforme | Partiel | Absent | Non vérifié / non réalisé |
|---|---:|---:|---:|---:|
| 1 Projet | 1 | 2 | 1 | 5 non réalisé |
| 2 Architecture | 2 | 9 | 3 | 6 non vérifié, 2 non réalisé |
| 3 Modules métiers (55 lignes) | 8 | 39 | 8 | — |
| 4 Finance (14) | 0 | 8 | 6 | — |
| 5 RH et paie (8) | 0 | 0 | 8 | — |
| 6 IA (7) | 0 | 3 | 4 | — |
| 7 BI (3) | 0 | 2 | 1 | — |
| 8 Workflows (9) | 1 | 7 | 1 | — |
| 9 Sécurité (8) | 0 | 5 | 3 | — |
| 10 Données et intégrations (20) | 1 | 6 | 11 | 1 non vérifié, 1 non réalisé |
| 11 Mobiles et portails (9) | 0 | 3 | 6 | — |
| 12 Gouvernance (5) | 0 | 1 | 0 | 4 non réalisé |

## Partie 1 — Projet

| ID | Exigence | Prio/V | Statut | Preuve | Écart et action |
|---|---|---|---|---|---|
| ORG-001 | Chaque transaction porte sa société propriétaire | P0/V1 | Conforme | `company_id` sur toutes les tables, RLS et tests d'isolation société | — |
| ORG-002 | Société active visible, pas de bascule silencieuse | P0/V1 | Partiel | Une seule société en pratique, pas de sélecteur de société | Ajouter le sélecteur et l'affichage de la société active |
| ORG-003 | Flux intersociétés documentés et rapprochables | P1/V2 | Absent | Aucune table ni écran intersociétés | Modèle de flux intersociétés, documents réciproques |
| AUD-001 | Inventaire modules, écrans, API, tâches, rapports, bases, intégrations | P0/M1–M3 | Non réalisé | Inventaire technique partiel (ce document) | Audit sur site avec les propriétaires |
| AUD-002 | Observer les parcours réels, classer chaque capacité | P0 | Non réalisé | — | Entretiens et observation avec les utilisateurs |
| AUD-003 | Cartographier tables, clés, doublons, orphelins (sans modifier la production) | P0 | Non réalisé | — | Analyse de la base de production en lecture seule |
| AUD-004 | Référence de non-régression (scénarios, jeux anonymisés) | P0 | Partiel | Suites SQL et unitaires, scénarios de process (devis→facture, MRP) | Constituer des jeux anonymisés de référence |
| AUD-005 | Architecture observée, registre d'écarts, risques | P0 | Non réalisé | Ce document est une ébauche | Livrable après AUD-001 à 004 |
| — | Conduite du changement, formation, sponsor | — | Non réalisé | — | Hors dépôt |


---

## Partie 2 — Architecture

| ID | Exigence | Prio/V | Statut | Preuve | Écart et action |
|---|---|---|---|---|---|
| ARC-001 | Auditer la pile avant choix définitif | P0 | Non réalisé | — | Lié à AUD |
| ARC-A | Interfaces Next.js, React, TypeScript, Tailwind | — | Conforme | `web/` Next.js 15, TypeScript, Tailwind v4 | — |
| ARC-B | Backend Laravel **ou** NestJS, une seule pile par responsabilité | — | Partiel | Backend = Supabase (PostgreSQL, RLS, fonctions) + server actions Next.js | **Décision à prendre** : justifier Supabase comme backend, ou adapter |
| ARC-C | PostgreSQL pour les extensions | — | Conforme | PostgreSQL 15 (Supabase) | — |
| ARC-D | Monolithe modulaire, frontières de domaines | — | Partiel | Dossiers `features/` par domaine | Contrats explicites entre domaines non formalisés |
| ARC-E | Règles critiques côté serveur (droits, remises, taxes, dispos) | — | Partiel | Fonctions SQL avec `require_perm`, taxes et stocks en base | Remises et seuils de validation côté serveur à compléter |
| ARC-F | Docker standardise l'exécution | — | Absent | Pas de Dockerfile dans `web/` | Image applicative et compose de déploiement |
| ARC-G | Séparation dev / intégration / recette / préprod / prod | — | Partiel | Local (Supabase CLI) et prod non définie | Environnements préprod et recette |
| ARC-H | Coffre de secrets, analyse images/dépendances, pipelines | — | Absent | Variables `.env` seulement | CI, scan, coffre |
| ARC-I | Stockage objet des pièces avec antivirus, taille max, liens temporaires | — | Partiel | Buckets privés, liens signés GED | Antivirus et contrôle de taille à ajouter |
| ARC-J | Azure ou autre cloud (résidence des données) | — | Non réalisé | Décision non prise (VPS, Supabase auto-hébergé étudiés) | Décision hébergement et résidence |
| ARC-K | Kubernetes seulement si justifié | — | Absent | — | Non nécessaire à ce stade |
| NFR-01 | Disponibilité 99,9 % | — | Non vérifié | Pas de supervision | Supervision et SLA |
| NFR-02 | p95 lecture < 2 s, validation < 3 s | — | Non vérifié | Pas de test de charge | Test de charge 300 utilisateurs |
| NFR-03 | Imports lourds asynchrones (100 000 lignes) | — | Partiel | Imports synchrones | File de travaux |
| NFR-04 | RPO ≤ 15 min, RTO ≤ 4 h | — | Non vérifié | Sauvegardes non testées | Restauration chronométrée |
| NFR-05 | Transactions réconciliables après panne | — | Non vérifié | — | Tests de reprise |
| NFR-06 | BI ≤ 15 min de retard | — | Non vérifié | Calculs à la demande | Définir la fraîcheur |
| NFR-07 | Isolation sur API, recherche, exports, BI, IA, mobile | — | Partiel | Isolation société testée (SQL) ; pas encore BI, IA, mobile | Étendre les tests |
| NFR-08 | Accessibilité clavier, contraste, libellés | — | Non vérifié | Pas d'audit | Audit d'accessibilité |
| NFR-09 | Français complet ; arabe/anglais selon besoin | — | Partiel | Interface en français | Arabe (RTL) et anglais à décider |
| NFR-10 | Export données et configurations en formats ouverts | — | Partiel | Exports CSV, XLS, PDF des tableaux | Export complet de configuration |


---

## Partie 3 — Modules métiers

### 3.1 CRM

| ID | Exigence | Prio/V | Statut | Preuve | Écart et action |
|---|---|---|---|---|---|
| CRM-01 | Prospects : coordonnées, origine, segment, propriétaire, consentements, dédoublonnage | P0/V1 | Partiel | Prospects (origine, propriétaire, étape) | Consentements, dédoublonnage assisté, fusion |
| CRM-02 | Opportunités : étapes, montant, devise, probabilité, motifs gain/perte | P0/V1 | Partiel | Pipeline, étapes, `lost_reason` | Devise et probabilité sur l'opportunité |
| CRM-03 | Client 360° : contacts, devis, commandes, factures, réclamations | — | Conforme | Fiche client 12 onglets, tests | BAT et visites à ajouter plus tard |
| CRM-04 | Visites : agenda, GPS encadré, compte rendu, photos, signature | P1/V2 | Partiel | Agenda, pointage GPS honnête (position, refus, indisponibilité sans coordonnée, fenêtre ±24 h), compte rendu avec dictée relue, photos liées à la GED (0050) | Vue calendrier, téléversement de photo, signature, périmètre par territoire, distance au site client |
| CRM-05 | Devis versionnés : tailles, couleurs, remises, validité, PDF, acceptation | P0/V1 | Partiel | Devis, statuts, acceptation, duplication ; versions immuables, accord hors seuil, conversion idempotente, PDF (0049) | Écrans P024 non vérifiés en navigateur ; politique d’accord « quote » à paramétrer |
| CRM-06 | Contrats : durée, renouvellement, versions signées | P1/V2 | Partiel | Contrats datés, signature par pièce GED, conditions valides à date, renouvellement chaîné, résiliation, pas de chevauchement (0050) | Alerte de préavis, renouvellement automatique non exécuté, signature électronique absente |
| CRM-07 | Marketing e-mail / SMS / WhatsApp, consentements | P1/V2 | Partiel | Segments, modèles approuvés par une autre personne (lien de désinscription obligatoire), campagnes brouillons, consentements e-mail et SMS/WhatsApp, désinscription, liste de suppression, webhooks idempotents signés, coûts estimés (0051) | Aucun connecteur homologué : aucun envoi réel ; pas de WhatsApp Business ni de fournisseur SMS testé |
| CRM-08 | Portail client : devis, commandes, BL, factures, paiement | P1/V2 | Absent | Profil « client » dans l'authentification, pas d'écran | Portail client |
| CRM-09 | Application mobile : visites, GPS, photos, signature | P0/V1 | Partiel | Interface terrain « atelier » responsive (scan, OF) | Parcours commercial mobile |

### 3.2 Administration des ventes

| ID | Exigence | Prio/V | Statut | Preuve | Écart et action |
|---|---|---|---|---|---|
| ADV-01 | Devis → commande sans ressaisie, reliquats, livraisons partielles | P0/V1 | Partiel | Devis→commande, expédition partielle testée ; reliquat par ligne, livraison rattachée à la ligne, annulation motivée, versions d’engagement, échéanciers, adresse (0052) | Pages commande non vérifiées en navigateur ; acomptes ; lignes ajoutées après confirmation non versionnées |
| ADV-02 | Stock disponible / réservé / bloqué / attendu | — | Partiel | Réservations, stock disponible ; positions utilisable / réservé / bloqué / engagé non prélevé / attendu et promesse à partir du seul utilisable, sans double réservation (0053) | Attendu non ventilé par variante (production au niveau article) ; pas de date de promesse confirmée par fournisseur ; écran non vérifié en navigateur |
| ADV-03 | Blocage et approbation des dépassements de crédit, prix, marge | — | Partiel | Plafond client, encours (factures ouvertes et commandes non facturées), blocage à la confirmation, dérogation de crédit bornée et tracée, prix sous coût et marge minimale, dérogation « prix » tracée (0053) | Blocage à l’expédition et à la facturation non ajouté ; minimum de marge à paramétrer par la finance ; écran non vérifié en navigateur |
| ADV-04 | Facturation sur livré, acomptes, avoirs | — | Partiel | Factures depuis commande et depuis BL (0056, rapprochement par ligne), acomptes imputés et traçables, avoirs bornés au solde, facture émise immuable, idempotence des créations | Écrans acomptes et facturation par BL absents (actions serveur seulement) ; règle d'arrondi finance non validée ; TVA d'acompte à trancher |
| ADV-05 | Retours clients avec contrôle d'état et avoir | — | Partiel | Avoirs ; retour demandé, réceptionné, inspecté par la qualité (décision existante), réglé : remis en stock vendable seulement si accepté, sinon lot non conforme ; aucun avoir ni remboursement créé par le retour (0055) | Remboursement non implémenté ; avoir lié au retour à faire manuellement ; écran non vérifié en navigateur |

### 3.3 Achats

| ID | Exigence | Prio/V | Statut | Preuve | Écart et action |
|---|---|---|---|---|---|
| ACH-01 | Demande d'achat : besoin, quantité, centre de coût, validation, budget | P0/V1 | Partiel | Demandes d'achat avec centre de coût, budget par centre et période (0057), contrôle à la soumission, engagé et réalisé séparés, workflow de seuils par le moteur d'approbation, refus visible, délégation bornée | Écrans budget et demande non livrés (SQL et actions seulement) ; commandes saisies hors demande non budgétées ; budgets par article et au-delà de la période non couverts |
| ACH-02 | Appels d'offres et comparatif coût rendu | P1/V2 | Absent | — | Module appels d'offres |
| ACH-03 | Commandes versionnées, seuils, confirmation fournisseur | P0/V1 | Partiel | Commandes fournisseur, statuts | Versions et seuils d'approbation |
| ACH-04 | Réception, contrôle, rapprochement commande–réception–facture | P0/V1 | Partiel | Réceptions, factures fournisseur liées à la commande | Tolérances, quarantaine, litiges |
| ACH-05 | Évaluation fournisseur (délais, défauts, prix) | P1/V2 | Absent | Non trouvé dans le dépôt | Scorecard fournisseur |

### 3.4 Stocks

| ID | Exigence | Prio/V | Statut | Preuve | Écart et action |
|---|---|---|---|---|---|
| STK-01 | Entrepôts, zones, emplacements, capacités, rouleaux (lot, longueur, largeur) | P0/V1 | Partiel | Entrepôts, zones, emplacements, lots | Longueur et largeur des rouleaux, capacités |
| STK-02 | Journal immuable, stock négatif bloqué | P0/V1 | Conforme | Mouvements en ajout seul, garde-fous de stock, tests | — |
| STK-03 | Lots, FIFO et FEFO | P0/V1 | Partiel | Lots, affectation FIFO | FEFO (dates de péremption) |
| STK-04 | Inventaires tournants, comptage aveugle, approbation des écarts | P0/V1 | Partiel | Inventaires, validation | Comptage aveugle et approbation des écarts |
| STK-05 | Réservations, picking, transferts, intersociétés | P0/V1 | Partiel | Réservations, transferts | Flux intersociétés |
| STK-06 | Codes-barres et mobiles ; RFID après étude | P1/V2 | Partiel | Scan QR et code-barres (terminal atelier) | RFID hors périmètre à ce stade |
| STK-07 | Responsable d'entrepôt limité à son entrepôt | P0 | Conforme | `user_warehouses`, tests d'isolation entrepôt | — |

### 3.5 Bureau d'études

| ID | Exigence | Prio/V | Statut | Preuve | Écart et action |
|---|---|---|---|---|---|
| BE-01 | Collections, modèles, variantes tailles/couleurs, SKU unique | P1/V2 | Partiel | Produits maîtres, variantes, SKU | Notion de collection |
| BE-02 | BOM versionnée, gamme (opérations, postes, temps) | — | Partiel | Nomenclatures versionnées, opérations | Compétences et substitutions |
| BE-03 | Dossier technique : mesures, patronage, dessins, tolérances | — | Partiel | Fiche technique produit, documents | Patronage et tolérances structurées |
| BE-04 | Cycle brouillon / revue / approuvé / obsolète | — | Partiel | Statuts brouillon, validé, obsolète | Changement sur OF en cours : décision formelle |

### 3.6 BAT et personnalisation

| ID | Exigence | Prio/V | Statut | Preuve | Écart et action |
|---|---|---|---|---|---|
| BAT-01 | Logos, formats, placement, dimensions, techniques (broderie, sérigraphie) | P0/V1 si applicable | Partiel | Logos avec pièce GED et droits d’usage datés et prouvés ; spécification versionnée par ligne (technique, placement, dimensions, couleurs) (0054) | Pas d’outil graphique de placement ; techniques sans paramètres de production (points, encres) |
| BAT-02 | PDF versionné avec empreinte et validateur | P0 | Partiel | BAT versionné par spécification, PDF de la GED avec son empreinte sha256 (0054) | Génération du PDF non faite (fichier fourni) ; validateur de fichier absent |
| BAT-03 | Accord client sur une version précise ; invalidation si modification | P0 | Partiel | Accord par BAT : contact habilité, empreinte exacte, preuve, date, auteur exclu ; modification ou retrait de droits invalide l’accord (0054) | Pas de signature électronique ; pas de relance automatique ; écran non vérifié en navigateur |
| BAT-04 | Personnalisation bloquée sans BAT valide | P0 | Partiel | Démarrage d’une opération refusé sans BAT approuvé de la version courante (0054) | Non relié aux ordres de fabrication : la règle s’applique à l’opération de personnalisation, pas à l’OF |

### 3.7 Production

| ID | Exigence | Prio/V | Statut | Preuve | Écart et action |
|---|---|---|---|---|---|
| PRD-01 | MRP : besoins, stocks, BOM, délais, propositions sans exécution automatique | P1/V2 | Conforme | MRP, suggestions à valider, test MRP 62 contrôles et scénario de bout en bout | — |
| PRD-02 | Ordonnancement atelier, charge théorique vs capacité finie | P1/V2 | Partiel | Postes de travail, tableau de bord de production | Capacité finie et replanification avec impact client |
| PRD-03 | OF versionné, BOM et gamme figées | P1/V2 | Partiel | OF, nomenclature | Figer la version à la création de l'OF |
| PRD-04 | Matelas, rouleaux, lots de confection, rebut, généalogie | P1/V2 | Partiel | Journal de production (bonnes pièces, rebut) | Généalogie matière–produit–commande |
| PRD-05 | Temps standard et réel, bonnes pièces et défauts | P1/V2 | Conforme | Journal de production, rendement, efficience | — |
| PRD-06 | Sous-traitance : opérations, matières confiées, réception et contrôle | P1/V2 | Conforme | Module sous-traitance, tests | — |
| PRD-07 | Clôture après rapprochement consommations, bonnes pièces, coûts | P1/V2 | Partiel | Clôture d'OF | Rapprochement des coûts |

### 3.8 Qualité

| ID | Exigence | Prio/V | Statut | Preuve | Écart et action |
|---|---|---|---|---|---|
| QUA-01 | Contrôles réception, en cours, final : plans, tolérances, décisions | P0 | Conforme | Contrôles par type, plans, décisions, tests (46) | — |
| QUA-02 | Non-conformités, CAPA, efficacité | — | Conforme | NC, actions correctives, efficacité | — |
| QUA-03 | Quarantaine, libération réservée à un rôle habilité, blocage aval | P0 | Partiel | Emplacement de quarantaine, décisions ; lot non conforme refusé à l'affectation et à l'expédition, son stock restant bloqué (0055, 0053) | Le picking peut encore réserver du stock bloqué (refusé seulement à l'expédition) |
| QUA-04 | Registre documentaire ISO 9001, EN ISO 20471, EN 343, EN ISO 13688 | — | Partiel | Certifications produit avec date de validité et alerte | Registre normatif complet |

### 3.9 Logistique

| ID | Exigence | Prio/V | Statut | Preuve | Écart et action |
|---|---|---|---|---|---|
| LOG-01 | Picking par lot et emplacement, scan, colisage, étiquettes | P0/V1 | Partiel | Picking, colisage, scan | Étiquettes imprimables |
| LOG-02 | Transporteurs, suivi, preuve | P1/V2 | Partiel | Transporteur et suivi saisis | Webhooks transporteurs |
| LOG-03 | Livraisons partielles, export avec documents douaniers | — | Partiel | BL, facture export, contrôle de preuve ; lots affectés à chaque quantité avant BL, BL réimprimable sans nouvelle sortie, confirmation de livraison idempotente (0055) | Documents douaniers validés ; colis non individualisés (nombre seul) |

### 3.10 SAV

| ID | Exigence | Prio/V | Statut | Preuve | Écart et action |
|---|---|---|---|---|---|
| SAV-01 | Ticket lié client, commande, facture, lot ; SLA | P0/V1 | Partiel | Réclamations clients liées à la commande | SLA et canaux |
| SAV-02 | Qualification, solution, retour, avoir, clôture | — | Partiel | Résolution de réclamation | Retour physique |
| SAV-03 | Base de connaissance, causes récurrentes | — | Absent | — | Base de connaissance |

### 3.11 POS boutiques

| ID | Exigence | Prio/V | Statut | Preuve | Écart et action |
|---|---|---|---|---|---|
| POS-01 | Session caisse, scan, promotions, fidélité, paiement multiple | P1/V2 | Absent | « Caisse » désigne ici la trésorerie, pas un point de vente | Module POS |
| POS-02 | Stock magasin, retours, échanges | P1/V2 | Absent | — | Module POS |
| POS-03 | Mode hors ligne borné et synchronisation idempotente | P1/V2 | Absent | — | Module POS |
| POS-04 | IA de réassort | P2/V3 | Absent | — | Après POS |



---

## Partie 4 — Finance

| ID | Exigence | Prio/V | Statut | Preuve | Écart et action |
|---|---|---|---|---|---|
| FIN-01 | Comptabilité générale : plan, journaux, exercices, grand livre, balance, équilibre | P0/V1 | Partiel | Plan comptable provisoire (9 comptes), journaux VT/AC/BQ/CA/OD, périodes mensuelles, écritures automatiques (factures, avoirs, encaissements, règlements fournisseur, écarts de change), immuabilité, balance et grand livre, clôture de période (migration 0031, 34 contrôles, page /finance/comptabilite) | Écritures manuelles (OD), exercices et bilan / compte de résultat, plan comptable validé par l’expert, TVA déductible, amortissements, stocks |
| FIN-02 | Paramétrage TVA, retenues, exonérations versionné par date ; aucun taux codé en dur | P0 | Partiel | Taux lus par date d'effet dans `vat_rates` (migration 0030) ; fonction sans valeur codée ; taux manquant bloquant (11 contrôles fiscaux) | Taux encore au statut « à valider » : confirmation de l'expert-comptable ; retenues à la source non modélisées |
| FIN-03 | Corrections par contrepassation, périodes clôturées bloquées | P0 | Partiel | Corrections par avoir, facture annulée | Clôture de période et réouverture auditée |
| FIN-04 | Analytique par centre, société, atelier, collection, produit | P1/V2 | Absent | Marges par client et par produit seulement | Modèle analytique |
| FIN-05 | Immobilisations : acquisition, amortissement, cession | P1/V2 | Absent | — | Module immobilisations |
| FIN-06 | Déclarations TVA : calcul, contrôle, validation, archivage | P0 | Partiel | Calcul de TVA par taux (`vat_summary`) | Validation, export, archivage |
| FIN-07 | Comptes, prévisions, rapprochement bancaire | P0 | Partiel | Trésorerie consolidée, prévisions 13 semaines | Comptes bancaires et rapprochement |
| FIN-08 | Changement bancaire fournisseur : double validation | P0 | Absent | — | Circuit séparé |
| FIN-09 | Relevés bancaires, statuts de paiement | P0 | Absent | — | Import de relevés et statuts |
| FIN-10 | Réévaluation des postes monétaires à la clôture | P0 | Partiel | Écarts latents et réalisés calculés | Écritures de réévaluation |
| FIN-11 | Rapprochement intersociétés, éliminations, consolidation | P1/V2 | Absent | — | Périmètre de consolidation |
| 4.3 | Multi-devises : TND, EUR, USD, précision TND 3 décimales | P0 | Partiel | Devises (EUR, TND, USD, GBP), taux figés, écarts, 44 contrôles | Montants fournisseur en 2 décimales (TND arrondi) |
| 4.4 | Budgets, versions, prix/volume/mix, marges distinctes | P1/V2 | Absent | — | Module budgets |
| 4.5 | Recouvrement : échéances, balance âgée, promesses, relances graduées | P0 | Partiel | Balances âgées, relances | Promesses, plans de paiement, litiges |


---

## Partie 5 — RH et paie

| ID | Exigence | Prio/V | Statut | Preuve | Écart et action |
|---|---|---|---|---|---|
| RH-01 | Dossier employé : matricule, contrat, affectation, accès restreint | P0 (lot RH) | Absent | Aucune table employé dans ce dépôt | Module RH |
| RH-02 | Organigramme, recrutement | P1/V2 | Absent | — | Module RH |
| RH-03 | Formation, compétences, évaluations | P1/V2 | Absent | — | Module RH |
| RH-04 | Congés, absences, pointage, données médicales séparées | P1/V2 | Absent | — | Module RH |
| PAY-01 | Rubriques de paie versionnées (CNSS, IRPP) | P0/V2 | Absent | — | Paie tunisienne, barèmes à valider par un expert |
| PAY-02 | Cycle de paie : collecte, simulation, validation, bulletins | P0/V2 | Absent | — | Paie |
| PAY-03 | Contrats, pointage, coordonnées de paiement | P0/V2 | Absent | — | Paie |
| PAY-04 | Deux cycles parallèles avec la solution actuelle | P0 | Absent | — | Parallèle avant bascule |

**Point de réutilisation** : le projet frère `workvoice` (dossier `C:\Users\DELL\Downloads\remotion\workvoice`) contient des modules RH (congés, sorties, retards, attestations, multi-société). Ils ne sont **pas** dans ce dépôt. Décision à prendre : intégrer ou non ces modules, et sous quelle architecture.


---

## Partie 6 — Intelligence artificielle

| ID | Exigence | Prio/V | Statut | Preuve | Écart et action |
|---|---|---|---|---|---|
| IA-01 | Réponse chiffrée avec période, unité, fraîcheur et sources | P0 | Partiel | Copilote à règles : réponses chiffrées avec source et traçabilité | Pas encore d'agent à modèle de langage |
| IA-02 | Au moins 30 cas métier par agent, cas adverses | P0 | Absent | — | Jeu d'évaluation |
| IA-03 | Zéro fuite inter-société ou inter-entrepôt dans les tests | P0 | Partiel | Tests d'isolation sur les données (SQL), pas sur l'IA | Tests spécifiques à l'IA |
| IA-04 | Prévisions comparées à une référence naïve | P1/V3 | Absent | Tendance linéaire seulement | Évaluation des prévisions |
| IA-05 | Arrêt immédiat, quotas, journal de coût | P0 | Absent | — | Contrôle d'exécution |
| CEO Copilot | Synthèse groupe, explication des écarts | — | Partiel | Tableau de bord direction et copilote | Périmètre groupe et sources certifiées |
| 10 agents métiers | Commercial, achat, stock, production, qualité, finance, recouvrement, RH, contrôle de gestion, SAV | P1/V3 | Absent | Moteur de recommandations et briefing (pas d'agents) | Agents avec outils contrôlés |


---

## Partie 7 — Workman Insight AI (BI)

| ID | Exigence | Prio/V | Statut | Preuve | Écart et action |
|---|---|---|---|---|---|
| BI-01 | Modèle sémantique certifié, entrepôt BI séparé de la production | P0 | Absent | Calculs directs sur les tables de production | Entrepôt BI |
| BI-02 | Dictionnaire KPI : formule, grain, source, propriétaire | P0 | Partiel | Définitions dans les calculs (marge, CA, OTIF non tous) | Dictionnaire formel |
| BI-03 | Onze dashboards (CEO, groupe, commercial, production, stock, achat, finance, RH, qualité, recouvrement, boutiques) | P1/V2 | Partiel | Direction, finance, expédition, production, stratégie (environ 5 sur 11) | RH, boutiques, recouvrement, achats |


---

## Partie 8 — Workflows

| Workflow | Statut | Preuve | Écart et action |
|---|---|---|---|
| Vente (8.2) | Conforme (hors BAT) | Devis, commande, expédition, facture, règlement : scénario bout en bout | BAT et dérogation de remise |
| Achat (8.3) | Partiel | Demande, approbation, commande, réception, facture | Tolérance et litige |
| Production (8.4) | Partiel | MRP, OF, contrôle, clôture | BAT, retouche et rebut distincts |
| Qualité (8.5) | Partiel | NC, CAPA, efficacité | Rappel ciblé |
| RH et paie (8.6) | Absent | — | Module RH |
| Finance (8.7) | Partiel | Pièces et contrôles | Périodes et clôture |
| SAV (8.8) | Partiel | Réclamations | Solution et retour |
| Recouvrement (8.9) | Partiel | Balances, relances | Promesses et plans |
| Matrice des validations (8.10) | Partiel | Approbations achats, stocks, MRP | Séparation des tâches systématique |


---

## Partie 9 — Sécurité

| ID | Exigence | Prio/V | Statut | Preuve | Écart et action |
|---|---|---|---|---|---|
| SEC-01 | SSO compatible fournisseur d'identité, MFA pour les accès sensibles | P0 | Absent | Mot de passe et sessions Supabase ; aucun MFA dans le code | **P0** : MFA et SSO |
| SEC-02 | RBAC et ABAC (société, site, entrepôt, équipe, propriété) | P0 | Partiel | RBAC (rôles et permissions), ABAC société et entrepôt | Équipe et propriété |
| SEC-03 | Délégations datées et bornées, pas d'accès automatique aux paies ou marges | P0 | Absent | — | Délégations |
| SEC-04 | Chiffrement, coffre, rotation des secrets | P0 | Partiel | Stockage privé, liens signés, secrets dans l'environnement | Coffre et rotation |
| Matrice des rôles | 25 rôles et profils, sept permissions d'export distinctes | P0 | Partiel | 8 rôles système et permissions de modules | Compléter les profils (commercial, responsable, auditeur, etc.) |
| Séparation des tâches | Paiement, ajustement, paie, dérogation | P0 | Partiel | Approbations à deux niveaux pour certains mouvements | Séparation généralisée |
| Audit | Journal avant/après, motif, identifiant de corrélation | P0 | Partiel | Journal d'audit (`audit_logs`), avant/après | Identifiant de corrélation |
| Données personnelles | Conservation par catégorie, droits d'accès et de suppression | P0 | Absent | — | Politique de conservation (juridique) |


---

## Partie 10 — Données et intégrations

| ID | Exigence | Prio/V | Statut | Preuve | Écart et action |
|---|---|---|---|---|---|
| DAT-01 | Référentiels avec propriétaire et steward | P0 | Partiel | Référentiels présents, pas de propriétaire formel | Gouvernance des données |
| DAT-02 | Modèle conceptuel rapproché de l'existant | P0 | Partiel | Schéma existant (noms différents du cahier) | Table de correspondance |
| DAT-03 | Dictionnaire logique minimum | P0 | Partiel | Schéma SQL (migrations) | Dictionnaire à publier |
| API-01 | API REST versionnée, OpenAPI, pagination, idempotence | P0 | Absent | Server actions Next.js et REST Supabase automatique | Contrat OpenAPI |
| API-02 | Événements après commit (outbox), consommateurs idempotents | P1 | Absent | — | Outbox |
| API-03 | API IA : propositions avec approbation | P0 | Absent | — | Propositions IA |
| CON-01 | Connecteur banque (relevés, ordres) | P0 | Absent | — | Connecteur |
| CON-02 | Connecteur e-commerce | P1 | Absent | — | Connecteur |
| CON-03 | WhatsApp Business | P2 | Absent | — | Connecteur |
| CON-04 | Power BI | P1 | Absent | — | Modèle BI |
| CON-05 | Transport (tracking, preuve) | P1 | Absent | — | Connecteur |
| CON-06 | Pointage | P0 (RH) | Absent | — | Dépend du module RH |
| CON-07 | Paiement en ligne | P1 | Absent | — | Prestataire |
| MIG-01 | Sauvegarde et restauration testées avant changement | P0 | Non vérifié | Sauvegardes non testées | Test de restauration |
| MIG-02 | Expand, migrate, contract, feature flags | P0 | Partiel | Migrations additives versionnées (0001–0029) | Feature flags |
| MIG-03 | Scripts versionnés, répétables, journalisés | P0 | Conforme | Migrations SQL versionnées, tests de rejeu (PGlite) | — |
| MIG-04 | Réconciliation par société (soldes, stocks, documents) | P0 | Absent | — | Rapports de réconciliation |
| MIG-05 | Une seule source de vérité par objet | P0 | Partiel | Schéma unique | Règle par objet à documenter |
| MIG-06 | Bascule avec rollback par rejeu | P0 | Non réalisé | — | Plan de bascule |
| MIG-07 | Aucun DROP ou TRUNCATE routinier | P0 | Partiel | Migrations sans suppression, mais scripts de purge de démonstration | Procédure documentée |


---

## Partie 11 — Applications mobiles

| ID | Exigence | Prio/V | Statut | Preuve | Écart et action |
|---|---|---|---|---|---|
| MOB-01 | Cache chiffré, tokens courts, révocation, purge | P0 | Absent | — | Stratégie hors ligne |
| MOB-02 | File locale d'opérations, conflits visibles | P0 | Absent | — | Synchronisation |
| MOB-03 | Opérations sensibles uniquement en ligne | P0 | Partiel | Actions sensibles côté serveur | Confirmer le mode en ligne |
| MOB-04 | Ergonomie terrain : gros boutons, scan, contraste | P0 | Partiel | Interface terrain (gants, scan, grands boutons) | Test sur terminaux réels |
| Sales Mobile | Clients, visites, devis mobile | P1/V2 | Absent | — | Application |
| Warehouse Mobile | Réception, picking, inventaire mobile | P1/V2 | Partiel | Interface atelier (picking, scan) | Parcours entrepôt complet |
| Executive Mobile | KPI, approbations | P2/V3 | Absent | Tableau de bord responsive | Application |
| Portail client | Documents, commandes, paiement | P1/V2 | Absent | — | Portail |
| Portail fournisseur | Commandes, confirmations, factures | P1/V2 | Absent | — | Portail |


---

## Partie 12 — Gouvernance et acceptation

| ID | Exigence | Statut | Commentaire |
|---|---|---|---|
| Gouvernance | COPIL, comité opérationnel, décisions | Non réalisé | Organisation hors dépôt |
| Roadmap 36 mois | Gates G0 à G4 | Non réalisé | À établir après AUD |
| Budget | Enveloppe 1,73 à 3,26 MTND | Non réalisé | Estimation du cahier, non validée |
| ACC-01 à ACC-12 | Critères d'acceptation | Non réalisé | Mesurables après recette |
| Plan de tests | Scénarios obligatoires du cahier (10 scénarios) | Partiel | Refus de la survente vérifié sur deux connexions réelles (`web/tests/concurrency/reserve-concurrency.sh`, base locale) ; scénarios BAT (module absent), lot bloqué au picking et rollback après transactions non couverts | Écrire les scénarios manquants |

---

## Écarts prioritaires (P0, à traiter avant la V1)

1. **Comptabilité générale** (FIN-01) : socle en place (écritures automatiques, balance, grand livre, clôture). Restent : écritures manuelles, exercices, bilan et compte de résultat, validation du plan comptable.
2. **Taux fiscaux** (FIN-02) : codés dans la fonction jusqu'à 0029, désormais lus par date d'effet (0030). Reste à faire confirmer les valeurs par l'expert-comptable.
3. **MFA et SSO** (SEC-01) : absents.
4. **Données personnelles** (politique de conservation et droits d’accès) : absentes.
5. **RH et paie** (parties 5 et PAY-01 à PAY-04) : absentes de ce dépôt ; module disponible dans `workvoice`, à décider.
6. **BAT et personnalisation** (BAT-01 à BAT-04) : partiels (0054) ; restent : PDF généré, lien avec les OF, signature électronique.
7. **Sauvegarde et restauration** (MIG-01, NFR-04) : non vérifiées.
8. **Architecture backend** (ARC-B) : décision à prendre (Supabase conservé ou adapté).
9. **Multi-société effective** (ORG-002, ORG-003, STK-05) : modèle prêt, données et flux à mettre en place.

## Points à décider avant la suite

- Backend : garder Supabase (avec justification écrite) ou migrer vers Laravel/NestJS ?
- Module RH : intégrer `workvoice` ou le reconstruire ?
- Hébergement : résidence des données et cloud (Azure ou autre).
- Périmètre de la V1 : la liste P0 ci-dessus est-elle acceptée par le comité de pilotage ?
