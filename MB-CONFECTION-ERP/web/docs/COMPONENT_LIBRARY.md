# WORKMAN ERP 360 — Bibliothèque de composants

Tokens : [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md). Règles d'usage : [UX_GUIDELINES.md](UX_GUIDELINES.md).
Chaque composant est écrit une fois, dans `src/components/` (génériques) ou `src/features/<module>/components/` (métier), et réutilisé partout.

Légende de statut : **Existant** (en place, utilisé) · **Partiel** (en place, à compléter) · **À créer** (prévu).

---

## 1. Fondations

| Élément | Source | Statut | Notes |
|---|---|---|---|
| Tokens couleur clair/sombre | `src/app/globals.css` | Existant | variables `--c-*`, mapping Tailwind `@theme` |
| Icônes | `lucide-react` | Existant | 16 px (texte), 20 px (en-tête/navigation) |
| Police | pile système | Existant | pas de police téléchargée |
| Contrainte de classe | `cn()` (`src/lib/utils.ts`) | Existant | fusion des classes Tailwind |

---

## 2. Boutons

**Fichier** : `src/components/ui/button.tsx` — `Button`, `buttonVariants`.

| Variante | Usage | Rendu |
|---|---|---|
| `primary` | action principale de l'écran ou du formulaire (une seule par zone) | fond `brand-500`, texte blanc |
| `secondary` | action secondaire (annuler, exporter) | bordure `line-strong`, fond `surface` |
| `ghost` | action discrète dans une ligne ou une carte | sans bordure, survol `canvas` |
| `command` | navigation de l'en-tête (« Retour », « Imprimer ») | bordure fine |
| `danger` | action irréversible (confirmée) | texte `danger` |

| Taille | Hauteur | Usage |
|---|---|---|
| `sm` | 28 px | ligne de tableau, badge d'action |
| `default` | 32 px | défaut |
| `lg` | 40 px | mobile, action de formulaire principale |

**États** : repos, survol, focus (anneau `brand-500`), actif, désactivé (opacité 40 %), chargement (`SubmitButton` affiche le libellé « … »).
**À faire** : ajouter un état « chargement » visuel générique (spinner) — aujourd'hui géré par `SubmitButton`.

| Composant | Fichier | Statut |
|---|---|---|
| `SubmitButton` (liaison formulaire / action serveur, état en attente) | `src/components/auth/submit-button.tsx` | Existant |
| `RpcButton` (action serveur sans formulaire, confirmation facultative) | `src/features/stock/components/rpc-button.tsx` | Existant — à déplacer dans `components/common/` |

---

## 3. Champs de formulaire

| Composant | Fichier | Statut | Notes |
|---|---|---|---|
| `Input` | `src/components/ui/input.tsx` | Existant | hauteur 32 px, bordure `line-strong`, focus `brand-500` |
| `Textarea` | `src/components/ui/textarea.tsx` | Existant | |
| `Select` | `src/components/ui/select.tsx` | Existant | liste native (accessible, mobile-friendly) |
| `Checkbox` | `src/components/ui/checkbox.tsx` | Existant | |
| `Label` | `src/components/ui/label.tsx` | Existant | toujours au-dessus du champ |
| `FormField` | `src/components/auth/form-field.tsx` | Existant | libellé + aide + erreur ; **à déplacer dans `components/ui/`** |
| `PasswordInput`, `PasswordStrength` | `src/components/auth/` | Existant | spécifiques à l'authentification |
| Sélecteur de date | natif `input type="date"` | Existant | |
| Recherche avec suggestions (combobox) | — | **À créer** | nécessaire pour clients, articles, composants (listes longues) |
| Sélecteur de valeurs multiples | — | **À créer** | filtres multi-statuts |

**Anatomie `FormField`** : libellé (`text-sm font-medium`), champ, texte d'aide (`ink-faint`, sous le champ), message d'erreur (`danger`, avec icône, sous le champ). Le champ porte `aria-invalid` et `aria-describedby`.

---

## 4. Cartes et panneaux

| Composant | Fichier | Statut |
|---|---|---|
| `Card`, `CardHeader`, `CardTitle`, `CardContent` | `src/components/ui/card.tsx` | Existant |
| `PageHeader` (titre, description, action principale) | `src/components/layout/page-header.tsx` | Existant |
| Carte KPI (libellé, valeur, contexte) | motif répété dans les pages `dashboard/dg`, `finance`, `quality`, `shipping` | Partiel — **à extraire en `KpiCard`** |
| Carte d'alerte (gravité, phrase, lien) | `src/features/executive/components/executive-live.tsx`, `src/features/copilot/components/copilot-chat.tsx` | Partiel — **à extraire en `AlertCard`** |
| Panneau latéral (détail sans quitter la liste) | — | **À créer** |

**Carte KPI** (cible) : libellé `ink-soft` 12 px ; valeur 24 px `tabular-nums` ; contexte 12 px `ink-faint` (variation ou objectif) ; état `danger`/`warning` par la couleur **et** une icône.

---

## 5. Tableaux

