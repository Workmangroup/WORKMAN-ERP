#!/usr/bin/env bash
# Test de concurrence réel : deux sessions PostgreSQL réservent la même quantité au même moment.
# Attendu : une seule réservation réussit ; la seconde attend le verrou puis reçoit STOCK_INSUFFICIENT_AVAILABLE.
# Prérequis : base locale Supabase démarrée (conteneur supabase_db_mb-confection-erp), migrations 0001–0030 appliquées.
# Usage : bash tests/concurrency/reserve-concurrency.sh
set -euo pipefail

DB=supabase_db_mb-confection-erp
ADMIN=f994cb76-321d-43e7-b071-9e1ffe8e8478   # administrateur de test local (compte créé par create-admin.mjs)
SFX=$(date +%H%M%S%N | cut -c1-12)
psql_() { docker exec -i "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -tA "$@"; }
auth() { echo "select set_config('request.jwt.claims', '{\"sub\":\"$ADMIN\",\"role\":\"authenticated\"}', false); set role authenticated;"; }

echo "== Préparation : entrepôt, emplacement, matière, 10 unités en stock"
psql_ <<EOF
$(auth)
insert into warehouses (name, city, address, kind) values ('Conc WH $SFX', 'Sfax', 'Test', 'fabric');
insert into stock_locations (warehouse_id, code, name, kind)
  select id, 'LOC-C', 'Emplacement concurrence', 'storage' from warehouses where name = 'Conc WH $SFX';
insert into bom_materials (name, category, unit) values ('Conc MAT $SFX', 'fabric', 'm');
select stock_move('in', m.id, 10, w.id, l.id, null, 'CONC-$SFX', 'Stock test concurrence', 1)
  from bom_materials m, warehouses w, stock_locations l
 where m.name = 'Conc MAT $SFX' and w.name = 'Conc WH $SFX' and l.warehouse_id = w.id and l.code = 'LOC-C';
-- Un entrepôt crée un emplacement par défaut : seule l'entrée sur LOC-C doit être faite (10 unités exactement).
EOF

MAT=$(psql_ -c "select id from bom_materials where name = 'Conc MAT $SFX';")
WH=$(psql_ -c "select id from warehouses where name = 'Conc WH $SFX';")

reserve() {
  # $1 : libellé de la session. Le verrou est pris dans la fonction, la transaction reste ouverte jusqu'au COMMIT.
  psql_ <<EOF 2>&1 | sed "s/^/[$1] /"
$(auth)
begin;
select 'reservation '||stock_reserve('$MAT','$WH',10,'$1')::text as resultat;
select pg_sleep(3);
commit;
EOF
}

echo "== Deux réservations simultanées de 10 unités sur un stock de 10"
reserve A &
PID_A=$!
sleep 1
reserve B &
PID_B=$!
wait "$PID_A" || true
wait "$PID_B" || true

echo "== Contrôle : total réservé pour cette matière"
TOTAL=$(psql_ -c "select coalesce(sum(qty),0) from stock_reservations where material_id = '$MAT' and status = 'active';" | tr -d ' ')
echo "total réservé = $TOTAL (attendu : 10)"
if [ "$TOTAL" = "10.00" ] || [ "$TOTAL" = "10" ] || [ "$TOTAL" = "10.0000" ]; then
  echo "OK : pas de survente"
  exit 0
else
  echo "ÉCHEC : survente ou réservation manquante"
  exit 1
fi
