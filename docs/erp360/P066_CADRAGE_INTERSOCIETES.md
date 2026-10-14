# P066 — Intersociétés et consolidation : dossier de cadrage

Statut : **cadrage, aucune implémentation**. Le lot ne peut pas être livré en l'état : trois décisions du propriétaire manquent, et le modèle de données ne permet pas de lire plusieurs sociétés. Aucun code, aucune migration, aucune donnée n'ont été créés.

## 1. Existant inspecté

| Élément | Constat | Preuve |
|---|---|---|
| Sociétés | Une seule société est semée : « MB Confection » (TN). WORKMAN, STID EXPORT et SOMICO n'existent pas. | `supabase/migrations/0002_auth_seed.sql` (insertion conditionnelle, 1 ligne) |
| Rattachement utilisateur | Un profil porte un seul `company_id`, obligatoire. Pas de table d'appartenance multi-sociétés. | `supabase/migrations/0001_auth_core.sql` (`profiles.company_id not null`) |
| Isolation | `private.current_company()` lit `profiles.company_id` ; 84 fichiers de migration l'utilisent dans leurs politiques ou leurs fonctions. Aucune lecture inter-sociétés n'est prévue. | `private.current_company` (0001) ; `grep current_company supabase/migrations` |
| Intersociétés | Non implémenté. Les documents réciproques sont renvoyés à OPEN-04 (V2). | `supabase/migrations/0065_stock_transfers_transit.sql` (en-tête) ; `docs/erp360/PROJECT_STATE.md` lignes 52, 911, 918 |
| Matrice | FIN-11 « Rapprochement intersociétés, éliminations, consolidation » : *Absent*, P1/V2. ORG-003 : *Absent*. | `docs/MATRICE_ECARTS_CDC.md` lignes 46, 217 |
| Tiers groupe | `party` regroupe des fiches clients et fournisseurs d'un même tiers, dans une seule société. Le rattachement entre sociétés n'est pas créé par l'application. | `supabase/migrations/0038*` ; PROJECT_STATE P015 (limites) |
| Trésorerie | « Consolidée » ne signifie que l'addition des comptes d'une même société. | `supabase/migrations/0022_finance.sql` ligne 392 |
| Multi-sociétés | « Sociétés multiples par utilisateur » et « sélecteur de société active » restent à faire (lot L1). | `docs/erp360/PROJECT_STATE.md` ligne 61 |

## 2. Écart avec la demande

La demande indique « Méthode/périmètre groupe validés ». **Je n'ai trouvé aucune trace de cette validation** dans le dépôt : ni dans `PROJECT_STATE.md`, ni dans `MATRICE_ECARTS_CDC.md`, ni dans `docs/`. Les points OPEN-01 à OPEN-04 sont tous ouverts. Je ne déduis ni la méthode de consolidation, ni le périmètre, ni les flux : `CLAUDE.md` interdit de deviner ces points.

## 3. Blocages

1. **Méthode et périmètre de consolidation** (intégration globale, proportionnelle ou mise en équivalence ; sociétés incluses) : non tranchés dans le dépôt.
2. **OPEN-04** : flux intersociétés (facture réciproque, avoir, refacturation, prêt) et devise fonctionnelle de chaque société : non tranchés.
3. **Modèle d'accès groupe** : sans rattachement multi-sociétés ni rôle groupe, un utilisateur ne peut pas voir deux sociétés. Une lecture croisée serait une fuite d'information inter-sociétés, interdite par `CLAUDE.md` (refus par défaut, contrôle serveur de la société). Ce choix touche la sécurité : il appartient au propriétaire.
4. **Données réelles** (OPEN-01, OPEN-02) : les trois autres sociétés et leurs sites n'existent pas. Sans elles, aucun rapprochement réel n'est possible. Des jeux de test fictifs suffiraient aux tests, mais pas à une livraison.

## 4. Proposition de conception (à valider, non implémentée)

