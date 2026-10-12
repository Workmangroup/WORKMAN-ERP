# WORKMAN ERP 360 — Règles UX

Référence : [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) (tokens) et [COMPONENT_LIBRARY.md](COMPONENT_LIBRARY.md) (composants).
Inspirations retenues : Dynamics 365 (structure métier, tableaux), Linear (densité, clavier), Stripe (clarté des chiffres), Notion (pages épurées), Odoo (formulaires en sections), Monday et HubSpot (listes et statuts visuels).

## 1. Principes

1. **Une tâche par écran.** Chaque page répond à une question d'un rôle (« que dois-je faire aujourd'hui ? »).
2. **L'essentiel d'abord.** Alertes, décisions en attente et indicateurs en haut ; le détail en dessous ou dans un panneau.
3. **Moins de boutons, plus de contexte.** Une action principale par écran. Les actions secondaires vont dans un menu `⋯`.
4. **Pas de surprise.** Toute action irréversible demande confirmation claire ; toute action réussie confirme ce qui a changé.
5. **Utilisable 8 h par jour.** Densité confortable, raccourcis clavier pour les actions répétées, aucun clignotement, aucune animation décorative.

### Interdits (et comment nous les évitons)

| Interdit | Règle appliquée |
|---|---|
| Design ancien ERP | Pile système, cartes à ombre douce, pas de bordures épaisses ni de dégradés métier |
| Interfaces surchargées | ≤ 5 KPI par rangée, ≤ 7 éléments par groupe de menu, pas plus d'un graphique par bloc |
| Trop de boutons | 1 action principale visible par écran ; le reste dans `⋯` |
| Trop de couleurs | Bleu d'action, 3 états, neutres. Les 6 couleurs de graphique ne sont jamais des couleurs d'interface |
| Formulaires interminables | ≤ 6 champs visibles par section ; sections repliables ; formulaire découpé en étapes au-delà de 12 champs |
| Menus compliqués | Accueil par rôle ; favoris ; 2 niveaux maximum de navigation |

## 2. Accueil par rôle

Chaque rôle arrive sur **son** écran d'accueil, avec les 3 à 5 tâches qu'il traite le plus.

| Rôle | Accueil | Contenu prioritaire |
|---|---|---|
| Direction générale | Tableau de bord DG (`/dashboard/dg`) | Alertes stratégiques, CA et marge, trésorerie, retards |
| Commercial | Commercial (`/commercial`) | Devis à relancer, commandes à expédier, pipeline |
| Achat | Achats (`/purchases`) | Besoins MRP, commandes en retard, fournisseurs en litige |
| Magasin | Stock (`/stock`) | Préparations à faire, picking, réceptions du jour |
| Production | Production (`/production`) | Ordres du jour, retards, postes surchargés |
| Qualité | Qualité (`/quality`) | Contrôles à décider, non-conformités ouvertes, actions en retard |
| Finance | Finance (`/finance`) | Encaissements, relances, balances âgées, prévisions |

> Aujourd'hui, tous les rôles arrivent sur `/dashboard` (profil et rôles). **Action à réaliser** : rediriger l'accueil selon le rôle principal, et laisser `/dashboard` en page de compte.

## 3. Navigation

- **Barre latérale** (desktop) : groupes en langage métier (Général, Commercial, Opérations, Finance, Administration). Au plus **7 entrées visibles par groupe**.
- **Tiroir** (mobile et tablette) : même structure, ouverture par le bouton `☰`.
- **Fil d'Ariane** sur toute page détail : `Module › Liste › Fiche`.
- **Recherche globale** (raccourci `/`) : clients, articles, commandes, factures, ordres. Mémoriser les 5 derniers éléments consultés.
- Un élément de menu sans droit **n'apparaît pas** (pas de cadenas inutile).

> **Constat honnête** : la barre actuelle compte environ 30 entrées, dont 12 dans « Commercial » (`web/src/lib/rbac/menu.ts`). C'est le « menu compliqué » à corriger : regrouper par étapes du processus (Vendre, Fabriquer, Acheter-stocker, Expédier, Contrôler, Facturer), et masquer les entrées sans usage pour le rôle.

## 4. Anatomie d'une page

1. **En-tête** : titre (1 ligne), description courte, **une** action principale à droite.
2. **Barre de filtres** : chips de statut au-dessus du tableau, recherche à gauche. Pas plus de 4 filtres visibles ; les autres dans « Filtres ».
3. **Alertes contextuelles** : en haut du contenu, avant les données.
4. **Contenu** : tableau, liste de cartes ou formulaire.
5. **Traçabilité** : onglet ou section repliée « Historique » en bas des fiches.

## 5. Tableaux

