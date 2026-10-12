#!/usr/bin/env bash
# Référence de non-régression WORKMAN ERP 360 (AUD-004).
# Rejoue les contrôles existants et compare aux résultats figés dans docs/erp360/non-regression/baseline.json.
#
#   bash scripts/non-regression.sh             # rejoue et compare (code 1 si régression)
#   bash scripts/non-regression.sh --record    # écrit une nouvelle référence (à faire seulement après revue)
#
# Variables optionnelles : TOKEN_ADMIN, TOKEN_NORIGHTS (smoke API), DB_CONTAINER (catalogue de la base locale).
# Lecture seule : aucune donnée de production, aucune écriture en base.
set -u
ROOT="$(cd "$(dirname "$0")/.." && (pwd -W 2>/dev/null || pwd))"
BASELINE="${BASELINE_FILE:-$ROOT/docs/erp360/non-regression/baseline.json}"
MODE=compare; [ "${1:-}" = "--record" ] && MODE=record
TMP="$ROOT/.nonreg-tmp"; rm -rf "$TMP"; mkdir -p "$TMP"
RESULTS="$TMP/results.env"
: > "$RESULTS"
REGRESSIONS=0
note() { echo "$1" >> "$RESULTS"; }

# 1. Tests web (SQL sur PGlite en mémoire, unitaires).
cd "$ROOT/web" || exit 2
SQL_OUT=$(npm run -s test:sql 2>&1); SQL_CODE=$?
note "sql_pass=$(printf '%s\n' "$SQL_OUT" | grep -c '^PASS')"
note "sql_fail=$(printf '%s\n' "$SQL_OUT" | grep -c '^FAIL')"
note "sql_exit=$SQL_CODE"
UNIT_OUT=$(npm run -s test:unit 2>&1); UNIT_CODE=$?
note "unit_pass=$(printf '%s\n' "$UNIT_OUT" | grep -c '^PASS')"
note "unit_fail=$(printf '%s\n' "$UNIT_OUT" | grep -c '^FAIL')"
note "unit_exit=$UNIT_CODE"
cd "$ROOT" || exit 2

# 2. Contrôles de santé (API, base, web, Supabase) : le script existant renvoie 0 si tout passe.
if [ -f "$ROOT/web/.env.local" ]; then
  set -a; . "$ROOT/web/.env.local"; set +a
fi
SUPABASE_URL="${NEXT_PUBLIC_SUPABASE_URL:-${SUPABASE_URL:-}}" SUPABASE_ANON_KEY="${NEXT_PUBLIC_SUPABASE_ANON_KEY:-${SUPABASE_ANON_KEY:-}}" \
  bash "$ROOT/scripts/check-health.sh" > "$TMP/health.txt" 2>&1; note "health_exit=$?"
note "health_pass=$(grep -c '^PASS' "$TMP/health.txt")"

# 3. Smoke API clients (seulement si les jetons de test sont fournis).
# Un jeton expiré ne prouve rien : le contrôle est signalé comme non vérifié, pas comme un échec applicatif.
token_state() { node -e 'try{const p=JSON.parse(Buffer.from(process.argv[1].split(".")[1],"base64url").toString());process.stdout.write(p.exp*1000>Date.now()?"ok":"expired")}catch(e){process.stdout.write("invalid")}' "$1"; }
if [ -n "${TOKEN_ADMIN:-}" ] && [ -n "${TOKEN_NORIGHTS:-}" ] && [ "$(token_state "$TOKEN_ADMIN")" = "ok" ] && [ "$(token_state "$TOKEN_NORIGHTS")" = "ok" ]; then
  API_URL="${API_URL:-http://localhost:8000}" bash "$ROOT/api/tests/smoke/clients.sh" > "$TMP/smoke.txt" 2>&1; note "smoke_exit=$?"
  note "smoke_pass=$(grep -c '^PASS' "$TMP/smoke.txt")"
  note "smoke_fail=$(grep -c '^FAIL' "$TMP/smoke.txt")"
else
  note "smoke_exit=skipped"
fi

# 4. Catalogue de la base locale (lecture seule) : détecte une perte d'objets.
if [ -n "${DB_CONTAINER:-}" ]; then
  Q() { docker exec "$DB_CONTAINER" psql -U postgres -tAc "$1" 2>/dev/null | tr -d '\r'; }
  note "db_base_tables=$(Q "select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'")"
  note "db_policies=$(Q "select count(*) from pg_policies where schemaname='public'")"
  note "db_functions_public=$(Q "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'")"
  note "db_functions_private=$(Q "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private'")"
  note "db_triggers=$(Q "select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal")"
  note "db_permissions=$(Q "select count(*) from public.permissions")"
  note "db_roles=$(Q "select count(*) from public.roles")"
  note "db_role_permissions=$(Q "select count(*) from public.role_permissions")"
  note "db_migrations=$(Q "select count(*) from supabase_migrations.schema_migrations")"
  note "db_rls_disabled=$(Q "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and not c.relrowsecurity")"
fi
note "files_migrations=$(ls "$ROOT/supabase/migrations" | grep -c '^[0-9]\{4\}_.*\.sql$')"

# Sortie : fichier JSON (sans secret) ; comparaison à la référence si demandé.
node -e '
const fs = require("fs");
const kv = Object.fromEntries(fs.readFileSync(process.argv[1], "utf8").trim().split("\n").filter(Boolean).map(l => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }));
const out = { recorded_at: new Date().toISOString().slice(0, 10), measures: kv };
const base = process.argv[2];
if (process.argv[3] === "record") { fs.writeFileSync(base, JSON.stringify(out, null, 2) + "\n"); console.log("référence écrite : " + base); process.exit(0); }
if (!fs.existsSync(base)) { console.log("aucune référence : lancer avec --record après revue"); process.exit(2); }
const ref = JSON.parse(fs.readFileSync(base, "utf8")).measures;
let bad = 0;
for (const k of Object.keys(ref)) {
  const now = kv[k], was = ref[k];
  if (now === undefined) { console.log(`ABSENT ${k} (référence ${was})`); continue; }
  // Compteurs de tests et d’objets : ne doivent pas baisser ; codes de sortie et échecs : doivent rester identiques.
  if (/_fail$|_exit$/.test(k) || k === "db_rls_disabled") { if (now !== was) { bad++; console.log(`RÉGRESSION ${k} : ${was} -> ${now}`); } }
  else if (/_pass$|^db_|^files_/.test(k)) { if (Number(now) < Number(was)) { bad++; console.log(`RÉGRESSION ${k} : ${was} -> ${now}`); } }
}
for (const k of Object.keys(kv)) if (ref[k] === undefined) console.log(`NOUVEAU ${k}=${kv[k]}`);
console.log(bad ? `RÉSULTAT : ${bad} régression(s)` : "RÉSULTAT : aucune régression par rapport à la référence");
process.exit(bad ? 1 : 0);
' "$RESULTS" "$BASELINE" "$MODE"
CODE=$?
rm -rf "$TMP"
exit $CODE
