# ADR-002 — Programme WORKMAN Sales Bot AI : phasage et portes de décision

**Statut** : proposé (21 octobre 2026). Non accepté tant que les décisions D1 à D4 ne sont pas tranchées par le propriétaire.
**Source** : `WORKMAN_SALES_BOT_AI_Blueprint.md` (version 1.0, 21 octobre 2026), revu contre `CLAUDE.md` et ADR-001.
**Lié à** : ADR-001 (architecture), `docs/erp360/PROJECT_STATE.md` (lots L0 à L3).

## Contexte

Le blueprint décrit un conseiller commercial sur le Web et WhatsApp, relié à l'ERP, au CRM, à Outlook/Teams, au BAT et à Insight. Il propose 4 phases sur 12 mois (380 jours-personnes, 456 000 TND de réalisation avec réserve, 48 000 TND d'exploitation en année 1). Son scénario prudent est déficitaire ; le scénario central ne devient rentable qu'avec un gain de conversion démontré.

Ce dépôt est WORKMAN ERP 360 lui-même. Le blueprint traite l'ERP comme un système externe ; cette hypothèse doit être tranchée (D2).

## Décision

1. **Le programme est découpé en lots B0 à B4**, calqués sur les phases du blueprint. Chaque lot n'ouvre que si le lot précédent est terminé et si ses dépendances sont démontrées (règle « un lot cohérent à la fois »).
2. **Aucun code de bot n'est écrit avant B1**, et B1 n'ouvre pas avant L1 (sociétés, sites, droits par société) : le bot doit être cloisonné par société et par site, sinon il contourne les règles de droits existantes.
3. **Aucun engagement autonome** : devis fermes, commandes, remises exceptionnelles et réservations confirmées restent soumis à validation humaine. Les niveaux d'autonomie A à E du blueprint (§3.4) sont retenus tels quels ; le niveau E n'est pas activé dans le périmètre de cette ADR.
4. **Stack** : Laravel 12 API et Next.js 15, conformément à ADR-001. Les choix NestJS, Azure, Azure AI Search et Redis du blueprint sont **écartés** pour le MVP (un seul backend, décision d'ADR-001). Redis reste une dette de plateforme déjà listée dans ADR-001 et n'est pas un prérequis du MVP.
5. **Modèle IA** : « à confirmer ». Le blueprint cite GPT-5 comme intention ; aucun fournisseur n'est retenu ici. Le choix passe par une couche d'abstraction et par les évaluations de la phase B1.
6. **Données personnelles** : aucun pilote public tant que le transfert vers l'étranger n'est pas validé par le juridique (D3). Les données de test sont fictives.

## Décisions à prendre (bloquantes)

| ID | Décision | Responsable | Bloque |
|---|---|---|---|
| D1 | Confirmer Laravel comme backend du bot (et non NestJS) | Direction IT | B1 |
| D2 | Confirmer que « ERP » désigne WORKMAN ERP 360 pour le catalogue, les prix et les commandes, ou désigner un système externe avec contrat d'API | Direction IT et propriétaire ERP | B1 (adaptateurs), B3 |
| D3 | Validation juridique des transferts de données (INPDP, transferts hors Tunisie, sous-traitants Meta et Microsoft) | Juridique | Pilote public (B1 fin) |
| D4 | Nomination du Product Owner commercial et du responsable catalogue EPI | Direction générale | B0 |
| D5 | Fournir OPEN-01 (sociétés) et OPEN-02 (sites et entrepôts) | Propriétaire ERP | L1, donc B1 |
| D6 | Compte WhatsApp Business et compte Microsoft 365 : propriété et accès | IT | B1 (canal), B2 (Graph) |
| D7 | Règles EPI approuvées pour le périmètre pilote (familles, risques bloquants) | QHSE | B1 (conseil EPI) |
| D8 | Budget de la phase 1 et plafond d'exploitation (120 000 et 6 000 TND, proposés) | Comité de pilotage | Engagement financier |

## Phasage

| Lot | Contenu | Porte d'entrée | Porte de sortie |
|---|---|---|---|
| **B0** Cadrage | Décisions D1 à D8, registre des risques, glossaire, jeu de cas de test (FR, AR, EN), inventaire des données, mémo juridique | L0 terminé | Décisions D1 à D5 tranchées ; jeu de cas validé par les ventes |
| **B1** MVP | Conversations, consentements, demande de devis (sans prix ferme), boîte commerciale et escalade humaine, FAQ RAG approuvée, widget Web, canal WhatsApp, audit, tableau de bord initial | L1 et L2 terminés ; B0 terminé ; D3 pour le pilote public | Zéro anomalie bloquante ouverte ; isolation inter-sociétés testée ; reprise humaine démontrée |
| **B2** Smart Sales | Connecteur CRM limité aux champs autorisés, déduplication supervisée, scoring explicable, rendez-vous Outlook et Teams | B1 terminé ; D6 | Écriture CRM réconciliée ; aucune relance après retrait de consentement |
| **B3** Commerce IA | Tarifs, disponibilité datée, variantes, suivi commandes et factures, adaptateurs ERP et BAT | B2 terminé ; catalogue et prix migrés vers l'API ; D2 | Calculs identiques à l'ERP sur les cas de référence ; contrôle d'accès sur commandes et factures |
| **B4** Plateforme IA | Dashboards Insight réconciliés, quotas par tenant, mesure de ROI, audit indépendant | B3 terminé | Décision d'investissement année 2 fondée sur données réelles |

### Lien avec les lots existants

- L1 (sociétés, sites, droits) : **prérequis de B1**. Sa structure (table `sites`, colonnes de rattachement) peut être préparée avant OPEN-01 et OPEN-02, mais les données réelles restent bloquées.
- L2 (rôle PostgreSQL minimal, CORS) : **prérequis de B1**, car le canal public appelle l'API.
- L3 (entrepôts par site) : **prérequis de B3** pour la disponibilité.
- Les modules Articles, Nomenclatures et prix ne sont pas encore migrés vers l'API (ADR-001) : **prérequis de B3**.

## Conséquences

- Le premier code du programme ne sera pas un bot, mais la préparation de L1 et des contrats minimaux (demande de devis, consentement, journal).
- Le calendrier de 12 mois du blueprint ne peut pas être tenu sans D1 à D5 : il est conservé comme cible, pas comme engagement.
- La phase B1 ne doit jamais être présentée comme un MVP livrable sans reprise humaine prouvée (blueprint §6.2).

## Hors périmètre de cette ADR

Achats de médias, refonte ERP, application mobile native, voix publique, avatar, devis et BAT automatiques, agent de prospection autonome, offre SaaS externe. Chacun exige un lot et une décision séparés.
