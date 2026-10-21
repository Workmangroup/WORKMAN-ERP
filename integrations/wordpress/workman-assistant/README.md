# Assistant Workman — plugin WordPress (www.workman-stid.com)

Plugin qui affiche la bulle « Assistant Workman » en bas de page du site WordPress. Il est **inactif par défaut** : rien n'est affiché tant que l'option « Activer la bulle » n'est pas cochée.

## Contenu

- `workman-assistant.php` : plugin (réglages, chargement du script, configuration).
- `assets/workman-assistant.js` : script de la bulle, copie de `web/public/assistant/workman-assistant.js`.
- `uninstall.php` : supprime le réglage à la désinstallation.
- `tests/run.php` : tests de la logique PHP, sans WordPress.

## Installation

1. Compresser le dossier `workman-assistant/` en `workman-assistant.zip`.
2. Dans WordPress : Extensions > Ajouter > Téléverser une extension, puis activer « Assistant Workman ».
3. Réglages > Assistant Workman : choisir la langue et, si besoin, le lien de contact. Ne cocher « Activer la bulle » qu'après validation (voir ci-dessous).

Le plugin charge le script en différé, dans le pied de page, et uniquement côté public. Il n'appelle aucun service externe.

## Conditions d'activation

- Ne pas activer sur le site public avant la décision **D9** (moteur IA) et la validation juridique **D3** (transferts de données). Tant que la conversation n'est pas branchée, la bulle n'affiche qu'un message d'information.
- Le plugin ne modifie ni le thème ni la base, hors une option `workman_assistant_settings`.

## Mise à jour du script

Le script est une copie. Après toute modification de `web/public/assistant/workman-assistant.js`, recopier le fichier :

```
cp web/public/assistant/workman-assistant.js integrations/wordpress/workman-assistant/assets/
```

## Vérifications exécutées (21 octobre 2026)

- `php -l` sans erreur sur `workman-assistant.php` et `uninstall.php`.
- `php tests/run.php` : 16 contrôles réussis, 0 échec. Ils portent sur les valeurs par défaut, le nettoyage des réglages (langue, lien `javascript:` refusé), l'absence de chargement quand la bulle est désactivée ou dans l'administration, le chargement en différé et la configuration injectée.
- Le comportement du script dans le navigateur est couvert par les 16 contrôles de la bulle (`web/public/assistant/README.md`).

## Non vérifié

- **Le site www.workman-stid.com** : l'environnement de développement n'y accède pas (connexion refusée par le proxy). Le thème, les extensions de cache et les règles de sécurité du site n'ont pas été contrôlés.
- **WordPress réel** : les tests utilisent des fonctions simulées. Il faut tester le plugin sur une copie du site (environnement de préproduction) avant de l'installer en production.
- **Compatibilité** : WordPress 6.3 ou plus récent et PHP 8.1 ou plus récent (exigences déclarées).
