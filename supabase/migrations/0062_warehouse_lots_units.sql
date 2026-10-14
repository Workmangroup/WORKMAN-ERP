-- 0062 — Entrepôts, emplacements, lots et unités (rouleaux) (P037)
-- Additive. Le stock FIFO par quantité (stock_lots, 0009) et les mouvements (stock_move, stock_movements) restent la source des quantités.
-- Ajouts : familles de composants (tissu, accessoire, fourniture, EPI, autre), type d'entrepôt « boutique », lots identifiés (code, réf. fournisseur,
-- bain), unités physiques (rouleau ou pièce : longueur, largeur, bain, défauts), historique des unités en ajout seul.
-- Distinction : PROPRIÉTÉ (interne ou client, portée par l'unité et le lot) ≠ LOCALISATION (entrepôt, emplacement de la zone).
--  * Un stock appartenant à un client n'entre pas dans le stock de la société : aucun mouvement de stock n'est créé pour lui (stock_posted = false).
--  * Déplacer une unité change sa localisation, jamais sa propriété.
-- Scope : toute écriture exige private.wh_can(entrepôt, niveau) ; la lecture des unités exige d'avoir accès à leur entrepôt (WAREHOUSE_FORBIDDEN / UNIT_NOT_FOUND).
-- Réutilise : entrepôts et zones (0009, 0017 : warehouse_locations, wh_can), mouvements (stock_move), clients (0004), numérotation (next_seq).

-- ---------------------------------------------------------------------
-- 1. Types d'entrepôt et familles de composants
-- ---------------------------------------------------------------------
alter table public.warehouses drop constraint if exists warehouses_kind_check;
alter table public.warehouses add constraint warehouses_kind_check
  check (kind in ('fabric', 'supplies', 'finished_goods', 'mixed', 'other', 'shop'));

alter table public.bom_materials add column if not exists family text not null default 'other'
  check (family in ('fabric', 'accessory', 'supply', 'ppe', 'other'));
update public.bom_materials set family = case
  when category = 'fabric' then 'fabric'
  when category in ('lining', 'zip', 'button', 'thread', 'label', 'reflective', 'trim') then 'accessory'
  when category = 'packaging' then 'supply'
  else 'other' end
 where family = 'other';

create function public.material_family_set(p_material uuid, p_family text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_old text;
begin
  perform private.require_perm('stock.write');
  if p_family not in ('fabric', 'accessory', 'supply', 'ppe', 'other') then raise exception 'UNIT_FAMILY_INVALID' using errcode = '22023'; end if;
  select family into v_old from public.bom_materials where id = p_material and company_id = v_co;
  if not found then raise exception 'STOCK_MATERIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  update public.bom_materials set family = p_family where id = p_material;
  perform private.write_audit(v_co, 'stock.family_set', 'material', p_material::text, p_family, jsonb_build_object('family', v_old),
    jsonb_build_object('family', p_family), '{}'::jsonb, 'rpc');
end $$;
revoke execute on function public.material_family_set(uuid, text) from public, anon;
grant execute on function public.material_family_set(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 2. Lots identifiés (code de lot, référence fournisseur, bain de teinture, propriétaire)
-- ---------------------------------------------------------------------
create table public.material_lots (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null default private.current_company() references public.companies(id) on delete cascade,
  material_id     uuid not null references public.bom_materials(id),
  lot_code        text not null check (length(btrim(lot_code)) between 2 and 40),
  supplier_lot    text check (supplier_lot is null or length(btrim(supplier_lot)) between 1 and 60),
  dye_bath        text check (dye_bath is null or length(btrim(dye_bath)) between 1 and 40),
  owner_client_id uuid references public.clients(id),
  created_at      timestamptz not null default now(),
  created_by      uuid default auth.uid(),
  unique (company_id, material_id, lot_code),
  unique (company_id, id)
);
alter table public.material_lots enable row level security;
create policy material_lots_select on public.material_lots for select to authenticated
  using (company_id = private.current_company() and private.has_perm('stock.read'));
revoke all on public.material_lots from public, anon, authenticated;
grant select on public.material_lots to authenticated;

create function public.material_lot_create(p_material uuid, p_lot_code text, p_supplier_lot text, p_dye_bath text, p_owner uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid;
begin
  perform private.require_perm('stock.write');
  if not exists (select 1 from public.bom_materials where id = p_material and company_id = v_co) then raise exception 'STOCK_MATERIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  if p_owner is not null and not exists (select 1 from public.clients where id = p_owner and company_id = v_co) then raise exception 'UNIT_OWNER_INVALID' using errcode = '22023'; end if;
  insert into public.material_lots (company_id, material_id, lot_code, supplier_lot, dye_bath, owner_client_id)
  values (v_co, p_material, btrim(p_lot_code), nullif(btrim(coalesce(p_supplier_lot, '')), ''), nullif(btrim(coalesce(p_dye_bath, '')), ''), p_owner)
  returning id into v_id;
  perform private.write_audit(v_co, 'stock.lot_create', 'material_lot', v_id::text, btrim(p_lot_code), null,
    jsonb_build_object('material', p_material, 'owner', p_owner), '{}'::jsonb, 'rpc');
  return v_id;
end $$;
revoke execute on function public.material_lot_create(uuid, text, text, text, uuid) from public, anon;
grant execute on function public.material_lot_create(uuid, text, text, text, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 3. Unités physiques (rouleaux ou pièces) : longueur, largeur, bain, défauts, localisation, propriété
-- ---------------------------------------------------------------------
create table public.material_units (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null default private.current_company() references public.companies(id) on delete cascade,
  unit_code          text not null check (unit_code ~ '^UN-[0-9]{6,}$'),
  material_id        uuid not null references public.bom_materials(id),
  lot_id             uuid not null,
  warehouse_id       uuid not null references public.warehouses(id),
  location_id        uuid not null references public.stock_locations(id),
  qty                numeric(14,4) not null check (qty > 0),
  length_m           numeric(12,2) check (length_m is null or length_m > 0),
  width_cm           numeric(8,2) check (width_cm is null or width_cm > 0),
  dye_bath           text check (dye_bath is null or length(btrim(dye_bath)) between 1 and 40),
  owner_client_id    uuid references public.clients(id),
  stock_posted       boolean not null,
  status             text not null default 'available' check (status in ('available', 'quarantine', 'consumed')),
  receipt_movement_id uuid,
  received_at        timestamptz not null default now(),
  consumed_at        timestamptz,
  created_by         uuid default auth.uid(),
  unique (company_id, unit_code),
  unique (company_id, id),
  foreign key (company_id, lot_id) references public.material_lots(company_id, id),
  check (stock_posted = (owner_client_id is null)),
  check (status <> 'consumed' or consumed_at is not null),
  check (length_m is null or qty = length_m)
);
create index material_units_wh_idx on public.material_units (company_id, warehouse_id, status);
create index material_units_lot_idx on public.material_units (company_id, lot_id);
alter table public.material_units enable row level security;
create policy material_units_select on public.material_units for select to authenticated
  using (company_id = private.current_company() and private.has_perm('stock.read') and private.wh_can(warehouse_id, 'viewer'));
revoke all on public.material_units from public, anon, authenticated;
grant select on public.material_units to authenticated;

-- Défauts : ajout seul (un défaut constaté ne s'efface pas)
create table public.material_unit_defects (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null default private.current_company() references public.companies(id) on delete cascade,
  unit_id     uuid not null references public.material_units(id),
  defect_code text not null check (length(btrim(defect_code)) between 2 and 30),
  severity    text not null check (severity in ('minor', 'major', 'critical')),
  description text not null check (length(btrim(description)) between 5 and 300),
  length_affected_m numeric(12,2) check (length_affected_m is null or length_affected_m > 0),
  recorded_at timestamptz not null default now(),
  recorded_by uuid default auth.uid()
);
alter table public.material_unit_defects enable row level security;
create policy material_unit_defects_select on public.material_unit_defects for select to authenticated
  using (company_id = private.current_company() and exists (select 1 from public.material_units u where u.id = unit_id));
revoke all on public.material_unit_defects from public, anon, authenticated;
grant select on public.material_unit_defects to authenticated;

-- Historique des unités : ajout seul
create table public.material_unit_events (
  seq                bigint generated always as identity primary key,
  id                 uuid not null unique default gen_random_uuid(),
  company_id         uuid not null default private.current_company() references public.companies(id) on delete cascade,
  unit_id            uuid not null references public.material_units(id),
  event              text not null check (event in ('receive', 'move', 'defect', 'quarantine', 'release', 'consume')),
  from_location_id   uuid,
  to_location_id     uuid,
  warehouse_id       uuid not null references public.warehouses(id),
  stock_movement_id  uuid,
  reason             text check (reason is null or length(btrim(reason)) <= 300),
  actor              uuid default auth.uid(),
  at                 timestamptz not null default now()
);
create index material_unit_events_unit_idx on public.material_unit_events (unit_id, seq);
alter table public.material_unit_events enable row level security;
create policy material_unit_events_select on public.material_unit_events for select to authenticated
  using (company_id = private.current_company() and private.has_perm('stock.read') and private.wh_can(warehouse_id, 'viewer'));
revoke all on public.material_unit_events from public, anon, authenticated;
grant select on public.material_unit_events to authenticated;
create function private.material_history_append_only() returns trigger
language plpgsql set search_path = '' as $$ begin raise exception 'UNIT_HISTORY_APPEND_ONLY' using errcode = '42501'; end $$;
create trigger material_unit_events_ao before update or delete on public.material_unit_events for each row execute function private.material_history_append_only();
create trigger material_unit_defects_ao before update or delete on public.material_unit_defects for each row execute function private.material_history_append_only();

-- ---------------------------------------------------------------------
-- 4. Réception d'une unité : entrée de stock (si propriété société) ou simple suivi (si propriété client)
-- ---------------------------------------------------------------------
create function public.material_unit_receive(p_material uuid, p_lot uuid, p_warehouse uuid, p_location uuid, p_length numeric, p_width numeric,
                                             p_dye_bath text, p_owner uuid, p_reference text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); m public.bom_materials%rowtype; lot public.material_lots%rowtype; loc public.stock_locations%rowtype;
        v_id uuid := gen_random_uuid(); v_code text; v_qty numeric; v_mov uuid := null; v_dye text := nullif(btrim(coalesce(p_dye_bath, '')), '');
begin
  perform private.require_perm('stock.write');
  if not private.wh_can(p_warehouse, 'operator') then raise exception 'WAREHOUSE_FORBIDDEN' using errcode = '42501'; end if;
  select * into m from public.bom_materials where id = p_material and company_id = v_co;
  if not found then raise exception 'STOCK_MATERIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  if m.archived_at is not null then raise exception 'UNIT_MATERIAL_ARCHIVED' using errcode = '22023'; end if;
  select * into lot from public.material_lots where id = p_lot and company_id = v_co and material_id = p_material;
  if not found then raise exception 'UNIT_LOT_INVALID' using errcode = '22023'; end if;
  if lot.owner_client_id is distinct from p_owner then raise exception 'UNIT_OWNER_MISMATCH' using errcode = '22023'; end if;
  if p_owner is not null and not exists (select 1 from public.clients where id = p_owner and company_id = v_co) then raise exception 'UNIT_OWNER_INVALID' using errcode = '22023'; end if;
  select * into loc from public.stock_locations where id = p_location and warehouse_id = p_warehouse and company_id = v_co and archived_at is null;
  if not found then raise exception 'STOCK_LOCATION_NOT_FOUND' using errcode = 'P0002'; end if;
  if m.family = 'fabric' then
    if p_length is null or p_length <= 0 then raise exception 'UNIT_LENGTH_REQUIRED' using errcode = '22023'; end if;
    v_qty := p_length;
  else
    if p_length is not null then raise exception 'UNIT_LENGTH_NOT_APPLICABLE' using errcode = '22023'; end if;
    v_qty := 1;
  end if;
  if p_width is not null and p_width <= 0 then raise exception 'UNIT_WIDTH_INVALID' using errcode = '22023'; end if;
  v_code := 'UN-' || lpad(private.next_seq(v_co, 'material_unit')::text, 6, '0');
  if p_owner is null then
    v_mov := public.stock_move('in', p_material, v_qty, p_warehouse, p_location, null, v_code, coalesce(nullif(btrim(coalesce(p_reference, '')), ''), 'Entrée d''unité'), null, null);
  end if;
  insert into public.material_units (id, company_id, unit_code, material_id, lot_id, warehouse_id, location_id, qty, length_m, width_cm, dye_bath,
    owner_client_id, stock_posted, receipt_movement_id)
  values (v_id, v_co, v_code, p_material, p_lot, p_warehouse, p_location, v_qty, case when m.family = 'fabric' then v_qty end, p_width, v_dye,
          p_owner, p_owner is null, v_mov);
  insert into public.material_unit_events (company_id, unit_id, event, to_location_id, warehouse_id, stock_movement_id, reason)
  values (v_co, v_id, 'receive', p_location, p_warehouse, v_mov, nullif(btrim(coalesce(p_reference, '')), ''));
  perform private.write_audit(v_co, 'stock.unit_receive', 'material_unit', v_id::text, v_code, null,
    jsonb_build_object('qty', v_qty, 'warehouse', p_warehouse, 'owner', p_owner, 'stock_posted', p_owner is null), '{}'::jsonb, 'rpc');
  return v_id;
end $$;
revoke execute on function public.material_unit_receive(uuid, uuid, uuid, uuid, numeric, numeric, text, uuid, text) from public, anon;
grant execute on function public.material_unit_receive(uuid, uuid, uuid, uuid, numeric, numeric, text, uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 5. Déplacement (localisation seulement, même entrepôt), défaut, quarantaine, libération, consommation
-- ---------------------------------------------------------------------
create function public.material_unit_move(p_unit uuid, p_location uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); u public.material_units%rowtype; loc public.stock_locations%rowtype; v_mov uuid := null;
begin
  perform private.require_perm('stock.write');
  select * into u from public.material_units where id = p_unit and company_id = v_co for update;
  if not found or not private.wh_can(u.warehouse_id, 'viewer') then raise exception 'UNIT_NOT_FOUND' using errcode = 'P0002'; end if;
  if not private.wh_can(u.warehouse_id, 'operator') then raise exception 'WAREHOUSE_FORBIDDEN' using errcode = '42501'; end if;
  if u.status = 'consumed' then raise exception 'UNIT_CONSUMED' using errcode = '55000'; end if;
  select * into loc from public.stock_locations where id = p_location and warehouse_id = u.warehouse_id and company_id = v_co and archived_at is null;
  if not found then raise exception 'STOCK_LOCATION_NOT_FOUND' using errcode = 'P0002'; end if;
  if loc.id = u.location_id then raise exception 'UNIT_SAME_LOCATION' using errcode = '22023'; end if;
  if u.stock_posted then
    v_mov := public.stock_move('transfer', u.material_id, u.qty, u.warehouse_id, u.location_id, p_location, u.unit_code, 'Déplacement unité', null, null);
  end if;
  update public.material_units set location_id = p_location where id = u.id;
  insert into public.material_unit_events (company_id, unit_id, event, from_location_id, to_location_id, warehouse_id, stock_movement_id)
  values (v_co, u.id, 'move', u.location_id, p_location, u.warehouse_id, v_mov);
  perform private.write_audit(v_co, 'stock.unit_move', 'material_unit', u.id::text, u.unit_code, jsonb_build_object('location', u.location_id),
    jsonb_build_object('location', p_location), '{}'::jsonb, 'rpc');
end $$;
revoke execute on function public.material_unit_move(uuid, uuid) from public, anon;
grant execute on function public.material_unit_move(uuid, uuid) to authenticated, service_role;

create function public.material_unit_defect_record(p_unit uuid, p_code text, p_severity text, p_description text, p_length_affected numeric) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); u public.material_units%rowtype; v_desc text := btrim(coalesce(p_description, ''));
begin
  perform private.require_perm('stock.write');
  select * into u from public.material_units where id = p_unit and company_id = v_co for update;
  if not found or not private.wh_can(u.warehouse_id, 'viewer') then raise exception 'UNIT_NOT_FOUND' using errcode = 'P0002'; end if;
  if not private.wh_can(u.warehouse_id, 'operator') then raise exception 'WAREHOUSE_FORBIDDEN' using errcode = '42501'; end if;
  if u.status = 'consumed' then raise exception 'UNIT_CONSUMED' using errcode = '55000'; end if;
  if p_severity not in ('minor', 'major', 'critical') then raise exception 'UNIT_DEFECT_INVALID' using errcode = '22023'; end if;
  if p_length_affected is not null and (p_length_affected <= 0 or p_length_affected > u.qty) then raise exception 'UNIT_DEFECT_LENGTH_INVALID' using errcode = '22023'; end if;
  insert into public.material_unit_defects (company_id, unit_id, defect_code, severity, description, length_affected_m)
  values (v_co, u.id, btrim(p_code), p_severity, v_desc, p_length_affected);
  insert into public.material_unit_events (company_id, unit_id, event, warehouse_id, reason)
  values (v_co, u.id, 'defect', u.warehouse_id, btrim(p_code) || ' (' || p_severity || ') : ' || v_desc);
  if p_severity = 'critical' and u.status = 'available' then
    update public.material_units set status = 'quarantine' where id = u.id;
    insert into public.material_unit_events (company_id, unit_id, event, warehouse_id, reason)
    values (v_co, u.id, 'quarantine', u.warehouse_id, 'Mise en quarantaine automatique : défaut critique');
  end if;
  perform private.write_audit(v_co, 'stock.unit_defect', 'material_unit', u.id::text, u.unit_code, null,
    jsonb_build_object('code', btrim(p_code), 'severity', p_severity), '{}'::jsonb, 'rpc');
end $$;
revoke execute on function public.material_unit_defect_record(uuid, text, text, text, numeric) from public, anon;
grant execute on function public.material_unit_defect_record(uuid, text, text, text, numeric) to authenticated, service_role;

create function public.material_unit_quarantine(p_unit uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); u public.material_units%rowtype; v_r text := btrim(coalesce(p_reason, ''));
begin
  perform private.require_perm('stock.write');
  if length(v_r) < 5 then raise exception 'UNIT_REASON_REQUIRED' using errcode = '22023'; end if;
  select * into u from public.material_units where id = p_unit and company_id = v_co for update;
  if not found or not private.wh_can(u.warehouse_id, 'viewer') then raise exception 'UNIT_NOT_FOUND' using errcode = 'P0002'; end if;
  if not private.wh_can(u.warehouse_id, 'operator') then raise exception 'WAREHOUSE_FORBIDDEN' using errcode = '42501'; end if;
  if u.status <> 'available' then raise exception 'UNIT_BAD_STATUS' using errcode = '55000'; end if;
  update public.material_units set status = 'quarantine' where id = u.id;
  insert into public.material_unit_events (company_id, unit_id, event, warehouse_id, reason) values (v_co, u.id, 'quarantine', u.warehouse_id, v_r);
  perform private.write_audit(v_co, 'stock.unit_quarantine', 'material_unit', u.id::text, u.unit_code, null, jsonb_build_object('reason', v_r), '{}'::jsonb, 'rpc');
end $$;
revoke execute on function public.material_unit_quarantine(uuid, text) from public, anon;
grant execute on function public.material_unit_quarantine(uuid, text) to authenticated, service_role;

-- Libération : réservée à la qualité (quality.write)
create function public.material_unit_release(p_unit uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); u public.material_units%rowtype; v_r text := btrim(coalesce(p_reason, ''));
begin
  perform private.require_perm('quality.write');
  if length(v_r) < 5 then raise exception 'UNIT_REASON_REQUIRED' using errcode = '22023'; end if;
  select * into u from public.material_units where id = p_unit and company_id = v_co for update;
  if not found or not private.wh_can(u.warehouse_id, 'viewer') then raise exception 'UNIT_NOT_FOUND' using errcode = 'P0002'; end if;
  if u.status <> 'quarantine' then raise exception 'UNIT_BAD_STATUS' using errcode = '55000'; end if;
  update public.material_units set status = 'available' where id = u.id;
  insert into public.material_unit_events (company_id, unit_id, event, warehouse_id, reason) values (v_co, u.id, 'release', u.warehouse_id, v_r);
  perform private.write_audit(v_co, 'stock.unit_release', 'material_unit', u.id::text, u.unit_code, null, jsonb_build_object('reason', v_r), '{}'::jsonb, 'rpc');
end $$;
revoke execute on function public.material_unit_release(uuid, text) from public, anon;
grant execute on function public.material_unit_release(uuid, text) to authenticated, service_role;

-- Consommation : unité disponible seulement (pas en quarantaine) ; sortie de stock si propriété société
create function public.material_unit_consume(p_unit uuid, p_reference text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); u public.material_units%rowtype; v_mov uuid := null;
begin
  perform private.require_perm('stock.write');
  select * into u from public.material_units where id = p_unit and company_id = v_co for update;
  if not found or not private.wh_can(u.warehouse_id, 'viewer') then raise exception 'UNIT_NOT_FOUND' using errcode = 'P0002'; end if;
  if not private.wh_can(u.warehouse_id, 'operator') then raise exception 'WAREHOUSE_FORBIDDEN' using errcode = '42501'; end if;
  if u.status <> 'available' then raise exception 'UNIT_NOT_AVAILABLE' using errcode = '55000'; end if;
  if u.stock_posted then
    v_mov := public.stock_move('out', u.material_id, u.qty, u.warehouse_id, u.location_id, null, coalesce(nullif(btrim(coalesce(p_reference, '')), ''), u.unit_code), 'Consommation unité', null, null);
  end if;
  update public.material_units set status = 'consumed', consumed_at = now() where id = u.id;
  insert into public.material_unit_events (company_id, unit_id, event, from_location_id, warehouse_id, stock_movement_id, reason)
  values (v_co, u.id, 'consume', u.location_id, u.warehouse_id, v_mov, nullif(btrim(coalesce(p_reference, '')), ''));
  perform private.write_audit(v_co, 'stock.unit_consume', 'material_unit', u.id::text, u.unit_code, null, jsonb_build_object('stock_posted', u.stock_posted), '{}'::jsonb, 'rpc');
end $$;
revoke execute on function public.material_unit_consume(uuid, text) from public, anon;
grant execute on function public.material_unit_consume(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 6. Traçabilité : historique complet d'une unité ; lot avec totaux (unités hors périmètre comptées, non détaillées)
-- ---------------------------------------------------------------------
create function public.material_unit_trace(p_unit uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare u public.material_units%rowtype; v_out jsonb;
begin
  if not private.has_perm('stock.read') then raise exception 'RBAC_FORBIDDEN' using errcode = '42501'; end if;
  select * into u from public.material_units where id = p_unit and company_id = private.current_company();
  if not found or not private.wh_can(u.warehouse_id, 'viewer') then raise exception 'UNIT_NOT_FOUND' using errcode = 'P0002'; end if;
  select jsonb_build_object(
    'unit', jsonb_build_object('id', u.id, 'code', u.unit_code, 'material_id', u.material_id, 'lot_id', u.lot_id, 'warehouse_id', u.warehouse_id,
                               'location_id', u.location_id, 'qty', u.qty, 'length_m', u.length_m, 'width_cm', u.width_cm, 'dye_bath', u.dye_bath,
                               'owner_client_id', u.owner_client_id, 'owner', case when u.owner_client_id is null then 'company' else 'client' end,
                               'stock_posted', u.stock_posted, 'status', u.status, 'received_at', u.received_at, 'consumed_at', u.consumed_at,
                               'receipt_movement_id', u.receipt_movement_id),
    'events', coalesce((select jsonb_agg(jsonb_build_object('seq', e.seq, 'event', e.event, 'from_location_id', e.from_location_id,
                 'to_location_id', e.to_location_id, 'stock_movement_id', e.stock_movement_id, 'reason', e.reason, 'at', e.at) order by e.seq)
                from public.material_unit_events e where e.unit_id = u.id), '[]'::jsonb),
    'defects', coalesce((select jsonb_agg(jsonb_build_object('code', d.defect_code, 'severity', d.severity, 'description', d.description,
                 'length_affected_m', d.length_affected_m, 'recorded_at', d.recorded_at) order by d.recorded_at)
                from public.material_unit_defects d where d.unit_id = u.id), '[]'::jsonb)
  ) into v_out;
  return v_out;
end $$;
grant execute on function public.material_unit_trace(uuid) to authenticated, service_role;

create function public.material_lot_trace(p_lot uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare l public.material_lots%rowtype; v_visible jsonb; v_hidden int; v_avail numeric; v_cons numeric;
begin
  if not private.has_perm('stock.read') then raise exception 'RBAC_FORBIDDEN' using errcode = '42501'; end if;
  select * into l from public.material_lots where id = p_lot and company_id = private.current_company();
  if not found then raise exception 'UNIT_LOT_NOT_FOUND' using errcode = 'P0002'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('code', u.unit_code, 'warehouse_id', u.warehouse_id, 'location_id', u.location_id, 'qty', u.qty,
           'status', u.status, 'owner', case when u.owner_client_id is null then 'company' else 'client' end, 'dye_bath', u.dye_bath) order by u.unit_code), '[]'::jsonb)
    into v_visible
    from public.material_units u where u.lot_id = l.id and private.wh_can(u.warehouse_id, 'viewer');
  select count(*) into v_hidden from public.material_units u where u.lot_id = l.id and not private.wh_can(u.warehouse_id, 'viewer');
  select coalesce(sum(u.qty) filter (where u.status = 'available'), 0), coalesce(sum(u.qty) filter (where u.status = 'consumed'), 0)
    into v_avail, v_cons from public.material_units u where u.lot_id = l.id and private.wh_can(u.warehouse_id, 'viewer');
  return jsonb_build_object('lot', jsonb_build_object('id', l.id, 'code', l.lot_code, 'supplier_lot', l.supplier_lot, 'dye_bath', l.dye_bath,
                                                     'material_id', l.material_id, 'owner_client_id', l.owner_client_id),
                            'units', v_visible, 'qty_available_visible', v_avail, 'qty_consumed_visible', v_cons,
                            'units_outside_scope', v_hidden);
end $$;
grant execute on function public.material_lot_trace(uuid) to authenticated, service_role;
