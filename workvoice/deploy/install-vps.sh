#!/usr/bin/env bash
# =====================================================================
#  WORKVOICE — Installation sur un VPS OVH (Ubuntu 22.04 / 24.04)
#
#  1. Envoyez le dossier workvoice-ovh sur le serveur :
#       scp -r workvoice-ovh ubuntu@IP_DU_VPS:~
#  2. Connectez-vous puis lancez :
#       cd ~/workvoice-ovh && sudo DOMAIN=workvoice.mondomaine.tn EMAIL=vous@workman.tn bash install-vps.sh
# =====================================================================
set -euo pipefail

DOMAIN="${DOMAIN:?Indiquez DOMAIN=workvoice.mondomaine.tn}"
EMAIL="${EMAIL:?Indiquez EMAIL=adresse pour les alertes Let's Encrypt}"
APP_DIR=/var/www/workvoice
DB_NAME=workvoice
DB_USER=workvoice_app
DB_DIR_USER=workvoice_direction
SRC="$(cd "$(dirname "$0")" && pwd)"

rand() { openssl rand -base64 36 | tr -dc 'A-Za-z0-9' | head -c "${1:-32}"; }
DB_PASS="$(rand 28)"
DB_DIR_PASS="$(rand 28)"
JWT_SECRET="$(rand 64)"

echo "==> Paquets système (Nginx, MySQL 8, Certbot, Node.js 22)"
apt-get update -y
apt-get install -y nginx mysql-server certbot python3-certbot-nginx curl openssl ufw rsync
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
npm install -g pm2

echo "==> Pare-feu"
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

echo "==> Base de données"
mysql <<SQL
CREATE DATABASE IF NOT EXISTS ${DB_NAME} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASS}';
ALTER USER '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASS}';
GRANT SELECT, INSERT, UPDATE, DELETE ON ${DB_NAME}.* TO '${DB_USER}'@'localhost';
FLUSH PRIVILEGES;
SQL
# Import uniquement à la première installation : le script SQL recrée les tables
# et effacerait les données existantes lors d'une mise à jour.
if [ "$(mysql -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${DB_NAME}' AND table_name='users'")" = "0" ]; then
  mysql "${DB_NAME}" < "${SRC}/database/workvoice_ovh.sql"
else
  echo "    Base existante conservée (pas de réimport)."
fi
mysql <<SQL
CREATE USER IF NOT EXISTS '${DB_DIR_USER}'@'localhost' IDENTIFIED BY '${DB_DIR_PASS}';
ALTER USER '${DB_DIR_USER}'@'localhost' IDENTIFIED BY '${DB_DIR_PASS}';
GRANT SELECT ON ${DB_NAME}.v_direction_reclamations TO '${DB_DIR_USER}'@'localhost';
GRANT SELECT ON ${DB_NAME}.v_direction_demandes     TO '${DB_DIR_USER}'@'localhost';
FLUSH PRIVILEGES;
SQL

echo "==> Fichiers de l'application"
mkdir -p "${APP_DIR}"
rm -rf "${APP_DIR}/site"
cp -r "${SRC}/site" "${APP_DIR}/site"
mkdir -p "${APP_DIR}/api"
# On conserve .env et uploads/ lors d'une mise à jour
rsync -a --delete --exclude .env --exclude uploads --exclude logs "${SRC}/api/" "${APP_DIR}/api/"
mkdir -p "${APP_DIR}/api/uploads" "${APP_DIR}/api/logs"

if [ ! -f "${APP_DIR}/api/.env" ]; then
  cat > "${APP_DIR}/api/.env" <<ENV
NODE_ENV=production
PORT=4000
FRONTEND_URL=https://${DOMAIN}
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=${DB_NAME}
DB_USER=${DB_USER}
DB_PASSWORD=${DB_PASS}
DB_DIRECTION_USER=${DB_DIR_USER}
DB_DIRECTION_PASSWORD=${DB_DIR_PASS}
JWT_SECRET=${JWT_SECRET}
JWT_EXPIRES_IN=8h
UPLOAD_DIR=${APP_DIR}/api/uploads
MAX_UPLOAD_MB=5
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASSWORD=
MAIL_FROM="WORKVOICE <workvoice@${DOMAIN}>"
ENV
  chmod 600 "${APP_DIR}/api/.env"
fi

id -u workvoice >/dev/null 2>&1 || useradd --system --home "${APP_DIR}" --shell /usr/sbin/nologin workvoice
chown workvoice:workvoice "${APP_DIR}"
chown -R workvoice:workvoice "${APP_DIR}/api"
chown -R www-data:www-data "${APP_DIR}/site"

echo "==> Dépendances Node et démarrage de l'API (PM2)"
cd "${APP_DIR}/api"
sudo -u workvoice HOME="${APP_DIR}" npm ci --omit=dev
sudo -u workvoice HOME="${APP_DIR}" pm2 start ecosystem.config.cjs --update-env || sudo -u workvoice HOME="${APP_DIR}" pm2 restart workvoice-api --update-env
sudo -u workvoice HOME="${APP_DIR}" pm2 save
env PATH="$PATH" pm2 startup systemd -u workvoice --hp "${APP_DIR}" >/dev/null

echo "==> Nginx + HTTPS"
sed "s/workvoice.example.com/${DOMAIN}/g" "${SRC}/nginx/workvoice.conf" > /etc/nginx/sites-available/workvoice
ln -sf /etc/nginx/sites-available/workvoice /etc/nginx/sites-enabled/workvoice
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
certbot --nginx -d "${DOMAIN}" --non-interactive --agree-tos -m "${EMAIL}" --redirect

echo
echo "✔ WORKVOICE est en ligne : https://${DOMAIN}"
echo "  Comptes de démo (mot de passe Workman@2026) : WM1001 · RH001 · DG001"
echo "  Configuration : ${APP_DIR}/api/.env (SMTP à renseigner pour les e-mails)"
echo "  Logs de l'API : sudo -u workvoice HOME=${APP_DIR} pm2 logs workvoice-api"