| Composant | Fichier | Statut | Notes |
|---|---|---|---|
| Tableau HTML stylé | motif répété dans les pages (`<table>` + `overflow-x-auto`) | Existant (non factorisé) | **À extraire en `DataTable`** |
| Badge de statut | `src/components/ui/badge.tsx` | Existant | tons : `neutral`, `brand`, `success`, `warning`, `danger` |
| Filtres par chips | motif répété (`/finance`, `/quality`, `/shipments`) | Partiel | **À extraire en `FilterChips`** |
| Pagination | — | **À créer** | nécessaire au-delà de 200 lignes (aujourd'hui limite fixe) |
| Tri par colonne | — | **À créer** | |
| Sélection multiple et actions groupées | — | **À créer** | |

**Règles `DataTable`** (cible) : en-tête collant ; colonne clé figée sur mobile ; alignement à droite pour les nombres ; densité `comfortable` (48 px) ou `compact` (36 px) ; états vide, chargement et erreur intégrés.

---

## 6. Dialogues et feedback

| Composant | Fichier | Statut | Notes |
|---|---|---|---|
| `Dialog` | `src/components/ui/dialog.tsx` | Existant | voile `black/40`, focus piégé, fermeture `Échap` |
| `ActionDialog` (dialogue + formulaire + action serveur) | `src/components/common/action-dialog.tsx` | Existant | cœur des saisies rapides |
| `Alert` (succès, alerte, danger, info) | `src/components/ui/alert.tsx` | Existant | |
| Confirmation d'action irréversible | `window.confirm` dans `RpcButton` | Partiel | **À remplacer par un dialogue de confirmation** qui nomme l'objet |
| Notification éphémère (toast) | — | **À créer** | confirmations de succès qui ne bloquent pas |

---

## 7. Navigation

| Composant | Fichier | Statut | Notes |
|---|---|---|---|
| Barre latérale | `src/components/layout/side-nav.tsx` | Existant | à réduire : groupes par étape du processus (§UX 3) |
| Tiroir mobile | `MobileNav` (même fichier) | Existant | |
| En-tête d'application | `src/components/layout/app-shell.tsx` | Existant | à compléter : recherche globale, sélecteur de thème |
| Menu utilisateur | `src/components/layout/user-menu.tsx` | Existant | |
| Onglets de module | `ProductionNav`, `QualityNav`, `ShipmentsLayout`, `FinanceLayout`… | Existant (dupliqués) | **À unifier en `ModuleTabs`** |
| Fil d'Ariane | — | **À créer** | |
| Bascule de thème (Système / Clair / Sombre) | — | **À créer** | `data-theme` sur `<html>`, préférence en `localStorage` |
| Recherche globale / palette de commandes (`Ctrl+K`) | — | **À créer** | |

---

## 8. Graphiques

Implémentés en SVG maison (pas de bibliothèque externe), dans `src/features/executive/components/charts.tsx`.

| Composant | Usage | Statut |
|---|---|---|
| `BarChart` | CA mensuel, volumes par période, interactif (survol, clic) | Existant |
| `LineChart` | tendances, trésorerie prévisionnelle, seuils en pointillés `danger` | Existant |
| `HBars` | classements (défauts, charge par poste, statuts) | Existant |
| `Gauge` | pourcentage cible (rendement, délais, efficacité) | Existant |
| Légende partagée | à afficher sous les graphiques à plusieurs séries | **À créer** |
| État vide / erreur de graphique | aujourd'hui texte « Aucune donnée » | Partiel |

**Règles** : titre = conclusion ; 6 séries maximum ; couleurs dans l'ordre `chart-1…6` ; axes à 3 graduations ; pas de 3D ; accessibilité : `role="img"` et `aria-label`, et les valeurs exactes disponibles dans un tableau.

---

## 9. Copilote IA

| Composant | Fichier | Statut |
|---|---|---|
| Interface de conversation (historique, fil, saisie) | `src/features/copilot/components/copilot-chat.tsx` | Existant |
| Rendu d'une réponse (texte, cartes, tableau, graphique, alertes, sources) | `AnswerView` (même fichier) | Existant — à extraire |
| Suggestions de départ (chips) | `SUGGESTED_QUESTIONS` (`src/features/copilot/engine/intents.ts`) | Existant |

---

## 10. Icônes

- Bibliothèque : `lucide-react`. Import nominatif (`import { Plus } from 'lucide-react'`), jamais d'import global.
- Mapping métier à maintenir (ex. `shipments` → `truck`, `quality` → icône dédiée, `finance` → `wallet`) : aujourd'hui dans `src/lib/rbac/menu.ts` sous forme de noms de chaînes.
- Icône seule ⇒ libellé accessible (`aria-label`) ou `title`.

---

## 11. Cartes d'état et vides

| État | Composant cible | Contenu |
|---|---|---|
| Vide (liste) | `EmptyState` (**à créer**) | icône, phrase, **une** action |
| Chargement | `Skeleton` (**à créer**) | blocs gris animés, sans clignotement |
| Erreur | `Alert` danger + « Réessayer » | cause en langage métier |
| Droit insuffisant | page `unauthorized` (existante) | message + retour |

---

## 12. Plan de factorisation (ordre recommandé)

1. Extraire `DataTable`, `KpiCard`, `AlertCard`, `FilterChips` depuis les pages existantes (pas de nouvelle fonctionnalité).
2. Déplacer `FormField` et `RpcButton` vers `components/ui/` et `components/common/`.
3. Unifier les onglets de module en `ModuleTabs`.
4. Ajouter bascule de thème, recherche globale, notifications toast, dialogue de confirmation.
5. Ajouter combobox, pagination, tri et sélection multiple.

---

## 13. Liste de contrôle avant livraison d'un écran

- [ ] Utilise uniquement les tokens (aucune couleur en dur).
- [ ] Testé en clair **et** en sombre.
- [ ] Testé à 375 px, 768 px et 1280 px ; pas de défilement horizontal de page.
- [ ] Une seule action principale ; ≤ 5 KPI par rangée.
- [ ] États vide, chargement et erreur présents.
- [ ] Contraste AA, focus visible, navigation clavier.
- [ ] Statuts avec libellé (pas la couleur seule).
- [ ] Textes en français, vocabulaire métier, pas de jargon technique.
