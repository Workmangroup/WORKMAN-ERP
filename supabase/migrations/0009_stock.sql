-- =====================================================================
-- 0009_stock — Module Stock
--  Entrepôts, emplacements, stock par lot (couches FIFO), stocks disponibles / réservés / de sécurité,
--  mouvements (entrée, sortie, transfert, ajustement, inventaire) et historique complet immuable.
--  Les articles stockés sont les composants du catalogue BOM (bom_materials).
--  Permissions existantes : stock.read / stock.write (entrées, sorties, transferts, réservations, comptages)
--                           stock.adjust (ajustements, validation d'inventaire)
--  Valeurs (coûts des lots, valorisation) : tables séparées, lisibles avec costs.read uniquement.
--  Toute écriture sur les lots / mouvements passe par des fonctions security definer : aucun accès direct.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------
create table public.warehouses (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id),
  code        text not null,                                              -- WH-01 (généré, immuable)
  name        text not null check (length(btrim(name)) between 2 and 120),
  city        text check (city is null or length(city) <= 80),
  address     text check (address is null or length(address) <= 200),
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid,
  updated_by  uuid,
  unique (company_id, code)
);
create unique index warehouses_name_uq on public.warehouses (company_id, lower(btrim(name)));

create table public.stock_locations (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id),
  warehouse_id uuid not null references public.warehouses(id),
  code         text not null check (code ~ '^[A-Z0-9][A-Z0-9._-]{0,29}$'),
  name         text check (name is null or length(name) <= 80),
  kind         text not null default 'storage' check (kind in ('storage','receiving','shipping','quarantine')),
  archived_at  timestamptz,
  created_at   timestamptz not null default now(),
  created_by   uuid,
  unique (warehouse_id, code)
);

-- Lots = couches FIFO. quantité restante décroissante, date de réception conservée lors des transferts.
create table public.stock_lots (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id),
  material_id      uuid not null references public.bom_materials(id),
  warehouse_id     uuid not null references public.warehouses(id),
  location_id      uuid not null references public.stock_locations(id),
  qty_in           numeric(14,4) not null check (qty_in > 0),
  qty_remaining    numeric(14,4) not null check (qty_remaining >= 0),
  received_at      timestamptz not null default clock_timestamp(),
  reference        text check (reference is null or length(reference) <= 120),
  source_movement  uuid,
  created_at       timestamptz not null default now(),
  constraint stock_lots_remaining_ck check (qty_remaining <= qty_in)
);
create index stock_lots_fifo_idx on public.stock_lots (material_id, warehouse_id, received_at, id) where qty_remaining > 0;
create index stock_lots_loc_idx  on public.stock_lots (location_id) where qty_remaining > 0;

create table public.stock_lot_costs (
  lot_id     uuid primary key references public.stock_lots(id) on delete cascade,
  company_id uuid not null references public.companies(id),
  unit_cost  numeric(14,4) not null check (unit_cost >= 0)
);

create table public.stock_movements (
  id              uuid primary key default gen_random_uuid(),
  seq             bigint generated always as identity,
  company_id      uuid not null references public.companies(id),
  type            text not null check (type in ('in','out','transfer','adjustment','inventory')),
  direction       text not null check (direction in ('in','out','move')),
  material_id     uuid not null references public.bom_materials(id),
  qty             numeric(14,4) not null check (qty > 0),
  warehouse_id    uuid not null references public.warehouses(id),
  location_id     uuid references public.stock_locations(id),
  to_warehouse_id uuid references public.warehouses(id),
  to_location_id  uuid references public.stock_locations(id),
  reference       text check (reference is null or length(reference) <= 120),
  reason          text check (reason is null or length(reason) <= 300),
  reservation_id  uuid,
  inventory_id    uuid,
  created_at      timestamptz not null default clock_timestamp(),
  created_by      uuid
);
create index stock_movements_idx on public.stock_movements (company_id, created_at desc, seq desc);
create index stock_movements_mat_idx on public.stock_movements (material_id, created_at desc);

-- Détail FIFO : quels lots ont été créés / consommés / déplacés par un mouvement
create table public.stock_movement_allocations (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id),
  movement_id uuid not null references public.stock_movements(id),
  lot_id      uuid not null references public.stock_lots(id),
  to_lot_id   uuid references public.stock_lots(id),
  qty         numeric(14,4) not null check (qty > 0)
);
create index stock_alloc_mov_idx on public.stock_movement_allocations (movement_id);
create index stock_alloc_lot_idx on public.stock_movement_allocations (lot_id);

create table public.stock_movement_costs (
  movement_id uuid primary key references public.stock_movements(id),
  company_id  uuid not null references public.companies(id),
  total_cost  numeric(16,4) not null check (total_cost >= 0)
);

create table public.stock_reservations (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id),
  material_id  uuid not null references public.bom_materials(id),
  warehouse_id uuid not null references public.warehouses(id),
  qty          numeric(14,4) not null check (qty > 0),
  qty_consumed numeric(14,4) not null default 0 check (qty_consumed >= 0 and qty_consumed <= qty),
  status       text not null default 'active' check (status in ('active','released','consumed')),
  reference    text not null check (length(btrim(reference)) between 1 and 120),   -- ex. ordre de fabrication, commande
  note         text check (note is null or length(note) <= 300),
  created_at   timestamptz not null default now(),
  created_by   uuid,
  closed_at    timestamptz
);
create index stock_res_active_idx on public.stock_reservations (material_id, warehouse_id) where status = 'active';

