# WORKMAN ERP 360 — Identité visuelle et Design System

Source de vérité : `src/app/globals.css` (variables `--c-*` mappées sur Tailwind dans `@theme`).
Règles d'usage : [UX_GUIDELINES.md](UX_GUIDELINES.md). Composants : [COMPONENT_LIBRARY.md](COMPONENT_LIBRARY.md).

## 1. Style

Professionnel, industriel, premium, moderne. Une interface sobre où les données sont lisibles en un coup d'œil, utilisée 8 heures par jour.

**Règle fondamentale : jamais plus de 3 couleurs simultanées sur une même vue.** Le fond neutre (blanc ou `Background`) et le texte (`Dark`) ne comptent pas. Les trois couleurs sont choisies parmi la primaire, la secondaire et un état (succès, alerte ou danger).

## 2. Couleurs

| Rôle | Hex | Usage |
|---|---|---|
| **Primary** | `#0F4C81` | action principale, liens, sélection, focus, navigation active |
| **Secondary** | `#FDB913` | accent ponctuel : mise en avant, badge « nouveau », point d'attention non critique |
| **Success** | `#22C55E` | livré, conforme, validé (icône et fond) |
| **Warning** | `#F59E0B` | à surveiller, en retard léger (icône et fond) |
| **Danger** | `#EF4444` | bloqué, critique, en retard (icône et fond) |
| **Background** | `#F8FAFC` | fond de page |
| **Dark** | `#0F172A` | texte principal, bandeau d'application, mode sombre |

### Teintes dérivées (fonds et textes)

| Token | Valeur | Usage |
|---|---|---|
| `brand-50` à `brand-300` | `#EEF4FA` → `#8FB4D9` | fonds de sélection, bordures actives, graphiques |
| `brand-600` / `brand-700` | `#0C3F6B` / `#0A3459` | survol et pressé du bouton principal |
| `success-bg`, `warn-bg`, `danger-bg` | `#DCFCE7`, `#FEF3C7`, `#FEE2E2` | fond des badges et alertes |
| `success-text`, `warn-text`, `danger-text` | `#15803D`, `#B45309`, `#DC2626` | **texte** d'état (contraste AA sur fond blanc) |
| `ink-soft` / `ink-faint` / `line` | `#475569` / `#64748B` / `#E2E8F0` | texte secondaire, aide, séparateurs |

**Pourquoi des versions « -text » ?** `#22C55E`, `#F59E0B` et `#EF4444` sont trop clairs pour du texte sur fond blanc (contraste inférieur à 4,5:1). Les couleurs d'identité restent utilisées pour les icônes, les points et les fonds. Le texte d'état utilise la variante foncée.

### Mode sombre

Même logique : fond `Dark` (`#0F172A`), surfaces `#17223A`, primaire éclaircie (`#7FB0E3`) pour rester lisible. Le mode suit le système par défaut ; l'utilisateur peut forcer `data-theme="light"` ou `"dark"`.

## 3. Typographie

- **Police** : Inter (400, 500, 600, 700), chargée depuis Google Fonts ; repli sur la pile système.
- **Tailles** (seules autorisées) : **12 · 14 · 16 · 18 · 24 · 32** px.

| Token Tailwind | Taille | Usage |
|---|---|---|
| `text-xs` | 12 px | libellés de tableau, métadonnées, aide |
| `text-sm` | 14 px | texte courant, champs, tableaux (base de l'application) |
| `text-base` | 16 px | texte de lecture, paragraphes |
| `text-lg` | 18 px | titres de carte, sous-titres |
| `text-xl` | 24 px | titres de section, valeurs KPI |
| `text-2xl` | 32 px | titre de page, grands chiffres |

Graisses : 400 (texte), 500 (libellés, boutons), 600 (titres), 700 (chiffres clés uniquement). Chiffres et montants en `tabular-nums`.

## 4. Rayons

| Token | Valeur | Usage |
|---|---|---|
| `rounded-sm` | 12 px | badges, petits éléments |
| `rounded-md` | 16 px | boutons, champs, cartes (défaut) |
| `rounded-lg` | 24 px | grandes cartes, panneaux, dialogues |

## 5. Ombres

Ombres douces, jamais dures :

- `shadow-card` : `0 1px 2px rgba(15,23,42,.04), 0 4px 16px -4px rgba(15,23,42,.08)`
- `shadow-pop` (menus, dialogues) : `0 2px 4px rgba(15,23,42,.04), 0 12px 32px -8px rgba(15,23,42,.14)`

Pas d'ombre dans les tableaux.

## 6. Espacements

Échelle de 4 px : `1` = 4, `2` = 8, `3` = 12, `4` = 16, `6` = 24, `8` = 32 px. Gouttière mobile : 16 px. Espacement entre blocs : 16 px ; entre sections : 24 px.

## 7. Breakpoints

| Plage | Largeur | Comportement |
|---|---|---|
| Mobile | < 640 px | menu tiroir, une colonne, tableaux défilants |
| Tablette | 640–1023 px | menu tiroir, deux colonnes |
| Desktop | ≥ 1024 px | barre latérale permanente, tableaux complets |

## 8. Icônes

Bibliothèque **Lucide** uniquement. 16 px dans le texte, 20 px dans la navigation. Trait par défaut, couleur héritée du texte.

## 9. Graphiques

- Au plus **3 séries de couleur** par graphique : primaire, secondaire, puis gris (`chart-3`).
- Au-delà : des tons de la primaire (`chart-4`, `chart-5`, `chart-6`), sans ajouter de couleur d'identité.
- Seuils et limites : pointillés en `danger-text`.
- Titre = conclusion. Pas de 3D.

## 10. Mouvement

Durées : 120 ms (survol), 200 ms (panneaux), 320 ms (apparition de message). Animations légères uniquement, désactivées si l'utilisateur demande un mouvement réduit.

## 11. Logo

Logo « MB CONFECTION [WORKMAN] GROUP » en bleu de marque. Fichier attendu dans `public/`. La couleur de la primaire (`#0F4C81`) est proche du bleu du logo.