- Densité par défaut « confortable » (ligne 44–48 px). Option « compacte » (36 px) pour les saisies intensives.
- En-tête collant au défilement. Colonne clé (numéro, nom) figée sur mobile.
- Tri par clic sur l'en-tête ; une seule colonne triée à la fois.
- Nombres et montants alignés à droite, `tabular-nums`, unité dans l'en-tête.
- Statut = badge avec libellé (jamais la couleur seule).
- Ligne cliquable entière → fiche ; l'action d'une ligne (`⋯` ou bouton) ne déclenche jamais une action irréversible sans confirmation.
- **États** : chargement (squelette), vide (message + action « Créer »), erreur (message + « Réessayer »), aucun résultat (« Réinitialiser les filtres »).

## 6. Formulaires

- **Une page ou un dialogue par tâche.** Dialogue pour les saisies courtes (≤ 6 champs) ; page pour le reste.
- Libellé **au-dessus** du champ, jamais seulement un placeholder. Astérisque pour les champs obligatoires, plus une légende.
- Champs regroupés par sections claires (« Identité », « Livraison », « Montants »), 2 colonnes sur desktop, 1 colonne sur mobile.
- Valeurs par défaut intelligentes (date du jour, devise de la société, dernière valeur utilisée).
- Validation **au moment de quitter le champ**, message d'erreur sous le champ, en texte (pas seulement en rouge). Le premier champ en erreur reçoit le focus.
- Boutons en pied de formulaire : « Annuler » (secondaire) et « Enregistrer » (principal, à droite). Sur mobile, pleine largeur, empilés.
- Enregistrement : état « Enregistrement… » sur le bouton, puis confirmation (`Alert` succès) avec ce qui a été créé (numéro).
- Un formulaire ne se perd pas : brouillon conservé si on quitte la page par erreur (à implémenter pour les saisies longues).

## 7. Tableaux de bord et indicateurs

- **5 indicateurs maximum par rangée.** Chaque indicateur : libellé, valeur, contexte (variation ou objectif), et lien vers la liste concernée.
- **Les alertes passent avant les graphiques.** Une alerte = gravité (critique, avertissement, information), phrase claire, action.
- **Graphiques** : un message par graphique (titre = conclusion, « CA en baisse depuis mars »). Interactifs : survol pour le détail, clic pour filtrer. Jamais de graphique 3D, jamais plus de 6 séries.
- **Temps réel** : l'horodatage « mis à jour il y a X s » est toujours visible. Le rafraîchissement automatique est signalé (pas de changement silencieux de chiffres sous les yeux de l'utilisateur sans indication).
- Les chiffres sans source ou sans période ne sont pas affichés.

## 8. Retour d'information

| Situation | Retour |
|---|---|
| Action réussie | Message bref (« Facture FAC-2026-0042 émise ») avec lien vers l'objet |
| Erreur de saisie | Message sous le champ, en langage métier, avec la correction attendue |
| Erreur système | Message général + « Réessayer » ; pas de trace technique |
| Action irréversible | Dialogue de confirmation qui nomme l'objet et la conséquence ; bouton en danger |
| Action longue (calcul MRP, export) | Indicateur de progression ou message « vous pouvez continuer » |
| Droit insuffisant | Message « Vous n'avez pas la permission… » et journalisation (déjà en place) |

## 9. Accessibilité et clavier

- Contraste AA dans les deux thèmes (voir DESIGN_SYSTEM §2.5).
- Tout est atteignable au clavier ; focus visible (anneau `brand-500`) ; ordre de tabulation logique.
- Raccourcis : `/` recherche, `Ctrl/⌘ + K` palette de commandes (à créer), `Échap` ferme un dialogue, `Ctrl/⌘ + Entrée` valide un formulaire.
- Les états de chargement et les messages d'état utilisent `aria-live`.
- Cibles tactiles ≥ 44 × 44 px sur mobile.

## 10. Responsive

- **Desktop (≥ 1024 px)** : barre latérale, tableaux complets, formulaires 2–3 colonnes.
- **Tablette (640–1023 px)** : tiroir, tableaux avec colonnes secondaires masquées (accessibles via la fiche), formulaires 2 colonnes.
- **Mobile (< 640 px)** : tiroir, cartes au lieu de tableaux pour les listes courantes, actions principales en bas d'écran, pas de défilement horizontal de page. Le magasinier sur tablette ou téléphone est un cas d'usage à part entière (picking, réception).

## 11. Copilote IA

- Interface de conversation en fil, avec historique personnel à gauche et suggestions de départ.
- Chaque réponse indique ses **sources** et reste dans les droits de l'utilisateur.
- Une réponse structurée (carte, tableau, graphique) vaut mieux qu'un long texte. Une réponse sans donnée le dit explicitement.

## 12. Mode sombre

- Même hiérarchie et mêmes règles, couleurs issues des tokens sombres.
- Vérifier chaque écran dans les deux thèmes avant livraison.
- Les graphiques gardent leur ordre de couleurs ; les seuils restent en pointillés.