create table public.stock_thresholds (
  company_id   uuid not null references public.companies(id),
  material_id  uuid not null references public.bom_materials(id) on delete cascade,
  warehouse_id uuid not null references public.warehouses(id),
  safety_qty   numeric(14,4) not null check (safety_qty >= 0),
  updated_at   timestamptz not null default now(),
  updated_by   uuid,
  primary key (material_id, warehouse_id)
);

create table public.stock_inventories (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id),
  code         text not null,                                              -- INV-0001
  warehouse_id uuid not null references public.warehouses(id),
  location_id  uuid references public.stock_locations(id),                 -- périmètre (null = tout l'entrepôt)
  status       text not null default 'draft' check (status in ('draft','validated','cancelled')),
  note         text check (note is null or length(note) <= 300),
  created_at   timestamptz not null default now(),
  created_by   uuid,
  closed_at    timestamptz,
  closed_by    uuid,
  unique (company_id, code)
);

create table public.stock_inventory_lines (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id),
  inventory_id  uuid not null references public.stock_inventories(id) on delete cascade,
  material_id   uuid not null references public.bom_materials(id),
  location_id   uuid not null references public.stock_locations(id),
  system_qty    numeric(14,4) not null default 0,                          -- stock théorique à l'ouverture
  counted_qty   numeric(14,4) check (counted_qty is null or counted_qty >= 0),
  applied_delta numeric(14,4),                                             -- écart appliqué à la validation
  unique (inventory_id, material_id, location_id)
);

-- ---------------------------------------------------------------------
-- 2. Vue d'ensemble : disponible = en stock − réservé ; alerte sous le stock de sécurité
-- ---------------------------------------------------------------------
create view public.stock_overview with (security_invoker = true) as
with keys as (
  select company_id, material_id, warehouse_id from public.stock_lots where qty_remaining > 0
  union select company_id, material_id, warehouse_id from public.stock_reservations where status = 'active'
  union select company_id, material_id, warehouse_id from public.stock_thresholds
), oh as (
  select material_id, warehouse_id, sum(qty_remaining) q from public.stock_lots group by 1, 2
), rs as (
  select material_id, warehouse_id, sum(qty - qty_consumed) q from public.stock_reservations where status = 'active' group by 1, 2
)
select k.company_id, k.material_id, k.warehouse_id,
       coalesce(oh.q, 0) as on_hand,
       coalesce(rs.q, 0) as reserved,
       coalesce(oh.q, 0) - coalesce(rs.q, 0) as available,
       coalesce(th.safety_qty, 0) as safety_qty,
       (coalesce(oh.q, 0) - coalesce(rs.q, 0)) < coalesce(th.safety_qty, 0) as below_safety
from keys k
left join oh on oh.material_id = k.material_id and oh.warehouse_id = k.warehouse_id
left join rs on rs.material_id = k.material_id and rs.warehouse_id = k.warehouse_id
left join public.stock_thresholds th on th.material_id = k.material_id and th.warehouse_id = k.warehouse_id;

-- ---------------------------------------------------------------------
-- 3. Triggers : entrepôts, emplacements, immuabilité de l'historique
-- ---------------------------------------------------------------------
create function private.warehouses_before() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.company_id := coalesce(new.company_id, private.current_company());
    new.code := 'WH-' || lpad(private.next_seq(new.company_id, 'warehouse')::text, 2, '0');
    new.created_by := auth.uid(); new.updated_by := auth.uid(); new.archived_at := null;
  elsif coalesce(current_setting('stock.rpc', true), 'off') <> 'on' then
    if old.archived_at is not null then raise exception 'STOCK_WAREHOUSE_ARCHIVED' using errcode = '55000'; end if;
    new.updated_at := now(); new.updated_by := auth.uid();
  end if;
  new.name := btrim(new.name);
  new.city := nullif(btrim(coalesce(new.city, '')), '');
  new.address := nullif(btrim(coalesce(new.address, '')), '');
  return new;
end $$;
create trigger warehouses_before_iu before insert or update on public.warehouses
  for each row execute function private.warehouses_before();

-- chaque entrepôt reçoit un emplacement général
create function private.warehouses_seed_location() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.stock_locations (company_id, warehouse_id, code, name) values (new.company_id, new.id, 'GEN', 'Emplacement général');
  return new;
end $$;
create trigger warehouses_seed_location_i after insert on public.warehouses
  for each row execute function private.warehouses_seed_location();

create function private.stock_locations_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare w public.warehouses%rowtype;
begin
  select * into w from public.warehouses where id = new.warehouse_id;
  if not found then raise exception 'STOCK_WAREHOUSE_NOT_FOUND' using errcode = 'P0002'; end if;
  if tg_op = 'INSERT' then
    if w.archived_at is not null and coalesce(current_setting('stock.rpc', true), 'off') <> 'on' then raise exception 'STOCK_WAREHOUSE_ARCHIVED' using errcode = '55000'; end if;
    new.company_id := w.company_id; new.created_by := coalesce(auth.uid(), new.created_by); new.archived_at := null;
  elsif coalesce(current_setting('stock.rpc', true), 'off') <> 'on' and old.archived_at is not null then
    raise exception 'STOCK_LOCATION_ARCHIVED' using errcode = '55000';
  end if;
  new.code := upper(btrim(new.code));
  new.name := nullif(btrim(coalesce(new.name, '')), '');
  return new;