- **Rapprochement par paire.** Une paire = (société émettrice, société contrepartie). Chaque document d'une société est rapproché à son document réciproque de l'autre : facture client ↔ facture fournisseur, avoir ↔ avoir, créance ↔ dette, vente ↔ achat. Chaque écart est classé : montant, date, document absent d'un côté, devise. Les contrôles portent sur le montant en devise de transaction et sur le montant en devise de base.
- **Tolérance.** Montant et délai de rapprochement : valeurs à fournir par le propriétaire. Aucune valeur par défaut n'est retenue.
- **Accès groupe.** Une table d'appartenance (utilisateur ↔ sociétés) et un rôle groupe borné aux paires déclarées, accordés par le serveur. Les politiques existantes ne sont pas élargies. Chaque lecture croisée est auditée.
- **Éliminations et marges internes.** Périmètre séparé : tables `consolidation_*` distinctes, jamais d'écriture dans `gl_entries` d'une société. Dépend de la méthode (décision 1).
- **Livres sociaux intacts.** Preuve par test : comptage et empreinte des lignes `gl_entries`, `gl_entry_lines` et des factures de chaque société avant et après le lot, avec égalité exacte.

## 5. Décisions

Décisions retenues sur demande du propriétaire (« décider pour moi ») pour les choix d'architecture et de sécurité ; les points métier restent ouverts, faute de fait fourni.

| # | Décision | Statut | Motif |
|---|---|---|---|
| D1 | Méthode de consolidation et périmètre (sociétés, pourcentages de détention) | **Ouvert** : à fournir par le propriétaire, validé par l'expert-comptable | Choix comptable ; `CLAUDE.md` interdit de le deviner |
| D2 | Périmètre de départ : facture et avoir réciproques entre sociétés ; autres flux plus tard. Devise fonctionnelle : à fournir pour chaque société | **Retenu** pour le périmètre de départ ; devise **ouverte** | Réduit le risque ; la devise dépend de données non fournies |
| D3 | Accès groupe : table d'appartenance utilisateur ↔ sociétés et rôle groupe borné aux paires déclarées, sans élargir les politiques existantes | **Retenu** | Refus par défaut et contrôle serveur exigés par `CLAUDE.md` ; une lecture croisée reste auditée |
| D4 | Tolérances de rapprochement (montant, délai) | **Ouvert**, laissé vide | `CLAUDE.md` : un paramètre « à confirmer » reste vide tant qu'il n'est pas fourni |
| D5 | Données des sociétés (OPEN-01, OPEN-02) | **Ouvert** : à fournir | Aucune société ni site inventé |

Conséquence : le lot peut démarrer sur D2 (périmètre de départ) et D3 (architecture d'accès) dès que D1 et D5 sont au moins partiellement fournis pour les tests. Les tests peuvent utiliser des jeux fictifs, jamais en production.

## 6. Plan une fois D1 à D5 tranchées

1. Migration additive : appartenance utilisateur ↔ sociétés, rôle groupe, tables de documents réciproques et d'écarts. Aucun `DROP`, aucune modification de `profiles.company_id`.
2. Services et API de rapprochement par paire ; écran liste des paires, détail des écarts, traitement avec motif.
3. Éliminations et marges internes dans les tables `consolidation_*`, séparées des livres sociaux.
4. Tests : rapprochement exact, écart classé, refus d'accès hors paire, livres sociaux inchangés (empreinte avant/après), audit de chaque lecture croisée.

## 7. Preuves de ce cadrage

- Lecture des migrations 0001, 0002, 0022, 0038, 0065 et de `PROJECT_STATE.md`, `MATRICE_ECARTS_CDC.md` : résultats ci-dessus.
- Recherche de la validation méthode/périmètre : aucune occurrence dans `docs/` ou `supabase/` (recherche « méthode de consolidation », « périmètre de consolidation », « intégration globale », « mise en équivalence », « OPEN-0x »).
- Aucun code modifié, aucun test exécuté pour P066 (rien à tester). La suite de P065 reste la dernière preuve de non-régression (4 185 PASS, 0 FAIL).
