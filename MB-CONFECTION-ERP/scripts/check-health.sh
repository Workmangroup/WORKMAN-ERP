#!/usr/bin/env bash
# Contrôles de santé de la plateforme locale WORKMAN ERP 360.
# Ne lit ni n'affiche aucun secret : la clé anon est transmise en en-tête, jamais écrite.
#
#   WEB_URL=http://localhost:3002  API_URL=http://localhost:8000  \
#   SUPABASE_URL=http://localhost:54321  SUPABASE_ANON_KEY=...  bash scripts/check-health.sh
#
# Codes de sortie : 0 si tous les contrôles passent, 1 sinon.
set -u

WEB_URL=${WEB_URL:-http://localhost:3002}
API_URL=${API_URL:-http://localhost:8000}
SUPABASE_URL=${SUPABASE_URL:-http://localhost:54321}
FAILED=0

check() { # $1 libellé, $2 attendu, $3 obtenu
  if [ "$2" = "$3" ]; then echo "PASS  $1"; else echo "FAIL  $1 (attendu $2, obtenu $3)"; FAILED=1; fi
}

# 1. API : répond et la base est joignable (route publique /api/v1/health).
API_BODY=$(curl -s --max-time 10 -w '\n%{http_code}' "$API_URL/api/v1/health")
API_CODE=$(printf '%s' "$API_BODY" | tail -n 1)
API_JSON=$(printf '%s' "$API_BODY" | sed '$d')
check "API : HTTP 200" 200 "$API_CODE"
check "API : base de données joignable" '"database":"up"' "$(printf '%s' "$API_JSON" | grep -o '"database":"up"')"
check "API : sans jeton, liste protégée refusée (401)" 401 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$API_URL/api/v1/clients")"

# 2. Web : page de connexion publique accessible.
check "Web : page de connexion HTTP 200" 200 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$WEB_URL/login")"

# 3. Supabase Auth : service de santé (la clé anon est requise par la passerelle, transmise sans être affichée).
if [ -n "${SUPABASE_ANON_KEY:-}" ]; then
  check "Supabase Auth : santé HTTP 200" 200 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H "apikey: $SUPABASE_ANON_KEY" "$SUPABASE_URL/auth/v1/health")"
else
  echo "SKIP  Supabase Auth : SUPABASE_ANON_KEY non défini dans l'environnement"
fi

if [ "$FAILED" -eq 0 ]; then echo "RÉSULTAT : tous les contrôles passent"; else echo "RÉSULTAT : au moins un contrôle échoue"; fi
exit $FAILED