end $$;
create trigger stock_locations_before_iu before insert or update on public.stock_locations
  for each row execute function private.stock_locations_before();

create function private.stock_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'STOCK_IMMUTABLE' using errcode = '42501';
end $$;
create trigger stock_movements_immutable before update or delete on public.stock_movements for each row execute function private.stock_immutable();
create trigger stock_alloc_immutable before update or delete on public.stock_movement_allocations for each row execute function private.stock_immutable();
create trigger stock_mcosts_immutable before update or delete on public.stock_movement_costs for each row execute function private.stock_immutable();

-- Lignes d'inventaire : comptage seulement tant que l'inventaire est ouvert
create function private.stock_inv_lines_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare i public.stock_inventories%rowtype;
begin
  select * into i from public.stock_inventories where id = coalesce(new.inventory_id, old.inventory_id);
  if coalesce(current_setting('stock.rpc', true), 'off') <> 'on' then
    if i.status <> 'draft' then raise exception 'STOCK_INVENTORY_CLOSED' using errcode = '55000'; end if;
    if tg_op = 'UPDATE' then new.system_qty := old.system_qty; new.applied_delta := old.applied_delta; end if;
  end if;
  return coalesce(new, old);
end $$;
create trigger stock_inv_lines_before_iu before update on public.stock_inventory_lines
  for each row execute function private.stock_inv_lines_before();

-- ---------------------------------------------------------------------
-- 4. Moteur de mouvements (FIFO)
-- ---------------------------------------------------------------------
create function private.stock_on_hand(p_material uuid, p_wh uuid, p_loc uuid default null) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(qty_remaining), 0) from public.stock_lots
  where material_id = p_material and warehouse_id = p_wh and (p_loc is null or location_id = p_loc) $$;

create function private.stock_reserved(p_material uuid, p_wh uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(qty - qty_consumed), 0) from public.stock_reservations
  where material_id = p_material and warehouse_id = p_wh and status = 'active' $$;

