# Assistant Workman — bulle d'accueil (www.workman-stid.com)

Script autonome `workman-assistant.js`, sans dépendance. Il affiche une bulle « Assistant Workman » en bas à droite de la page et s'isole du style du site (Shadow DOM).

## État actuel

- **Inactif par défaut** : sans `enabled: true`, rien n'est affiché ni exécuté.
- **Aucun appel réseau** : la conversation n'est pas encore branchée. Le panneau affiche un message d'information et, si configuré, un lien de contact.
- Ne pas activer sur le site public avant la validation juridique des transferts de données (décision D3 d'ADR-002) et le choix du moteur de conversation (décision D1).

## Intégration (quand la décision est prise)

Coller ce bloc dans le pied de page du site, avant `</body>` :

```html
<script>
  window.WorkmanAssistant = {
    enabled: false,              // passer à true uniquement après validation D1 et D3
    lang: 'fr',                  // 'fr', 'en' ou 'ar' (RTL automatique)
    contactUrl: null             // ex. 'https://www.workman-stid.com/contact'
  };
</script>
<script src="https://<hébergement>/assistant/workman-assistant.js" defer></script>
```

Le domaine `<hébergement>` dépend de l'endroit où le dossier `assistant/` est publié (à confirmer).

Les mêmes réglages peuvent aussi être donnés sur la balise `<script>` via `data-enabled`, `data-lang` et `data-contact-url`.

## Accessibilité

- Bouton avec `aria-expanded` et `aria-controls`.
- Ouverture : le focus passe sur « Fermer ». Échap ferme le panneau et rend le focus à la bulle.
- Contraste et focus visibles ; `prefers-reduced-motion` respecté.
- Arabe : `dir="rtl"` sur la bulle.

## Vérifications exécutées (21 octobre 2026)

Chromium headless, pages de test hors dépôt : 16 contrôles réussis, 0 échec.
- Désactivé par défaut : aucun élément créé.
- Ouverture, fermeture, focus et Échap.
- Lien de contact affiché seulement s'il est configuré.
- Position fixe en bas à droite.
- Aucun appel vers un domaine externe.
- Arabe : RTL et libellé correct.

Non vérifié : le site www.workman-stid.com lui-même (domaine non résolu depuis l'environnement de développement) et la compatibilité avec sa plateforme.
