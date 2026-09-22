#!/usr/bin/env bash
# Construit dist/workvoice-ovh/ et dist/workvoice-ovh.zip (à lancer depuis workvoice/, Git Bash ou Linux).
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Compilation du frontend"
(cd frontend && npm run build)

echo "==> Assemblage"
# Ne supprime que ce que ce script produit (dist/livraison et le reste de dist/ sont conservés)
rm -rf dist/workvoice-ovh dist/workvoice-ovh.zip && mkdir -p dist/workvoice-ovh/{database,nginx,api/uploads}
cp -r frontend/out dist/workvoice-ovh/site
cp -r backend/src backend/scripts backend/package.json backend/package-lock.json \
      backend/ecosystem.config.cjs backend/.env.example dist/workvoice-ovh/api/
cp deploy/nginx/workvoice.conf dist/workvoice-ovh/nginx/
cp deploy/GUIDE_OVH.md dist/workvoice-ovh/
sed 's/\r$//' deploy/install-vps.sh > dist/workvoice-ovh/install-vps.sh

echo "==> Base SQL unique"
{
  cat <<'HEAD'
-- =====================================================================
--  WORKVOICE — Base complète pour OVH (MySQL 8.0.16+)
--  À importer DANS une base existante (phpMyAdmin > Importer, ou :
--    mysql nom_de_la_base < workvoice_ovh.sql)
--  Contient : tables, vues anonymisées Direction, données de démonstration.
--  ATTENTION : supprime et recrée les tables WORKVOICE si elles existent.
-- =====================================================================
SET NAMES utf8mb4;

HEAD
  for f in 01_schema.sql 02_views_security.sql 03_seed.sql; do
    echo "-- ##### $f #####"
    # La base est choisie à l'import : on retire CREATE DATABASE et USE
    sed -e 's/\r$//' -e '/^USE workvoice;$/d' database/$f \
      | sed -e '/^CREATE DATABASE IF NOT EXISTS workvoice$/,/COLLATE utf8mb4_unicode_ci;$/d'
  done
} > dist/workvoice-ovh/database/workvoice_ovh.sql

echo "==> Archive"
if command -v zip >/dev/null; then
  (cd dist && zip -qr workvoice-ovh.zip workvoice-ovh)
else
  powershell.exe -NoProfile -Command "Compress-Archive -Path dist/workvoice-ovh -DestinationPath dist/workvoice-ovh.zip -Force"
fi
echo "✔ dist/workvoice-ovh.zip"
