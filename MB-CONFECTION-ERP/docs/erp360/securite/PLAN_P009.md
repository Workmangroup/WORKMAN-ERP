# SSO, MFA et sessions — Lot P009 (WORKMAN ERP 360)

Date : 12 octobre 2026. Statut : **cadrage et contrôles, sans modification de l'authentification**. Le lot ne peut pas être réalisé en l'état : le fournisseur d'identité n'est pas confirmé (décision D-06, ouverte depuis P003).

## 1. Constat (mesuré)

| Élément | État | Preuve |
|---|---|---|
| MFA (TOTP) | **non configuré** : aucune section `[auth.mfa]` dans la configuration | `supabase/config.toml` |
| SSO (OIDC, SAML) | **non configuré** ; aucun fournisseur déclaré | `supabase/config.toml` |
| Écran d'enrôlement MFA | **absent** ; aucune occurrence de MFA, TOTP, SSO, SAML ou OAuth dans `web/src` (recherche de mots entiers) | recherche |
| Expiration du jeton d'accès | 3 600 s | `jwt_expiry` |
| Rotation du jeton de rafraîchissement | activée, intervalle de réutilisation 10 s | `enable_refresh_token_rotation` |
| Inactivité | délai configurable côté web (`AUTH_IDLE_TIMEOUT_MINUTES`) ; événement `session_idle_timeout` déjà journalisé | `web/src/lib/env.ts`, `auth_events` |
| Verrouillage après échecs | paramètres présents (`AUTH_MAX_FAILED_ATTEMPTS`, `AUTH_LOCKOUT_MINUTES`) ; événements `login_failed` journalisés | `auth_events` (4 événements) |
| Révocation de sessions | existante : `rbac_revoke_user_sessions`, `revoke_session`, `revoke_other_sessions` | base locale |
| Journal d'authentification sans secret | les écritures de `auth_events` ne contiennent que l'e-mail, l'événement, l'IP et le navigateur ; aucune journalisation de jeton ou de mot de passe trouvée | `web/src/features/auth/services/audit.service.ts` |
| Clés dans les logs | seul un nom de variable est affiché (ex. absence de la clé de service dans le module de stockage) ; aucune valeur | `web/src/features/ged/services/storage.service.ts` |

## 2. Ce qui est déjà conforme

- Expiration et rotation des sessions : en place.
- Révocation côté administrateur : en place (et couverte par le lot P008).
- Journal des connexions, échecs et expirations : en place, sans secret.
- Aucune trace de jeton ou de mot de passe dans le code journalisé contrôlé.

## 3. Ce qui manque

| Exigence | Manque | Prérequis |
|---|---|---|
| SSO compatible fournisseur d'identité (SEC-01) | aucun fournisseur choisi ; la disponibilité de SSO dépend du plan et de la configuration Supabase, **à vérifier avant tout engagement** (non vérifié ici) | D-06 : choix du fournisseur |
| MFA imposée aux rôles sensibles (SEC-01) | aucune configuration TOTP, aucun écran d'enrôlement, aucune liste de rôles sensibles | D-P009-02 : liste des rôles et permissions sensibles |
| Vérification serveur de l'authentification renforcée | aucune règle `aal2` dans les contrôles de droits (`private.has_perm`) | D-P009-03 : seuil et périmètre |
| Fonctionnement local sans désactiver la protection | non défini | D-P009-04 : mode de développement |

## 4. Proposition de conception (non implémentée)

1. **MFA TOTP** activée dans la configuration Supabase. Pour les rôles sensibles, une fonction de contrôle exige `aal2` dans le jeton (`auth.jwt()->>'aal'`) en plus de la permission, et refuse sinon avec un code dédié (`MFA_REQUIRED`). Aucun contournement n'existe dans le code.
2. **Enrôlement** : écran dédié, obligatoire au premier accès aux rôles sensibles ; codes de secours conservés hors journal.
3. **SSO** : uniquement après D-06 ; la connexion reste nominative, et les comptes techniques restent hors SSO (lot P008).
4. **Développement local** : une configuration explicite (variable d'environnement de développement, refusée hors environnement local) peut désactiver l'exigence MFA **sur la machine du développeur seulement** ; la production n'accepte jamais ce paramètre, et le test vérifie que la production le refuse.
5. **Journal** : chaque événement (connexion, MFA, expiration, révocation) est écrit sans jeton ni secret ; un test vérifie qu'aucune valeur de jeton n'apparaît dans `auth_events`.

## 5. Décisions nécessaires

| ID | Décision | Décideur |
|---|---|---|
| D-06 | Fournisseur d'identité (et confirmation de la disponibilité du SSO sur l'offre retenue) | DSI, lead sécurité |
| D-P009-02 | Rôles et permissions soumis à la MFA (proposition : administration, direction, finance, paie, achats ayant une approbation) | DSI, responsables de domaine |
| D-P009-03 | Durée de session et délai d'inactivité par niveau de risque | lead sécurité |
| D-P009-04 | Règle de développement local (bypass limité à la machine de développement, refusé en production) | lead sécurité |
| D-P009-05 | Politique des codes de secours et de la perte de téléphone | lead sécurité, DSI |

## 6. Contrôles exécutés pour ce lot

| Contrôle | Résultat |
|---|---|
| Présence de MFA, TOTP, SSO, SAML, OAuth dans `web/src` (mots entiers) | **0 occurrence** |
| Configuration `[auth.mfa]` dans `supabase/config.toml` | **absente** |
| Journalisation de jetons ou mots de passe dans `web/src` (`console.*`) | **aucune valeur sensible** ; un seul message contient un nom de variable |
| Écritures de `auth_events` : champs enregistrés | e-mail, événement, IP, navigateur, métadonnées (non vérifiées pour l'absence de secret : **limite**) |

## 7. Limites

- Aucun test d'authentification réel (connexion, MFA, expiration) n'a été exécuté dans ce lot : il n'existe pas d'environnement de test de l'identité.
- La disponibilité du SSO et des options MFA dépend de l'offre Supabase et du fournisseur ; elle n'a **pas été vérifiée** et ne doit pas être supposée.
- Les métadonnées de `auth_events` n'ont pas été relues une à une : le contrôle « sans secret » est donc partiel.

## 8. Décision de ce lot

Aucun changement d'authentification n'a été fait : une MFA imposée sans enrôlement ni liste de rôles bloquerait les administrateurs, et un SSO sans fournisseur confirmé serait une supposition. Le lot reprendra après D-06 et D-P009-02.