-- Consomme p_qty en FIFO (lot le plus ancien d'abord). Si p_dest_loc est donné, recrée les quantités dans l'emplacement
-- de destination en conservant date de réception, référence et coût (le transfert ne rajeunit pas le stock).
create function private.stock_consume(p_company uuid, p_movement uuid, p_material uuid, p_wh uuid, p_loc uuid, p_qty numeric,
                                      p_dest_wh uuid, p_dest_loc uuid) returns numeric
language plpgsql security definer set search_path = '' as $$
declare r record; v_need numeric := p_qty; v_take numeric; v_new uuid; v_cost numeric; v_total numeric := 0;
begin
  for r in
    select * from public.stock_lots
    where material_id = p_material and warehouse_id = p_wh and qty_remaining > 0 and (p_loc is null or location_id = p_loc) and company_id = p_company
    order by received_at, id for update
  loop
    exit when v_need <= 0;
    v_take := least(r.qty_remaining, v_need);
    select unit_cost into v_cost from public.stock_lot_costs where lot_id = r.id;
    update public.stock_lots set qty_remaining = qty_remaining - v_take where id = r.id;
    v_new := null;
    if p_dest_loc is not null then
      v_new := gen_random_uuid();
      insert into public.stock_lots (id, company_id, material_id, warehouse_id, location_id, qty_in, qty_remaining, received_at, reference, source_movement)
      values (v_new, p_company, p_material, p_dest_wh, p_dest_loc, v_take, v_take, r.received_at, r.reference, p_movement);
      if v_cost is not null then insert into public.stock_lot_costs (lot_id, company_id, unit_cost) values (v_new, p_company, v_cost); end if;
    end if;
    insert into public.stock_movement_allocations (company_id, movement_id, lot_id, to_lot_id, qty) values (p_company, p_movement, r.id, v_new, v_take);
    v_total := v_total + v_take * coalesce(v_cost, 0);
    v_need := v_need - v_take;
  end loop;
  if v_need > 0 then raise exception 'STOCK_INSUFFICIENT' using errcode = '55000'; end if;
  return v_total;
end $$;
revoke execute on function private.stock_consume(uuid, uuid, uuid, uuid, uuid, numeric, uuid, uuid) from public, anon, authenticated;

create function private.stock_apply(p_type text, p_dir text, p_material uuid, p_qty numeric, p_wh uuid, p_loc uuid, p_to_loc uuid,
                                    p_ref text, p_reason text, p_cost numeric, p_res uuid, p_inv uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_co uuid := private.current_company();
  m public.bom_materials%rowtype; w public.warehouses%rowtype; l public.stock_locations%rowtype; tl public.stock_locations%rowtype;
  r public.stock_reservations%rowtype; v_id uuid := gen_random_uuid(); v_lot uuid; v_cost numeric; v_total numeric := 0;
  v_oh numeric; v_rs numeric; v_to_wh uuid;
begin
  if p_qty is null or p_qty <= 0 then raise exception 'STOCK_BAD_QTY' using errcode = '22023'; end if;
  select * into m from public.bom_materials where id = p_material and company_id = v_co;
  if not found then raise exception 'STOCK_MATERIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into w from public.warehouses where id = p_wh and company_id = v_co;
  if not found then raise exception 'STOCK_WAREHOUSE_NOT_FOUND' using errcode = 'P0002'; end if;
  if w.archived_at is not null then raise exception 'STOCK_WAREHOUSE_ARCHIVED' using errcode = '55000'; end if;
  if p_loc is not null then
    select * into l from public.stock_locations where id = p_loc and warehouse_id = p_wh;
    if not found then raise exception 'STOCK_LOCATION_NOT_FOUND' using errcode = 'P0002'; end if;
  end if;
  p_ref := nullif(btrim(coalesce(p_ref, '')), ''); p_reason := nullif(btrim(coalesce(p_reason, '')), '');

  if p_dir = 'in' then
    if p_loc is null then raise exception 'STOCK_LOCATION_REQUIRED' using errcode = '22023'; end if;
    if l.archived_at is not null then raise exception 'STOCK_LOCATION_ARCHIVED' using errcode = '55000'; end if;
    if p_type = 'in' and m.archived_at is not null then raise exception 'STOCK_MATERIAL_ARCHIVED' using errcode = '55000'; end if;
  elsif p_dir = 'move' then
    select * into tl from public.stock_locations where id = p_to_loc and company_id = v_co;
    if not found then raise exception 'STOCK_LOCATION_NOT_FOUND' using errcode = 'P0002'; end if;
    if tl.archived_at is not null then raise exception 'STOCK_LOCATION_ARCHIVED' using errcode = '55000'; end if;
    if p_loc is not null and p_loc = p_to_loc then raise exception 'STOCK_SAME_LOCATION' using errcode = '22023'; end if;
    v_to_wh := tl.warehouse_id;
    if exists (select 1 from public.warehouses where id = v_to_wh and archived_at is not null) then raise exception 'STOCK_WAREHOUSE_ARCHIVED' using errcode = '55000'; end if;
  end if;

  -- disponibilité : les sorties et transferts respectent les réservations (sauf la réservation consommée)
  if p_type in ('out', 'transfer') then
    v_oh := private.stock_on_hand(p_material, p_wh); v_rs := private.stock_reserved(p_material, p_wh);
    if p_res is not null then
      select * into r from public.stock_reservations where id = p_res and company_id = v_co for update;
      if not found or r.status <> 'active' or r.material_id <> p_material or r.warehouse_id <> p_wh or p_qty > r.qty - r.qty_consumed then
        raise exception 'STOCK_BAD_RESERVATION' using errcode = '22023';
      end if;
      v_rs := v_rs - (r.qty - r.qty_consumed);
    end if;
    if v_oh < p_qty then raise exception 'STOCK_INSUFFICIENT' using errcode = '55000'; end if;
    if v_oh - v_rs < p_qty then raise exception 'STOCK_RESERVED' using errcode = '55000'; end if;
  end if;

  insert into public.stock_movements (id, company_id, type, direction, material_id, qty, warehouse_id, location_id, to_warehouse_id, to_location_id,
                                      reference, reason, reservation_id, inventory_id, created_by)
  values (v_id, v_co, p_type, p_dir, p_material, p_qty, p_wh, p_loc, v_to_wh, case when p_dir = 'move' then p_to_loc end, p_ref, p_reason, p_res, p_inv, auth.uid());

  if p_dir = 'in' then
    -- coût : saisi (costs.read) sinon prix courant du catalogue BOM, sinon 0
    v_cost := case when p_cost is not null and private.has_perm('costs.read') then p_cost end;
    if v_cost is null then select unit_cost into v_cost from public.bom_material_prices where material_id = p_material; end if;
    v_cost := coalesce(v_cost, 0);
    v_lot := gen_random_uuid();
    insert into public.stock_lots (id, company_id, material_id, warehouse_id, location_id, qty_in, qty_remaining, reference, source_movement)
    values (v_lot, v_co, p_material, p_wh, p_loc, p_qty, p_qty, p_ref, v_id);
    insert into public.stock_lot_costs (lot_id, company_id, unit_cost) values (v_lot, v_co, v_cost);
    insert into public.stock_movement_allocations (company_id, movement_id, lot_id, qty) values (v_co, v_id, v_lot, p_qty);
    v_total := p_qty * v_cost;
  else
    v_total := private.stock_consume(v_co, v_id, p_material, p_wh, p_loc, p_qty, v_to_wh, case when p_dir = 'move' then p_to_loc end);
  end if;
  insert into public.stock_movement_costs (movement_id, company_id, total_cost) values (v_id, v_co, v_total);

  if p_res is not null and p_type = 'out' then
    update public.stock_reservations set qty_consumed = qty_consumed + p_qty,
      status = case when qty_consumed + p_qty >= qty then 'consumed' else 'active' end,
      closed_at = case when qty_consumed + p_qty >= qty then now() end
    where id = p_res;
  end if;
  return v_id;
end $$;
revoke execute on function private.stock_apply(text, text, uuid, numeric, uuid, uuid, uuid, text, text, numeric, uuid, uuid) from public, anon, authenticated;

-- Point d'entrée unique : entrée / sortie / transfert / ajustement
create function public.stock_move(p_type text, p_material uuid, p_qty numeric, p_warehouse uuid, p_location uuid default null,
                                  p_to_location uuid default null, p_reference text default null, p_reason text default null,
                                  p_unit_cost numeric default null, p_reservation uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_dir text;
begin
  if p_type not in ('in', 'out', 'transfer', 'adjustment') then raise exception 'STOCK_BAD_TYPE' using errcode = '22023'; end if;
  perform private.require_perm(case when p_type = 'adjustment' then 'stock.adjust' else 'stock.write' end);
  if p_type = 'adjustment' then
    if p_qty is null or p_qty = 0 then raise exception 'STOCK_BAD_QTY' using errcode = '22023'; end if;
    if length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'STOCK_REASON_REQUIRED' using errcode = '22023'; end if;
    v_dir := case when p_qty > 0 then 'in' else 'out' end;
    return private.stock_apply('adjustment', v_dir, p_material, abs(p_qty), p_warehouse, p_location, null, p_reference, p_reason, null, null, null);
  end if;
  v_dir := case p_type when 'in' then 'in' when 'out' then 'out' else 'move' end;
  return private.stock_apply(p_type, v_dir, p_material, p_qty, p_warehouse, p_location, p_to_location, p_reference, p_reason, p_unit_cost, p_reservation, null);
end $$;

-- ---------------------------------------------------------------------
-- 5. Réservations et stock de sécurité
-- ---------------------------------------------------------------------
create function public.stock_reserve(p_material uuid, p_warehouse uuid, p_qty numeric, p_reference text, p_note text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid := gen_random_uuid(); m public.bom_materials%rowtype;
begin
  perform private.require_perm('stock.write');
  if p_qty is null or p_qty <= 0 then raise exception 'STOCK_BAD_QTY' using errcode = '22023'; end if;
  if length(btrim(coalesce(p_reference, ''))) < 1 then raise exception 'STOCK_REFERENCE_REQUIRED' using errcode = '22023'; end if;
  select * into m from public.bom_materials where id = p_material and company_id = v_co;
  if not found then raise exception 'STOCK_MATERIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.warehouses where id = p_warehouse and company_id = v_co and archived_at is null) then raise exception 'STOCK_WAREHOUSE_NOT_FOUND' using errcode = 'P0002'; end if;
  perform 1 from public.bom_materials where id = p_material for update;     -- sérialise les réservations d'un même composant
  if private.stock_on_hand(p_material, p_warehouse) - private.stock_reserved(p_material, p_warehouse) < p_qty then
    raise exception 'STOCK_INSUFFICIENT_AVAILABLE' using errcode = '55000';
  end if;
  insert into public.stock_reservations (id, company_id, material_id, warehouse_id, qty, reference, note, created_by)
  values (v_id, v_co, p_material, p_warehouse, p_qty, btrim(p_reference), nullif(btrim(coalesce(p_note, '')), ''), auth.uid());
  perform private.write_audit(v_co, 'stock.reserve', 'stock', p_material::text, m.code, null, jsonb_build_object('qty', p_qty),
    jsonb_build_object('reference', btrim(p_reference), 'warehouse_id', p_warehouse, 'material', m.name), 'rpc');
  return v_id;
end $$;

create function public.stock_release(p_reservation uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.stock_reservations%rowtype; m public.bom_materials%rowtype;
begin
  perform private.require_perm('stock.write');
  select * into r from public.stock_reservations where id = p_reservation and company_id = private.current_company() for update;
  if not found then raise exception 'STOCK_BAD_RESERVATION' using errcode = 'P0002'; end if;
  if r.status <> 'active' then raise exception 'STOCK_BAD_RESERVATION' using errcode = '55000'; end if;
  select * into m from public.bom_materials where id = r.material_id;
  update public.stock_reservations set status = 'released', closed_at = now() where id = p_reservation;
  perform private.write_audit(r.company_id, 'stock.release', 'stock', r.material_id::text, m.code, null, null,
    jsonb_build_object('reference', r.reference, 'qty', r.qty - r.qty_consumed, 'material', m.name), 'rpc');
end $$;

create function public.stock_set_safety(p_material uuid, p_warehouse uuid, p_qty numeric) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); m public.bom_materials%rowtype; v_old numeric;
begin
  perform private.require_perm('stock.write');
  if p_qty is null or p_qty < 0 then raise exception 'STOCK_BAD_QTY' using errcode = '22023'; end if;
  select * into m from public.bom_materials where id = p_material and company_id = v_co;
  if not found then raise exception 'STOCK_MATERIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.warehouses where id = p_warehouse and company_id = v_co) then raise exception 'STOCK_WAREHOUSE_NOT_FOUND' using errcode = 'P0002'; end if;
  select safety_qty into v_old from public.stock_thresholds where material_id = p_material and warehouse_id = p_warehouse;
  insert into public.stock_thresholds (company_id, material_id, warehouse_id, safety_qty, updated_by) values (v_co, p_material, p_warehouse, p_qty, auth.uid())
  on conflict (material_id, warehouse_id) do update set safety_qty = excluded.safety_qty, updated_at = now(), updated_by = auth.uid();
  if v_old is distinct from p_qty then
    perform private.write_audit(v_co, 'stock.safety_set', 'stock', p_material::text, m.code, jsonb_build_object('safety_qty', v_old), jsonb_build_object('safety_qty', p_qty),
      jsonb_build_object('warehouse_id', p_warehouse, 'material', m.name), 'rpc');
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 6. Inventaire : comptage puis validation (écarts appliqués en mouvements « inventaire »)
-- ---------------------------------------------------------------------
create function public.stock_inventory_create(p_warehouse uuid, p_location uuid default null, p_note text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid := gen_random_uuid(); v_code text;
begin
  perform private.require_perm('stock.write');
  if not exists (select 1 from public.warehouses where id = p_warehouse and company_id = v_co and archived_at is null) then raise exception 'STOCK_WAREHOUSE_NOT_FOUND' using errcode = 'P0002'; end if;
  if p_location is not null and not exists (select 1 from public.stock_locations where id = p_location and warehouse_id = p_warehouse) then raise exception 'STOCK_LOCATION_NOT_FOUND' using errcode = 'P0002'; end if;
  if exists (select 1 from public.stock_inventories where warehouse_id = p_warehouse and status = 'draft'
             and (location_id is null or p_location is null or location_id = p_location)) then
    raise exception 'STOCK_INVENTORY_OPEN' using errcode = '55000';       -- un seul inventaire ouvert par périmètre
  end if;
  v_code := 'INV-' || lpad(private.next_seq(v_co, 'inventory')::text, 4, '0');
  insert into public.stock_inventories (id, company_id, code, warehouse_id, location_id, note, created_by)
  values (v_id, v_co, v_code, p_warehouse, p_location, nullif(btrim(coalesce(p_note, '')), ''), auth.uid());
  perform set_config('stock.rpc', 'on', true);
  insert into public.stock_inventory_lines (company_id, inventory_id, material_id, location_id, system_qty)
  select v_co, v_id, material_id, location_id, sum(qty_remaining) from public.stock_lots
  where warehouse_id = p_warehouse and qty_remaining > 0 and (p_location is null or location_id = p_location) group by material_id, location_id;
  perform set_config('stock.rpc', 'off', true);
  perform private.write_audit(v_co, 'inventory.create', 'inventory', v_id::text, v_code, null, jsonb_build_object('warehouse_id', p_warehouse, 'location_id', p_location), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

create function public.stock_inventory_add_line(p_inventory uuid, p_material uuid, p_location uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare i public.stock_inventories%rowtype;
begin
  perform private.require_perm('stock.write');
  select * into i from public.stock_inventories where id = p_inventory and company_id = private.current_company();
  if not found then raise exception 'STOCK_INVENTORY_NOT_FOUND' using errcode = 'P0002'; end if;
  if i.status <> 'draft' then raise exception 'STOCK_INVENTORY_CLOSED' using errcode = '55000'; end if;
  if not exists (select 1 from public.stock_locations where id = p_location and warehouse_id = i.warehouse_id and (i.location_id is null or id = i.location_id)) then raise exception 'STOCK_LOCATION_NOT_FOUND' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.bom_materials where id = p_material and company_id = i.company_id) then raise exception 'STOCK_MATERIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  perform set_config('stock.rpc', 'on', true);
  insert into public.stock_inventory_lines (company_id, inventory_id, material_id, location_id, system_qty)
  values (i.company_id, p_inventory, p_material, p_location, private.stock_on_hand(p_material, i.warehouse_id, p_location))
  on conflict (inventory_id, material_id, location_id) do nothing;
  perform set_config('stock.rpc', 'off', true);
end $$;

create function public.stock_inventory_validate(p_inventory uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare i public.stock_inventories%rowtype; r record; v_cur numeric; v_delta numeric; v_n int := 0; v_adj int := 0;
begin
  perform private.require_perm('stock.adjust');
  select * into i from public.stock_inventories where id = p_inventory and company_id = private.current_company() for update;
  if not found then raise exception 'STOCK_INVENTORY_NOT_FOUND' using errcode = 'P0002'; end if;
  if i.status <> 'draft' then raise exception 'STOCK_INVENTORY_CLOSED' using errcode = '55000'; end if;
  if not exists (select 1 from public.stock_inventory_lines where inventory_id = p_inventory and counted_qty is not null) then raise exception 'STOCK_INVENTORY_EMPTY' using errcode = '55000'; end if;
  perform set_config('stock.rpc', 'on', true);
  for r in select * from public.stock_inventory_lines where inventory_id = p_inventory and counted_qty is not null order by id loop
    v_n := v_n + 1;
    v_cur := private.stock_on_hand(r.material_id, i.warehouse_id, r.location_id);
    v_delta := r.counted_qty - v_cur;
    if v_delta <> 0 then
      perform private.stock_apply('inventory', case when v_delta > 0 then 'in' else 'out' end, r.material_id, abs(v_delta), i.warehouse_id, r.location_id, null,
                                  i.code, 'Inventaire ' || i.code, null, null, p_inventory);
      v_adj := v_adj + 1;
    end if;
    update public.stock_inventory_lines set applied_delta = v_delta where id = r.id;
  end loop;
  update public.stock_inventories set status = 'validated', closed_at = now(), closed_by = auth.uid() where id = p_inventory;
  perform set_config('stock.rpc', 'off', true);
  perform private.write_audit(i.company_id, 'inventory.validate', 'inventory', i.id::text, i.code, null, null, jsonb_build_object('lines', v_n, 'adjusted', v_adj), 'rpc');
  return v_adj;
end $$;

create function public.stock_inventory_cancel(p_inventory uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare i public.stock_inventories%rowtype;
begin
  perform private.require_perm('stock.write');
  select * into i from public.stock_inventories where id = p_inventory and company_id = private.current_company() for update;
  if not found then raise exception 'STOCK_INVENTORY_NOT_FOUND' using errcode = 'P0002'; end if;
  if i.status <> 'draft' then raise exception 'STOCK_INVENTORY_CLOSED' using errcode = '55000'; end if;
  update public.stock_inventories set status = 'cancelled', closed_at = now(), closed_by = auth.uid() where id = p_inventory;
  perform private.write_audit(i.company_id, 'inventory.cancel', 'inventory', i.id::text, i.code, null, null, '{}'::jsonb, 'rpc');
end $$;

-- ---------------------------------------------------------------------
-- 7. Archivage des entrepôts et emplacements (uniquement vides)
-- ---------------------------------------------------------------------
create function public.stock_warehouse_archive(p_warehouse uuid, p_archive boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare w public.warehouses%rowtype;
begin
  perform private.require_perm('stock.write');
  select * into w from public.warehouses where id = p_warehouse and company_id = private.current_company() for update;
  if not found then raise exception 'STOCK_WAREHOUSE_NOT_FOUND' using errcode = 'P0002'; end if;
  if p_archive then
    if w.archived_at is not null then raise exception 'STOCK_WAREHOUSE_ARCHIVED' using errcode = '55000'; end if;
    if exists (select 1 from public.stock_lots where warehouse_id = p_warehouse and qty_remaining > 0)
       or exists (select 1 from public.stock_reservations where warehouse_id = p_warehouse and status = 'active')
       or exists (select 1 from public.stock_inventories where warehouse_id = p_warehouse and status = 'draft') then
      raise exception 'STOCK_NOT_EMPTY' using errcode = '55000';
    end if;
  elsif w.archived_at is null then raise exception 'STOCK_BAD_STATUS' using errcode = '55000';
  end if;
  perform set_config('stock.rpc', 'on', true);
  update public.warehouses set archived_at = case when p_archive then now() end, updated_at = now(), updated_by = auth.uid() where id = p_warehouse;
  perform set_config('stock.rpc', 'off', true);
  perform private.write_audit(w.company_id, case when p_archive then 'warehouse.archive' else 'warehouse.restore' end, 'warehouse', w.id::text, w.code, null, null, jsonb_build_object('name', w.name), 'rpc');
end $$;

create function public.stock_location_archive(p_location uuid, p_archive boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare l public.stock_locations%rowtype;
begin
  perform private.require_perm('stock.write');
  select * into l from public.stock_locations where id = p_location and company_id = private.current_company() for update;
  if not found then raise exception 'STOCK_LOCATION_NOT_FOUND' using errcode = 'P0002'; end if;
  if p_archive then
    if l.archived_at is not null then raise exception 'STOCK_LOCATION_ARCHIVED' using errcode = '55000'; end if;
    if exists (select 1 from public.stock_lots where location_id = p_location and qty_remaining > 0) then raise exception 'STOCK_NOT_EMPTY' using errcode = '55000'; end if;
    if (select count(*) from public.stock_locations where warehouse_id = l.warehouse_id and archived_at is null) <= 1 then raise exception 'STOCK_LAST_LOCATION' using errcode = '55000'; end if;
  else
    if l.archived_at is null then raise exception 'STOCK_BAD_STATUS' using errcode = '55000'; end if;
    if exists (select 1 from public.warehouses where id = l.warehouse_id and archived_at is not null) then raise exception 'STOCK_WAREHOUSE_ARCHIVED' using errcode = '55000'; end if;
  end if;
  perform set_config('stock.rpc', 'on', true);
  update public.stock_locations set archived_at = case when p_archive then now() end where id = p_location;
  perform set_config('stock.rpc', 'off', true);
  perform private.write_audit(l.company_id, case when p_archive then 'location.archive' else 'location.restore' end, 'location', l.id::text, l.code, null, null,
    jsonb_build_object('warehouse_id', l.warehouse_id), 'rpc');
end $$;

-- ---------------------------------------------------------------------
-- 8. Historique (entrepôts, emplacements) : lisible avec stock.read
-- ---------------------------------------------------------------------
create function private.audit_warehouses() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_chg jsonb;
begin
  if coalesce(current_setting('stock.rpc', true), 'off') = 'on' then return new; end if;
  if tg_op = 'INSERT' then
    perform private.write_audit(new.company_id, 'warehouse.create', 'warehouse', new.id::text, new.code, null, jsonb_build_object('code', new.code, 'name', new.name, 'city', new.city));
  else
    v_chg := private.jsonb_changes(to_jsonb(old), to_jsonb(new), (select array_agg(k) from jsonb_object_keys(to_jsonb(new)) k where k not in ('name','city','address')));
    if v_chg -> 'after' <> '{}'::jsonb then perform private.write_audit(new.company_id, 'warehouse.update', 'warehouse', new.id::text, new.code, v_chg -> 'before', v_chg -> 'after'); end if;
  end if;
  return new;
end $$;
create trigger audit_warehouses_iu after insert or update on public.warehouses for each row execute function private.audit_warehouses();

create function private.audit_stock_locations() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_chg jsonb; v_wh text;
begin
  if coalesce(current_setting('stock.rpc', true), 'off') = 'on' then return new; end if;
  select code into v_wh from public.warehouses where id = new.warehouse_id;
  if tg_op = 'INSERT' then
    perform private.write_audit(new.company_id, 'location.create', 'location', new.id::text, new.code, null, jsonb_build_object('code', new.code, 'name', new.name, 'kind', new.kind), jsonb_build_object('warehouse', v_wh, 'warehouse_id', new.warehouse_id));
  else
    v_chg := private.jsonb_changes(to_jsonb(old), to_jsonb(new), (select array_agg(k) from jsonb_object_keys(to_jsonb(new)) k where k not in ('name','kind','code')));
    if v_chg -> 'after' <> '{}'::jsonb then perform private.write_audit(new.company_id, 'location.update', 'location', new.id::text, new.code, v_chg -> 'before', v_chg -> 'after', jsonb_build_object('warehouse', v_wh, 'warehouse_id', new.warehouse_id)); end if;
  end if;
  return new;
end $$;
create trigger audit_stock_locations_iu after insert or update on public.stock_locations for each row execute function private.audit_stock_locations();

create policy audit_logs_select_stock on public.audit_logs for select to authenticated
  using (entity_type in ('warehouse', 'location', 'inventory', 'stock') and company_id = private.current_company() and private.has_perm('stock.read'));

-- ---------------------------------------------------------------------
-- 9. RLS + privilèges
-- ---------------------------------------------------------------------
alter table public.warehouses                enable row level security;
alter table public.stock_locations           enable row level security;
alter table public.stock_lots                enable row level security;
alter table public.stock_lot_costs           enable row level security;
alter table public.stock_movements           enable row level security;
alter table public.stock_movement_allocations enable row level security;
alter table public.stock_movement_costs      enable row level security;
alter table public.stock_reservations        enable row level security;
alter table public.stock_thresholds          enable row level security;
alter table public.stock_inventories         enable row level security;
alter table public.stock_inventory_lines     enable row level security;

revoke all on public.warehouses, public.stock_locations, public.stock_lots, public.stock_lot_costs, public.stock_movements,
              public.stock_movement_allocations, public.stock_movement_costs, public.stock_reservations, public.stock_thresholds,
              public.stock_inventories, public.stock_inventory_lines, public.stock_overview from anon, authenticated;
grant all on public.warehouses, public.stock_locations, public.stock_lots, public.stock_lot_costs, public.stock_movements,
             public.stock_movement_allocations, public.stock_movement_costs, public.stock_reservations, public.stock_thresholds,
             public.stock_inventories, public.stock_inventory_lines, public.stock_overview to service_role;
grant select on public.warehouses, public.stock_locations, public.stock_lots, public.stock_lot_costs, public.stock_movements,
                public.stock_movement_allocations, public.stock_movement_costs, public.stock_reservations, public.stock_thresholds,
                public.stock_inventories, public.stock_inventory_lines, public.stock_overview to authenticated;
grant insert (name, city, address) on public.warehouses to authenticated;
grant update (name, city, address) on public.warehouses to authenticated;
grant insert (warehouse_id, code, name, kind) on public.stock_locations to authenticated;
grant update (name, kind) on public.stock_locations to authenticated;
grant update (counted_qty) on public.stock_inventory_lines to authenticated;

do $$
declare t text;
begin
  foreach t in array array['warehouses','stock_locations','stock_lots','stock_movements','stock_movement_allocations','stock_reservations','stock_thresholds','stock_inventories','stock_inventory_lines'] loop
    execute format($f$create policy %I on public.%I for select to authenticated using (company_id = private.current_company() and private.has_perm('stock.read'))$f$, t || '_select', t);
  end loop;
end $$;
create policy stock_lot_costs_select on public.stock_lot_costs for select to authenticated
  using (company_id = private.current_company() and private.has_perm('stock.read') and private.has_perm('costs.read'));
create policy stock_movement_costs_select on public.stock_movement_costs for select to authenticated
  using (company_id = private.current_company() and private.has_perm('stock.read') and private.has_perm('costs.read'));

create policy warehouses_insert on public.warehouses for insert to authenticated
  with check (company_id = private.current_company() and private.has_perm('stock.write'));
create policy warehouses_update on public.warehouses for update to authenticated
  using (company_id = private.current_company() and private.has_perm('stock.write')) with check (company_id = private.current_company() and private.has_perm('stock.write'));
create policy stock_locations_insert on public.stock_locations for insert to authenticated
  with check (company_id = private.current_company() and private.has_perm('stock.write'));
create policy stock_locations_update on public.stock_locations for update to authenticated
  using (company_id = private.current_company() and private.has_perm('stock.write')) with check (company_id = private.current_company() and private.has_perm('stock.write'));
create policy stock_inv_lines_update on public.stock_inventory_lines for update to authenticated
  using (company_id = private.current_company() and private.has_perm('stock.write')) with check (company_id = private.current_company() and private.has_perm('stock.write'));

do $$
declare f text;
begin
  foreach f in array array['stock_move(text,uuid,numeric,uuid,uuid,uuid,text,text,numeric,uuid)', 'stock_reserve(uuid,uuid,numeric,text,text)', 'stock_release(uuid)',
      'stock_set_safety(uuid,uuid,numeric)', 'stock_inventory_create(uuid,uuid,text)', 'stock_inventory_add_line(uuid,uuid,uuid)', 'stock_inventory_validate(uuid)',
      'stock_inventory_cancel(uuid)', 'stock_warehouse_archive(uuid,boolean)', 'stock_location_archive(uuid,boolean)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
