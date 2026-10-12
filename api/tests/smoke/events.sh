#!/usr/bin/env bash
# Test de bout en bout : notifications, échecs visibles, replay, idempotence, ETag.
# Prérequis : API lancée (API_URL, défaut http://127.0.0.1:8000), base de test joignable (PSQL_URL), SUPABASE_JWT_SECRET
# identique à celui de api/.env. Crée des utilisateurs de TEST (préfixe p020-) dans la base locale uniquement.
set -u
API="${API_URL:-http://127.0.0.1:8000}/api/v1"
PSQL_URL="${PSQL_URL:?PSQL_URL requis (ex. postgresql://postgres@127.0.0.1:54400/erp360_real)}"
SECRET="${SUPABASE_JWT_SECRET:?SUPABASE_JWT_SECRET requis}"
pass=0; fail=0
ok() { if [ "$2" = "1" ]; then echo "PASS  $1"; pass=$((pass+1)); else echo "FAIL  $1 ${3:-}"; fail=$((fail+1)); fi }
b64() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
token() { # $1 = sub
  local h p s exp
  exp=$(( $(date +%s) + 3600 ))
  h=$(printf '{"alg":"HS256","typ":"JWT"}' | b64)
  p=$(printf '{"sub":"%s","role":"authenticated","aud":"authenticated","exp":%s}' "$1" "$exp" | b64)
  s=$(printf '%s.%s' "$h" "$p" | openssl dgst -sha256 -hmac "$SECRET" -binary | b64)
  printf '%s.%s.%s' "$h" "$p" "$s"
}
sql() { psql "$PSQL_URL" -tAqX -v ON_ERROR_STOP=1 -c "$1"; }

COMPANY=$(sql "select id from companies limit 1")
ROLE_ADMIN=$(sql "select id from roles where code='admin' and company_id='$COMPANY'")
ROLE_DIR=$(sql "select id from roles where code='direction' and company_id='$COMPANY'")
ROLE_COM=$(sql "select id from roles where code='commercial' and company_id='$COMPANY'")
mk() { # $1 email, $2 role id (ou vide)
  local id; id=$(sql "insert into auth.users(email) values ('$1') on conflict do nothing returning id" | head -n1)
  [ -z "$id" ] && id=$(sql "select id from auth.users where email='$1'")
  [ -n "$2" ] && sql "insert into user_roles values ('$id','$2') on conflict do nothing" >/dev/null
  echo "$id"
}
ADMIN=$(mk p020-admin@test.local "$ROLE_ADMIN")
DIR=$(mk p020-dir@test.local "$ROLE_DIR")
COM=$(mk p020-com@test.local "$ROLE_COM")
DEL=$(mk p020-del@test.local "")
TA=$(token "$ADMIN"); TD=$(token "$DIR"); TC=$(token "$COM"); TX=$(token "$DEL")

# Données : une demande qui génère un événement et une notification pour le demandeur après refus
sql "delete from event_deliveries where event_id in (select id from event_outbox where idempotency_key like 'p020-%')" >/dev/null
OBJ=$(sql "select gen_random_uuid()")
sql "select set_config('request.jwt.claims', '{\"sub\":\"$ADMIN\",\"role\":\"authenticated\"}', false)" >/dev/null
sql "set role authenticated; select set_config('request.jwt.claims', '{\"sub\":\"$ADMIN\",\"role\":\"authenticated\"}', true); select public.approval_policy_set('smoke_obj', 1, null, 'approvals.decide', null, 'approvals.escalate', 24);" >/dev/null 2>&1
REQ=$(sql "set role authenticated; select set_config('request.jwt.claims', '{\"sub\":\"$COM\",\"role\":\"authenticated\"}', true); select public.approval_request_create('smoke_obj', '$OBJ', '{\"ref\":\"P020\"}', 10);" 2>/dev/null | tail -n1)
sql "set role authenticated; select set_config('request.jwt.claims', '{\"sub\":\"$DIR\",\"role\":\"authenticated\"}', true); select public.approval_decide('$REQ', 'refuse', 'Motif de test P020 suffisant');" >/dev/null 2>&1

# 1. Authentification
code=$(curl -s -o /dev/null -w '%{http_code}' "$API/notifications"); ok "sans jeton : 401" "$([ "$code" = 401 ] && echo 1 || echo 0)" "$code"
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TX" "$API/events/failures"); ok "sans droit events.read : 403" "$([ "$code" = 403 ] && echo 1 || echo 0)" "$code"

