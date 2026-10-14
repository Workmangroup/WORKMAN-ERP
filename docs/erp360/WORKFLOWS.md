# Workflows ERP 360 — Mermaid (lot P019)

Source des huit workflows : `docs/MATRICE_ECARTS_CDC.md`, partie 8 (lignes 8.2 à 8.9). Le CDC complet
(`WORKMAN_ERP_360_CDC.md`) est hors dépôt : les étapes ci-dessous reprennent ce que la matrice énumère et ce
qui est réellement implémenté. Tout ce qui n'est pas vérifié dans le code est marqué **écart**.

Convention : les nœuds `[[Approbation]]` passent par le moteur d'approbation (migration 0043) ou par un circuit
existant (0011, 0018, 0033). Les pointillés signalent un écart.

BPMN formel : non produit. Le moteur choisi est une machine à états en base (PostgreSQL), pas un moteur BPMN.

---

## 8.2 Vente

```mermaid
flowchart LR
  devis[Devis] --> cmd[Commande]
  cmd --> rem{Remise hors règle ?}
  rem -- oui --> der[[Dérogation : écart, à traiter]]
  rem -- non --> exp[Expédition]
  der -.-> exp
  exp --> fac[Facture]
  fac --> reg[Règlement]
  bat[[BAT client : écart]]:::gap -.-> cmd
  classDef gap stroke-dasharray: 4 3
```

Statut matrice : conforme hors BAT. Écart : BAT et dérogation de remise.

## 8.3 Achat

```mermaid
flowchart LR
  dem[Demande d'achat] --> appr[[Approbation : purchase_request, 1 niveau — 0011]]
  appr -- approuvée --> cmd[Commande fournisseur]
  appr -- refusée --> fin1((Fin))
  cmd --> rec[Réception]
  rec --> fac[Facture fournisseur]
  fac --> pay[[Ordre de paiement : approbation — 0033]]
  rec -.-> lit[Tolérance et litige : écart]:::gap
  classDef gap stroke-dasharray: 4 3
```

Statut matrice : partiel. Écart : tolérance de réception et litige. Le moteur P019 peut recevoir la demande d'achat
(objet `purchase_request`) après paramétrage de sa politique ; le circuit existant 0011 reste en service.

## 8.4 Production

```mermaid
flowchart LR
  mrp[MRP : suggestions] --> of[Ordre de fabrication]
  of --> ctl[Contrôle]
  ctl --> cl[Clôture]
  of -.-> bat[BAT : écart]:::gap
  ctl -.-> ret[Retouche et rebut distincts : écart]:::gap
  classDef gap stroke-dasharray: 4 3
```

Statut matrice : partiel. Écart : BAT, retouche et rebut distincts.

## 8.5 Qualité

```mermaid
flowchart LR
  nc[Non-conformité] --> capa[[Action corrective : CAPA]]
  capa --> eff[Vérification d'efficacité]
  eff --> cl((Clôture))
  nc -.-> rap[Rappel ciblé : écart]:::gap
  der[[Dérogation : demande → approbation → contrôle — 0033]] -.-> nc
  classDef gap stroke-dasharray: 4 3
```

Statut matrice : partiel. Écart : rappel ciblé.

## 8.6 RH et paie

```mermaid
flowchart LR
  rh[Module RH : absent]:::gap --> paie[Paie : absente]:::gap
  classDef gap stroke-dasharray: 4 3
```

Statut matrice : absent. Aucun workflow implémenté ; aucune règle de paie n'est codée (CLAUDE.md : pas de barème supposé).

## 8.7 Finance

```mermaid
flowchart LR
  piece[Pièce comptable] --> ctl[Contrôles]
  ctl --> per[Période ouverte ?]
  per -- oui --> sai[Saisie]
  per -- non --> cl[Clôture de période : écart]:::gap
  sai --> ctl
  classDef gap stroke-dasharray: 4 3
```

Statut matrice : partiel. Écart : périodes et clôture.

## 8.8 SAV

```mermaid
flowchart LR
  rec[Réclamation client] --> sol[Solution]
  sol --> ret[Retour produit : écart]:::gap
  sol --> cl((Clôture))
  classDef gap stroke-dasharray: 4 3
```

Statut matrice : partiel. Écart : solution et retour.

## 8.9 Recouvrement

```mermaid
flowchart LR
  bal[Balance âgée] --> rel[Relance]
  rel --> prom[Promesse de paiement : écart]:::gap
  prom --> plan[Plan d'apurement : écart]:::gap
  rel --> cl((Encaissement))
  classDef gap stroke-dasharray: 4 3
```

Statut matrice : partiel. Écarts : promesses et plans.

---

## Moteur d'approbation (P019, migration 0043)

Ce diagramme décrit le moteur ajouté dans ce lot, pas un workflow métier.

```mermaid
stateDiagram-v2
  [*] --> pending_l1 : approval_request_create
  pending_l1 --> pending_l2 : approve (montant > seuil, 2 niveaux)
  pending_l1 --> approved : approve (montant ≤ seuil ou 1 niveau)
  pending_l2 --> approved : approve (autre personne que le niveau 1)
  pending_l1 --> refused : refuse (motif ≥ 10 car.)
  pending_l2 --> refused : refuse (motif ≥ 10 car.)
  pending_l1 --> cancelled : cancel (demandeur)
  pending_l2 --> cancelled : cancel (demandeur)
  pending_l1 --> invalidated : contenu changé
  pending_l2 --> invalidated : contenu changé
  approved --> invalidated : contenu changé (hash différent)
  approved --> [*]
  refused --> [*]
  cancelled --> [*]
  invalidated --> [*]
```

Transitions refusées (résultat `ok = false`, journalisées) : toute action sur un état final, auto-approbation du
demandeur (`SOD_SELF_APPROVAL`), second niveau par la même personne que le premier (`SOD_NOT_INDEPENDENT`),
escalade d'une demande non échue (`APPROVAL_NOT_OVERDUE`).
