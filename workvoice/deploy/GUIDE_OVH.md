# WORKVOICE — Mise en ligne sur OVH

## Contenu de l'archive `workvoice-ovh.zip`

| Dossier / fichier | Rôle |
|---|---|
| `site/` | Interface web déjà compilée (HTML/CSS/JS statiques) |
| `api/` | API Node.js (sans `node_modules`, installés sur le serveur) |
| `database/workvoice_ovh.sql` | **La base** : tables + vues anonymisées + questionnaire GRH-IFD-23 + données de démo, en un seul fichier |
| `nginx/workvoice.conf` | Configuration du serveur web |
| `install-vps.sh` | Installation automatique complète |
| `GUIDE_OVH.md` | Ce guide |

## Quelle offre OVH ?

| Offre | Compatible |
|---|---|
| **VPS** (Starter, Value, Essential… Ubuntu 22.04/24.04) | ✅ Oui : c'est le mode d'installation ci-dessous |
| Hébergement Web Perso / Pro (mutualisé) | ❌ Non : pas de Node.js, l'API ne peut pas tourner |
| Hébergement Web Performance | ⚠️ Possible mais non couvert par ce guide |

Un **VPS Starter** (~5 € HT/mois) suffit pour quelques centaines de collaborateurs.
Choisissez un datacenter **en France** (Gravelines, Roubaix, Strasbourg) pour les données RH.

## Installation sur un VPS (≈ 15 minutes)

### 1. Préparer le nom de domaine
Dans l'espace client OVH → **Noms de domaine** → votre domaine → **Zone DNS** :
ajoutez un enregistrement **A** `workvoice` → adresse IP du VPS.
(Résultat : `workvoice.mondomaine.tn` pointe vers le serveur.)

### 2. Envoyer l'archive sur le VPS
Depuis votre PC (PowerShell) :
```bash
scp workvoice-ovh.zip ubuntu@IP_DU_VPS:~
```

### 3. Lancer l'installation
```bash
ssh ubuntu@IP_DU_VPS
sudo apt-get install -y unzip && unzip workvoice-ovh.zip && cd workvoice-ovh
sudo DOMAIN=workvoice.mondomaine.tn EMAIL=vous@workman.tn bash install-vps.sh
```

Le script installe Nginx, MySQL 8, Node.js 22 et PM2. Il crée la base et **deux comptes MySQL
avec des mots de passe aléatoires**, dont un compte Direction limité aux vues anonymisées. Il
importe `workvoice_ovh.sql`, génère la clé JWT, démarre l'API et active le **HTTPS** (Let's Encrypt).

### 4. Tester
Ouvrez `https://workvoice.mondomaine.tn` : mot de passe **`Workman@2026`**

| Matricule | Espace |
|---|---|
| `WM1001` | Employé |
| `RH001` | RH |
| `DG001` | Direction |

## Avant l'ouverture aux collaborateurs ⚠️

1. **Supprimer les données de démonstration.** Ce sont 36 comptes au mot de passe public et des
   tickets fictifs. Pour vider les tickets tout en conservant la structure :
   ```bash
   sudo mysql workvoice -e "SET FOREIGN_KEY_CHECKS=0; TRUNCATE commentaires; TRUNCATE notifications; TRUNCATE audit_logs; TRUNCATE demandes; TRUNCATE reclamations; TRUNCATE suggestions; TRUNCATE sequences; TRUNCATE questionnaire_reponses_detail; TRUNCATE questionnaire_reponses; TRUNCATE questionnaire_participations; TRUNCATE questionnaire_campagnes; SET FOREIGN_KEY_CHECKS=1;"
   ```
2. **Charger les vrais collaborateurs** dans la table `users` (matricule, nom, service, site, rôle…).
   Les mots de passe doivent être hachés en bcrypt ; un script d'import CSV peut être fourni.
3. **Configurer l'envoi d'e-mails** dans `/var/www/workvoice/api/.env` (`SMTP_HOST`, `SMTP_USER`…),
   par exemple avec l'offre e-mail OVH (`ssl0.ovh.net`, port 587). Redémarrez ensuite l'API :
   `sudo -u workvoice HOME=/var/www/workvoice pm2 restart workvoice-api`

## Import manuel de la base (phpMyAdmin / Web Cloud Databases)

Si la base MySQL est hébergée ailleurs (ex. **Web Cloud Databases** OVH, MySQL 8) :
créez une base vide, ouvrez **phpMyAdmin** → onglet **Importer** → `database/workvoice_ovh.sql`
(encodage UTF-8). Renseignez ensuite `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` dans `api/.env`.
**MySQL 8.0.16 minimum** est requis (contraintes CHECK, JSON).

## Mettre à jour l'application

Envoyez la nouvelle archive et relancez simplement `install-vps.sh` : le fichier `.env`, les pièces
jointes et **la base existante sont conservés** (le SQL n'est importé qu'à la première installation).

## Sauvegardes (recommandé)

```bash
# Sauvegarde quotidienne à 2 h, conservée 30 jours
sudo mkdir -p /var/backups/workvoice
echo '0 2 * * * root mysqldump --single-transaction workvoice | gzip > /var/backups/workvoice/db-$(date +\%F).sql.gz && tar czf /var/backups/workvoice/uploads-$(date +\%F).tgz -C /var/www/workvoice/api uploads && find /var/backups/workvoice -mtime +30 -delete' | sudo tee /etc/cron.d/workvoice-backup
```
Activez aussi l'option **Backup automatisé** du VPS dans l'espace client OVH.

## Dépannage

| Symptôme | Commande |
|---|---|
| Page blanche / erreur 502 | `sudo -u workvoice HOME=/var/www/workvoice pm2 logs workvoice-api` |
| Tester l'API | `curl https://workvoice.mondomaine.tn/api/health` → `{"status":"ok","database":"up"}` |
| Erreur Nginx | `sudo nginx -t` puis `sudo tail -50 /var/log/nginx/error.log` |
| Certificat HTTPS | `sudo certbot renew --dry-run` |
