# P077 — Clôture caisse et stock magasin : dossier de cadrage

Statut : **cadrage, aucune implémentation**. Le lot ne peut pas être livré honnêtement : le socle de vente au détail (tickets, sessions de caisse) n'existe pas. Aucun code, aucune migration, aucune donnée n'ont été créés.

## 1. Existant inspecté

| Élément | Constat | Preuve |
|---|---|---|
| Tickets de vente / caisse | **Absents**. Aucune table de ticket, de session ou de point de vente. | `grep` sur `supabase/migrations` (tickets, `pos`, `shift`, `retail`) : aucun résultat. Matrice POS-01 « Absent », POS-02 « Absent » (P1/V2). |
| Vente sans client | **Impossible** : une facture exige un client. | `supabase/migrations/0012_commercial.sql` (`invoices.client_id not null`) |
| « Caisse » | Désigne la **trésorerie** (comptes et mouvements de caisse), pas un point de vente. | `docs/MATRICE_ECARTS_CDC.md` ligne 194 ; `supabase/migrations/0022_finance.sql` (`cash_accounts`, `cash_movements`) |
| Boutiques | Existent comme **types** : site `shop` et entrepôt `shop`. Aucun processus de vente associé. | `supabase/migrations/0032_sites.sql` (`sites.kind`) ; `0062_warehouse_lots_units.sql` et `0065_stock_transfers_transit.sql` (`warehouses.kind`) |
| Comptage de stock | **Existe** : comptage aveugle, écart appliqué à la validation. Réutilisable pour le stock magasin. | `supabase/migrations/0009_stock.sql` (`stock_inventory_lines`) ; `0066_inventory_blind_count_approval.sql` ; test `inventory_blind_approval` |
| Transferts de stock | **Existent** (avec transit), via le module stock. À réutiliser pour les transferts magasin ↔ entrepôt. | `supabase/migrations/0065_stock_transfers_transit.sql` ; test `stock_transfers_transit` |
| Rapprochement bancaire | **Existe** : import de relevés et rapprochement. Réutilisable pour le dépôt de caisse en banque. | `supabase/migrations/0087_bank_statements_reconciliation.sql` ; test `bank_statements_reconciliation` |
| Visa / séparation des tâches | **Existe** : moteur d'approbation et séparation auteur / valideur, réutilisable pour le visa du responsable. | `0033_delegations_sod.sql` ; patterns de 0089 à 0091 (`SOD_SELF_APPROVAL`) |

## 2. Dépendances manquantes

1. **Ticket de vente** : aucune source des montants « attendus ». Sans tickets, le montant attendu serait saisi à la main : c'est une façade, interdite par le brief.
2. **Session de caisse** : ouverture (fonds de caisse), clôture, et règle « une session close ne se modifie plus ». Rien n'existe.
3. **Règles fiscales de caisse** (numérotation des tickets, mentions, TVA par ligne, conservation) : à fournir par l'expert-comptable ; `CLAUDE.md` interdit de les deviner.
4. **Modes de paiement et promotions** (POS-01) : non définis.
5. **Données réelles** : aucune boutique, aucun article de vente au détail, aucun fonds de caisse ne sont fournis. Les tests utiliseraient des fixtures fictives.

## 3. Proposition de conception (à valider, non implémentée)

- **Ticket** : en-tête (session, boutique, numéro séquentiel, date, mode de paiement), lignes (article, quantité, prix, TVA), immuable une fois validé. Une correction se fait par un ticket d'annulation qui référence l'original : **aucune modification rétroactive**.
- **Session de caisse** : ouverture avec fonds de caisse ; ventes rattachées ; comptage à la clôture par mode de paiement ; attendu = fonds + encaissements espèces − remboursements espèces ± mouvements saisis. Session close = immuable ; toute correction passe par une session de régularisation distincte.
- **Écart** : écart = réel − attendu, par mode de paiement, visible et journalisé. Visa du responsable : une personne distincte du caissier (`SOD_SELF_APPROVAL`). Seuil d'alerte : valeur à fournir.
- **Rapprochement banque** : dépôt de caisse rapproché à la ligne de relevé (module 0087 existant).
- **Stock magasin** : comptage aveugle du stock de la boutique (module 0009/0066 existant) ; transferts magasin ↔ entrepôt via 0065 ; rapprochement stock théorique (ventes + transferts) / comptage.

## 4. Décisions demandées au propriétaire

| # | Décision | Recommandation |
|---|---|---|
| D1 | Faut-il un module de point de vente à ce stade (POS-01 et POS-02 sont P1/V2 dans la matrice) ? | Le repousser en V2 comme la matrice, sauf besoin immédiat |
| D2 | Règles fiscales de caisse (numérotation, mentions, conservation, TVA par ligne) | À fournir par l'expert-comptable |
| D3 | Modes de paiement acceptés et règles de remboursement | À fournir |
| D4 | Seuils d'écart d'alerte et de visa | À fournir ; aucune valeur |
| D5 | Boutiques concernées et articles de vente au détail (OPEN-02) | À fournir |
| D6 | Fonds de caisse initial par boutique | À fournir |

## 5. Plan une fois D1 à D6 tranchées

1. Migration additive : tickets et lignes (immuables), sessions de caisse, comptage par mode de paiement, écarts, visa.
2. Services et API ; écrans caisse (ouverture, vente, clôture) et écran responsable (écart, visa).
3. Rapprochement banque des dépôts et rapprochement stock magasin (réutilisation 0009, 0065, 0066, 0087).
4. Tests : écart visible ; session close protégée (modification refusée) ; ticket corrigé seulement par annulation ; stock magasin rapproché ; séparation des tâches.

## 6. Preuves de ce cadrage

- Recherche de tickets, sessions, point de vente dans `supabase/migrations` : aucune table correspondante.
- Lecture de `0012` (`invoices.client_id not null`), `0009` et `0066` (comptage), `0065` (transferts), `0087` (rapprochement), `0032` (types de site), matrice POS-01 / POS-02.
- Aucun code modifié, aucun test exécuté pour P077.