# 2. Notifications : lecture, ETag, 304, confidentialité
HDR=$(mktemp); BODY=$(curl -s -D "$HDR" -H "Authorization: Bearer $TC" "$API/notifications")
ETAG=$(grep -i '^etag:' "$HDR" | tr -d '\r' | cut -d' ' -f2-)
n=$(echo "$BODY" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["data"]))' 2>/dev/null || echo -1)
nbase=$(sql "select count(*) from notifications where recipient_id='$COM'")
ok "notifications du demandeur : égales à la base (relances précédentes incluses), ETag présent" "$([ "$n" = "$nbase" ] && [ -n "$ETAG" ] && echo 1 || echo 0)" "n=$n base=$nbase etag=$ETAG"
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TC" -H "If-None-Match: $ETAG" "$API/notifications"); ok "If-None-Match identique : 304" "$([ "$code" = 304 ] && echo 1 || echo 0)" "$code"
NID=$(echo "$BODY" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"][0]["id"])' 2>/dev/null)
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TD" "$API/notifications/$NID/read"); ok "marquer lue la notification d'autrui : 404" "$([ "$code" = 404 ] && echo 1 || echo 0)" "$code"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TC" "$API/notifications/$NID/read"); ok "marquer lue sa notification : 204" "$([ "$code" = 204 ] && echo 1 || echo 0)" "$code"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TC" "$API/notifications/$NID/read"); ok "marquer lue deux fois : toujours 204 (idempotent)" "$([ "$code" = 204 ] && echo 1 || echo 0)" "$code"

# 3. Traitement de la file : répétition sans doublon
curl -s -o /dev/null -X POST -H "Authorization: Bearer $TA" "$API/events/dispatch"
c1=$(sql "select count(*) from notifications where recipient_id='$COM'")
curl -s -o /dev/null -X POST -H "Authorization: Bearer $TA" "$API/events/dispatch"
c2=$(sql "select count(*) from notifications where recipient_id='$COM'")
ok "traitement répété : aucune notification en double" "$([ "$c1" = "$c2" ] && echo 1 || echo 0)" "$c1/$c2"

# 4. Échec visible et replay idempotent
BAD=$(sql "select private.event_emit('$COMPANY', 'approval.approve', 'approval_request', 'p020-bad', 'p020-bad-$(date +%s%N)', '{}'::jsonb)")
curl -s -o /dev/null -X POST -H "Authorization: Bearer $TA" "$API/events/dispatch"
f=$(curl -s -H "Authorization: Bearer $TA" "$API/events/failures" | python3 -c 'import json,sys; d=json.load(sys.stdin)["data"]; print(sum(1 for r in d if r["event_id"]=="'"$BAD"'" and r["last_error"] and "EVENT_PAYLOAD_INVALID" in r["last_error"]))' 2>/dev/null || echo 0)
ok "échec visible avec sa cause (EVENT_PAYLOAD_INVALID)" "$([ "$f" = 1 ] && echo 1 || echo 0)" "$f"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TA" -H 'Content-Type: application/json' -d '{"consumer":"notify_internal"}' "$API/events/$BAD/replay"); ok "replay sans Idempotency-Key : 422" "$([ "$code" = 422 ] && echo 1 || echo 0)" "$code"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TD" -H 'Idempotency-Key: p020-replay-key-1' -H 'Content-Type: application/json' -d '{"consumer":"notify_internal"}' "$API/events/$BAD/replay"); ok "replay sans droit events.replay (direction) : 403" "$([ "$code" = 403 ] && echo 1 || echo 0)" "$code"
KEY="p020-replay-key-$(date +%s)"
R1=$(curl -s -X POST -H "Authorization: Bearer $TA" -H "Idempotency-Key: $KEY" -H 'Content-Type: application/json' -d '{"consumer":"notify_internal"}' "$API/events/$BAD/replay")
ok "replay avec clé : résultat failed (échec relancé, cause renvoyée)" "$(echo "$R1" | grep -q '"result":"failed"' && echo 1 || echo 0)" "$R1"
HDR2=$(mktemp); R2=$(curl -s -D "$HDR2" -X POST -H "Authorization: Bearer $TA" -H "Idempotency-Key: $KEY" -H 'Content-Type: application/json' -d '{"consumer":"notify_internal"}' "$API/events/$BAD/replay")
ok "même clé, même requête : réponse rejouée (Idempotent-Replayed: true)" "$(grep -qi '^idempotent-replayed: true' "$HDR2" && [ "$R1" = "$R2" ] && echo 1 || echo 0)" "$R2"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TA" -H "Idempotency-Key: $KEY" -H 'Content-Type: application/json' -d '{"consumer":"notify_internal","x":1}' "$API/events/$BAD/replay")
ok "même clé, autre requête : 422 IDEMPOTENCY_KEY_REUSED" "$([ "$code" = 422 ] && echo 1 || echo 0)" "$code"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TA" -H "Idempotency-Key: p020-replay-key-$RANDOM$RANDOM" -H 'Content-Type: application/json' -d '{"consumer":"inconnu"}' "$API/events/$BAD/replay")
ok "consommateur inconnu : 422" "$([ "$code" = 422 ] && echo 1 || echo 0)" "$code"
rm -f "$HDR" "$HDR2"
echo "Résultat : $pass réussi(s), $fail échec(s)"
[ "$fail" = 0 ]
