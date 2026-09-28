# AUDIT_ATTESTATIONS_COFFRE_FORT_CEO.md

**Phase 0 — Audit.** Aucun fichier de code ou de base de données n'a été modifié pour produire ce document. Conformément à la consigne, je m'arrête après cette phase et attends votre validation avant toute modification de la base ou du code.

Date : 2026-09-28. Basé sur l'état actuel du dépôt, y compris le module Multi-Tenant déjà livré ([AUDIT_WORKVOICE_V2.md](AUDIT_WORKVOICE_V2.md), [ARCHITECTURE_WORKVOICE_V2.md](ARCHITECTURE_WORKVOICE_V2.md), [DATABASE_MULTI_TENANT.md](DATABASE_MULTI_TENANT.md)).

---

## 1. Ce qui existe déjà (rappel synthétique, déjà en production)

| Domaine | État actuel |
|---|---|
| Stack | Next.js 16 (export statique) · PHP 8.2 vanilla (prod, aucune dépendance externe, pas de Composer) · Node/Express (parité, non déployé) · MySQL 8.4.11 |
| Hébergement | OVH mutualisé — **FTP uniquement, aucun accès shell, aucun Composer exécutable côté serveur** |
| Auth | JWT HS256 en cookie httpOnly + CSRF double-submit ; `current_user()` relu en base à chaque requête |
| Rôles | `EMPLOYE`, `RH`, `DIRECTION`, `SYSTEM_ADMIN` (ce dernier ajouté lors du module Multi-Tenant). `DIRECTION` fait déjà office de **GROUP_CEO** conceptuel, `RH` de **COMPANY_HR** — décision déjà prise et actée dans `ARCHITECTURE_WORKVOICE_V2.md` §2 : les valeurs ENUM ne sont pas renommées, seule leur portée métier change. Je réutilise cette même convention ici plutôt que d'introduire de nouvelles valeurs `GROUP_CEO`/`COMPANY_HR`/`EMPLOYEE`. |
| Multi-société | Table `companies` (4 sociétés + illimité), `company_id` sur `users` et 7 tables métier (`demandes`, `reclamations`, `suggestions`, `conges_demandes`, `sorties_demandes`, `retards_declarations`, `notifications`, `audit_logs`). **Isolation déjà active sur le module Collaborateurs uniquement** — pas encore sur les tickets, congés, dashboards (chantier en cours, non couvert par cet audit). |
| RBAC | Grossier : `require_role(ROLE_X, ...)` par route. Pas de table de permissions fines. Un nouveau `require_company_scope()` existe pour l'IDOR sur les collaborateurs (pattern réutilisable). |
| Stockage fichiers | `api-php/uploads/` — accès direct **bloqué** par `.htaccess` (`Require all denied`), fichiers nommés aléatoirement (`bin2hex(random_bytes(16))`), servis uniquement via une route API authentifiée qui fait `readfile()` avec les bons en-têtes. **Pattern déjà correct et directement réutilisable** pour le Coffre-Fort. |
| Téléchargement pièces jointes existant | Route `GET /demandes/{id}/piece-jointe` (`tickets.php:336`) : autorise **l'auteur du ticket OU un RH**. ⚠️ Ce pattern est **inadapté tel quel** aux attestations : le cahier des charges exige qu'un collaborateur ne puisse **jamais** télécharger son attestation. Une nouvelle route dédiée, avec une autorisation strictement RH/SYSTEM_ADMIN (jamais l'auteur), est nécessaire — ne pas copier ce pattern existant. |
| Notifications | `notify_users()` / `notify_role()` (table `notifications`, colonne `company_id` déjà ajoutée mais **pas encore exploitée** par ces fonctions — portée toujours globale en pratique). |
| Audit | Table `audit_logs` (avec `company_id`), fonction `audit()` déjà appelée sur la quasi-totalité des actions sensibles (création, modification, changement de statut, téléchargement de pièce jointe, consultation d'identité...). **Directement réutilisable** comme journal d'accès aux documents. |
| Génération PDF | **Inexistante.** Aucune librairie PDF n'est présente dans le projet (ni côté PHP — zéro dépendance, pas de `composer.json` — ni côté Node). |
| Signature électronique | **Inexistante.** Aucun prestataire, aucune infrastructure de signature qualifiée. |
| Dashboards | `rh.php` (dashboard RH, mono-société de fait aujourd'hui), `direction.php` (dashboard Direction, **strictement anonymisé** via les vues SQL `v_direction_reclamations`/`v_direction_demandes` — aucune colonne d'identité, même pas pour un compte MySQL compromis). **Aucun dashboard consolidé multi-sociétés n'existe** (comparatif Workman/STID/MB Confection/Somico, effectifs par société, turnover, etc.) — c'est un écran entièrement nouveau. |

## 2. Le point le plus important de cet audit : une notion d'« attestation » existe déjà, mais elle est insuffisante

Dans la table `demandes`, `type_demande` inclut déjà `ATTESTATION_TRAVAIL` et `ATTESTATION_SALAIRE`. Aujourd'hui, un collaborateur peut créer une demande de ce type — mais elle suit exactement le **même workflow générique** que n'importe quelle demande RH (avance sur salaire, formation, etc.) :

- statuts génériques `NOUVEAU/EN_COURS/EN_ATTENTE/RESOLU/CLOTURE` (pas `DRAFT/SUBMITTED/IN_REVIEW/GENERATED/APPROVED/READY/REJECTED/CANCELLED`) ;
- aucune récupération automatique des données RH (nom/matricule/société/poste/date d'embauche) — c'est un simple formulaire texte libre ;
- aucun PDF généré ;
- aucun numéro de document officiel ;
- **la pièce jointe (si le collaborateur en a mis une) est téléchargeable par lui-même** — incompatible avec l'exigence de sécurité de ce module.

→ **Cette fonctionnalité existante ne peut pas être étendue in situ sans casser son modèle de sécurité.** Voir décision recommandée en §7.

## 3. Tables existantes réutilisables (sans modification)

- `companies` — société émettrice de l'attestation (logo, raison sociale, adresse → déjà les champs nécessaires pour l'en-tête du PDF officiel, `settings JSON` déjà prévu pour des paramètres étendus type numérotation/mentions légales par société).
- `users` — identité, poste (`fonction`), date d'embauche (`date_embauche`), `company_id` : **toutes les données du snapshot demandé (§9 du cahier des charges) existent déjà** sur la fiche collaborateur enrichie (Module 4, déjà en prod).
- `audit_logs` (+ `company_id`) — réutilisable comme journal d'accès immuable (table déjà en écriture seule côté application : aucune route `UPDATE`/`DELETE` n'existe dessus).
- `notifications` (+ `company_id`) — réutilisable pour les notifications collaborateur/RH du workflow.
- `sequences` (numérotation atomique par préfixe/année, `next_numero()`) — mécanisme directement réutilisable pour une numérotation `ATT-WORKMAN-2026-000125` (un préfixe par société, ex. `ATT-1` pour company_id 1, ou table dédiée — voir §7).
- Le pattern *stockage privé + route de téléchargement authentifiée* (`uploads/.htaccess` + `readfile()`) — réutilisable tel quel pour le stockage physique des PDF et des documents du Coffre-Fort, à condition de **ne jamais appliquer la règle d'autorisation « auteur du ticket » existante**.

## 4. Tables à modifier

- `companies.settings` (JSON, déjà présent) : accueillera la configuration par société demandée en §11 (logo, mentions légales, gabarit, signature RH, numérotation) — **additif, aucune migration de colonne nécessaire**, seulement une convention de clés JSON à documenter en Phase 1.
- `notify_role()` / `notify_users()` : à faire évoluer pour respecter réellement `company_id` (déjà en attente depuis le module Multi-Tenant — cet audit confirme que les Modules Attestations/Coffre-Fort en dépendent aussi, ce qui renforce la priorité de ce chantier).

## 5. Nouvelles tables nécessaires (aucune ne supprime ou ne remplace l'existant)

| Table | Rôle |
|---|---|
| `attestation_requests` | Demande d'attestation : workflow dédié, statuts dédiés, snapshot des données RH au moment de la demande, numéro de document, FK vers `hr_documents` une fois généré. |
| `hr_documents` (Coffre-Fort) | Document RH sensible (attestation générée, mais aussi contrat/bulletin/avertissement/décision RH...), avec `company_id`, `employee_id`, catégorie, `storage_key`, `version`, `status`. |
| `hr_document_versions` | Historique des versions (réédition = nouvelle version, jamais un écrasement — §21/§23 du cahier des charges). |
| `hr_document_access_logs` | Optionnel : je recommande de **réutiliser `audit_logs`** (déjà `company_id`-aware, déjà immuable en pratique) plutôt que de dupliquer un mécanisme d'audit — à confirmer en Phase 1 (voir décision §7). |
| `attestation_types_config` ou extension de `companies.settings` | Paramétrage par société (numérotation, mentions légales, signature) — à trancher en Phase 1 entre une table dédiée et une extension du JSON `companies.settings` déjà existant. |

Aucune de ces tables ne remplace `demandes` : les demandes `ATTESTATION_TRAVAIL`/`ATTESTATION_SALAIRE` existantes via `demandes` restent fonctionnelles à l'identique (non-régression), simplement le **nouveau** parcours passe par le nouveau module.

## 6. APIs à réutiliser

- `current_user()`, `require_role()`, `require_company_scope()` (auth/RBAC) — inchangés.
- `audit()` — étendu avec de nouveaux noms d'action (`ATTESTATION_DOWNLOAD`, `ATTESTATION_SIGN`, `ACCESS_DENIED`, etc.), pas de nouvelle fonction.
- `notify_users()` / `notify_role()` — réutilisés (après la mise à jour company-aware déjà nécessaire).
- `next_numero()` / table `sequences` — réutilisés pour la numérotation des attestations.
- Le pattern `store_upload_field()` / `download_stored_file()` (déjà généralisés dans `services.php` pour Congés/Retards) — réutilisables pour l'enregistrement physique des PDF générés côté serveur, **avec une nouvelle fonction d'autorisation stricte** (jamais l'auteur).

## 7. APIs à créer (conformes au schéma conceptuel du cahier des charges, adapté aux conventions du projet)

```
POST   /me/attestations                        (collaborateur : créer une demande)
GET    /me/attestations                         (collaborateur : mes demandes, statut uniquement)
GET    /rh/attestations                         (RH : liste, filtres société/statut/type/collaborateur)
GET    /rh/attestations/{id}                    (RH : détail)
POST   /rh/attestations/{id}/generer            (RH : génère le PDF → statut GENERATED)
POST   /rh/attestations/{id}/approuver          (RH : APPROVED)
POST   /rh/attestations/{id}/refuser            (RH : REJECTED, motif obligatoire)
POST   /rh/attestations/{id}/annuler            (RH : CANCELLED, motif obligatoire)
POST   /rh/attestations/{id}/reediter           (RH : nouvelle version, jamais un écrasement)
POST   /rh/attestations/{id}/signer             (RH : SIGNED → READY)
GET    /rh/attestations/{id}/telecharger        (RH/SYSTEM_ADMIN UNIQUEMENT — jamais l'auteur)

GET    /rh/coffre-fort                          (RH : liste documents, filtres)
POST   /rh/coffre-fort                          (RH : upload document sensible)
POST   /rh/coffre-fort/{id}/version              (RH : nouvelle version)
GET    /rh/coffre-fort/{id}/telecharger         (RH/SYSTEM_ADMIN, permission explicite)

GET    /ceo/dashboard/effectifs                 (GROUP_CEO/DIRECTION : consolidé + filtre société)
GET    /ceo/dashboard/benchmark                 (comparatif sociétés, dynamique, pas hardcodé)
GET    /ceo/dashboard/climat-social             (indicateurs calculés uniquement si données réelles)
```

Aucune route existante n'est supprimée ni modifiée dans son contrat (conforme §55 : ne pas dupliquer, réutiliser au maximum).

## 8. Écrans à modifier

- **`rh/collaborateurs`** : aucun changement requis (la fiche RH déjà présente fournit tout le snapshot nécessaire).
- **App shell / navigation** (`components/layout/app-shell.tsx`) : ajout d'entrées « Mes demandes RH → Demander une attestation » (EMPLOYE), « RH → Attestations », « RH → Coffre-Fort », « CEO Groupe → Dashboard consolidé » (DIRECTION), selon le même pattern que l'ajout `SYSTEM_ADMIN`/`/admin/societes` déjà fait.
- **Dashboard employé** (`employe/page.tsx`) : éventuel raccourci « Demander une attestation », sur le modèle de la carte « Solde de congé » déjà ajoutée.

## 9. Écrans à créer

- `employe/attestations/` — formulaire de demande (données RH affichées en lecture seule, non éditables) + liste « Mes demandes RH » avec **uniquement** le statut et le message « Votre attestation est prête, merci de vous présenter au service RH » (jamais de bouton télécharger/imprimer/voir).
- `rh/attestations/` — file de traitement (filtres société/département/collaborateur/statut/type), actions Générer/Télécharger/Imprimer/Envoyer/Signer/Rééditer/Annuler, historique des versions.
- `rh/coffre-fort/` (ou `admin/coffre-fort/` si l'on restreint SYSTEM_ADMIN+RH) — classement par catégorie, upload, versioning.
- `direction/dashboard-groupe/` (ou renommage de l'écran Direction existant) — sélecteur de société (Groupe/Workman/STID/MB Confection/Somico), effectifs, répartitions, benchmark, climat social IA, alertes RH.

## 10. Risques de sécurité identifiés (à traiter explicitement en Phase 4)

1. **Le plus critique** : ne pas réutiliser par erreur `load_for_viewer()` (pattern « auteur OU RH ») pour les attestations. Toute nouvelle route de téléchargement de document RH sensible doit utiliser une fonction d'autorisation strictement RH/SYSTEM_ADMIN, testée explicitement contre l'auteur (les 8 tests de sécurité du cahier des charges §42 correspondent exactement à ce risque).
2. **IDOR inter-société** : chaque route document doit vérifier `company_id` en plus du rôle (pattern déjà établi avec `require_company_scope()` sur les collaborateurs — à répliquer).
3. **Fuite via la recherche globale/export** : aujourd'hui, aucune recherche globale ni export ne couvre de documents RH sensibles (n'existe pas encore) — risque à surveiller **dès la conception**, pas après coup.
4. **Notifications sans lien ni pièce jointe** : le pattern actuel `notify_users()` accepte un champ `lien` — il faudra s'assurer qu'aucun lien de notification d'attestation ne pointe, même indirectement, vers une route de téléchargement accessible côté collaborateur.
5. **Génération PDF sans dépendance externe déployable** : l'hébergement OVH mutualisé ne permet pas d'exécuter `composer install`. Le choix de la librairie PDF (Phase 1) doit privilégier une librairie **pure PHP, sans dépendance, livrable par simple copie FTP de fichiers `.php`** (ex. FPDF ou équivalent), sous peine de ne jamais pouvoir déployer la fonctionnalité en production.
6. **Sur-promesse de signature électronique** : sans prestataire qualifié, le système ne doit jamais présenter sa signature comme juridiquement opposable — seulement comme une validation interne tracée (`signed_at`, `signed_by`, `document_hash`), conformément à l'avertissement du cahier des charges lui-même (§22).

## 11. Risques de régression

- Les demandes `ATTESTATION_TRAVAIL`/`ATTESTATION_SALAIRE` existantes (table `demandes`) doivent continuer de fonctionner à l'identique — le nouveau module est un parcours **en plus**, pas un remplacement. Si un jour on souhaite les fusionner, ce sera une décision produit explicite, pas un effet de bord de cette livraison.
- `notify_role()`/`notify_users()` : les rendre *company-aware* impacte potentiellement le comportement déjà en production pour Congés/Sorties/Retards/Tickets (notifications RH). À traiter avec la même rigueur de tests que le reste du module Multi-Tenant, pas en modification incidente dans ce chantier-ci.
- Le dashboard Direction existant (`direction.php`, anonymisé) ne doit pas être modifié pour le nouveau dashboard CEO Groupe : soit on l'étend en préservant strictement l'anonymisation déjà en place (cohérent avec la politique déjà actée en §10 d'`ARCHITECTURE_WORKVOICE_V2.md`), soit on crée un écran distinct. À trancher en Phase 1 (voir décision ci-dessous).

## 12. Décisions à valider avant la Phase 1 (architecture détaillée)

1. **Table dédiée `attestation_requests` + `hr_documents`** (recommandé, cohérent avec le modèle conceptuel du cahier des charges et avec les exigences de sécurité incompatibles avec le workflow générique `demandes`) — confirmez-vous, ou préférez-vous que j'étudie une extension de `demandes` malgré les incompatibilités relevées en §2 ?
2. **Librairie PDF** : je recommande une librairie pure PHP sans Composer (compatible FTP), à choisir précisément en Phase 1 avec présentation d'options (§55 : ne pas deviner). Confirmez-vous cette contrainte (pas de Composer/SSH disponible sur votre hébergement OVH) ?
3. **RBAC fin (`ATTESTATION_DOWNLOAD`, `ATTESTATION_SIGN`, etc.)** : le projet n'a aujourd'hui que des rôles grossiers (`require_role()`). Introduire une vraie table de permissions est un changement structurel plus lourd que tout ce qui a été fait jusqu'ici. Deux options que je détaillerai en Phase 1 : **(A)** permissions codées en dur par rôle dans le backend (rapide, conforme à l'esprit du projet actuel, mais moins « littéralement » conforme au cahier des charges) vs **(B)** vraie table `permissions`/`role_permissions` (plus lourd, plus proche de la demande explicite du cahier des charges en §13/§19). Avez-vous une préférence, ou dois-je recommander par défaut ?
4. **Journal d'accès documents** : réutiliser `audit_logs` (recommandé, déjà en place et déjà `company_id`-aware) plutôt que créer `hr_document_access_logs` séparée — confirmez-vous ?
5. **Dashboard CEO Groupe** : étendre l'écran Direction existant (en conservant l'anonymisation déjà en production) ou créer un écran totalement séparé ? Rappel : le cahier des charges Multi-Tenant précédent avait déjà soulevé cette tension (accès consolidé vs anonymisation stricte) sans réponse tranchée de votre part — cette question reste donc ouverte et se pose à nouveau ici avec la même acuité, car §34 (Climat social IA) et §32 (indicateurs RH par société) impliquent des agrégats sur des données aujourd'hui anonymisées pour la Direction.

---

Je m'arrête ici, comme demandé. Dites-moi vos réponses aux 5 points ci-dessus (ou validez mes recommandations par défaut) et j'enchaîne sur la **Phase 1 — Architecture**.
