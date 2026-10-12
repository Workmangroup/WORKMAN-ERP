-- =====================================================================
-- 0017_warehouses — Multi-entrepôts : entrepôts, zones, emplacements, responsables et accès par entrepôt
--  Étend l'existant (0009_stock) au lieu de le dupliquer :
--    warehouses           : + type d'entrepôt (tissus, fournitures, produits finis…)
--    warehouse_locations  : zones d'un entrepôt (zone de coupe, zone accessoires, quarantaine…)
--    stock_locations      : emplacements (allées, racks) ; chacun peut être rattaché à une zone (zone_id)
--    user_warehouses      : accès utilisateur par entrepôt, avec rôle viewer / operator / manager (responsable)
--  Règle d'accès (appliquée en base, quelle que soit l'interface) :
--    - lecture : entrepôts affectés (ou warehouses.all / warehouses.manage) — politiques RESTRICTIVES sur toutes les tables
--      portant un entrepôt (elles s'ajoutent aux politiques existantes : aucune fuite possible) ;
--    - écriture stock : rôle operator ou manager sur l'entrepôt — déclencheurs (y compris pour les RPC) ;
--    - emplacements et zones : rôle manager (ou warehouses.manage) ;
--    - entrepôts (création, suppression, modification) : warehouses.manage, ou manager de l'entrepôt pour la modification.
--  Accès refusé : erreur WAREHOUSE_FORBIDDEN (SQLSTATE 42501), tracée côté application.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Permissions
-- ---------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('warehouses.manage', 'stock', 'Gérer les entrepôts et les accès', 'Créer et modifier les entrepôts, zones, emplacements et affectations de tous les entrepôts'),
  ('warehouses.all',    'stock', 'Voir tous les entrepôts',          'Lecture de tous les entrepôts de la société, sans affectation')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on r.is_system and (
     (r.code = 'admin'     and p.code in ('warehouses.manage', 'warehouses.all'))
  or (r.code = 'direction' and p.code = 'warehouses.all'))
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 2. Colonnes ajoutées
-- ---------------------------------------------------------------------
alter table public.warehouses add column kind text not null default 'mixed'
  check (kind in ('fabric', 'supplies', 'finished_goods', 'mixed', 'other'));
alter table public.stock_locations add column zone_id uuid;     -- clé étrangère ajoutée après la création de warehouse_locations

-- ---------------------------------------------------------------------
-- 3. Tables nouvelles : zones et accès utilisateurs
-- ---------------------------------------------------------------------
create table public.warehouse_locations (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id),
  warehouse_id uuid not null references public.warehouses(id),
  code         text not null check (code ~ '^[A-Z0-9][A-Z0-9._-]{0,19}$'),
  name         text not null check (length(btrim(name)) between 2 and 80),
  zone_type    text not null default 'storage' check (zone_type in ('storage', 'reception', 'cutting', 'workshop', 'quarantine', 'shipping', 'other')),
  notes        text check (notes is null or length(notes) <= 300),
  archived_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid,
  updated_by   uuid,
  unique (warehouse_id, code)
);
alter table public.stock_locations add constraint stock_locations_zone_fk foreign key (zone_id) references public.warehouse_locations(id) on delete set null;

create table public.user_warehouses (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  warehouse_id uuid not null references public.warehouses(id) on delete cascade,
  role         text not null default 'viewer' check (role in ('viewer', 'operator', 'manager')),
  active       boolean not null default true,
  granted_by   uuid,
  granted_at   timestamptz not null default now(),
  revoked_by   uuid,
  revoked_at   timestamptz,
  unique (user_id, warehouse_id),
  constraint user_warehouses_revoked_ck check (active or revoked_at is not null)
);
create index user_warehouses_wh_idx on public.user_warehouses (warehouse_id, active);

-- ---------------------------------------------------------------------
-- 4. Fonctions d'accès
-- ---------------------------------------------------------------------
-- viewer : entrepôt affecté (ou warehouses.all / warehouses.manage) ; operator : écriture stock ; manager : responsable
create function private.wh_can(p_wh uuid, p_level text) returns boolean
language sql stable security definer set search_path = '' as $$
  -- La société est filtrée par les politiques de base (company_id = private.current_company()) : pas de test ici,
  -- sinon la ligne qui vient d'être insérée dans la même instruction ne serait pas visible.
  select p_wh is not null and (
          (p_level = 'viewer' and (private.has_perm('warehouses.all') or private.has_perm('warehouses.manage')
               or exists (select 1 from public.user_warehouses uw where uw.warehouse_id = p_wh and uw.user_id = auth.uid() and uw.active)))
       or (p_level = 'operator' and (private.has_perm('warehouses.manage')
               or exists (select 1 from public.user_warehouses uw where uw.warehouse_id = p_wh and uw.user_id = auth.uid() and uw.active and uw.role in ('operator', 'manager'))))
       or (p_level = 'manager' and (private.has_perm('warehouses.manage')
               or exists (select 1 from public.user_warehouses uw where uw.warehouse_id = p_wh and uw.user_id = auth.uid() and uw.active and uw.role = 'manager')))
     )
$$;
revoke execute on function private.wh_can(uuid, text) from public, anon;
grant execute on function private.wh_can(uuid, text) to authenticated, service_role;

-- Déclencheur générique : TG_ARGV[0] = colonne d'entrepôt, TG_ARGV[1] = niveau requis. Ignoré hors session utilisateur (traitements système).
create function private.wh_write_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_col text := TG_ARGV[0]; v_level text := coalesce(TG_ARGV[1], 'operator'); v_wh uuid;
begin
  if auth.uid() is null then return coalesce(new, old); end if;
  if tg_op in ('UPDATE', 'DELETE') then
    v_wh := nullif(to_jsonb(old) ->> v_col, '')::uuid;
    if v_wh is not null and not private.wh_can(v_wh, v_level) then raise exception 'WAREHOUSE_FORBIDDEN' using errcode = '42501'; end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    v_wh := nullif(to_jsonb(new) ->> v_col, '')::uuid;
    if v_wh is not null and not private.wh_can(v_wh, v_level) then raise exception 'WAREHOUSE_FORBIDDEN' using errcode = '42501'; end if;
  end if;
  return coalesce(new, old);
end $$;

-- Entrepôts : création = warehouses.manage ; modification / suppression = warehouses.manage ou responsable de l'entrepôt
create function private.warehouses_access_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then return coalesce(new, old); end if;
  if tg_op = 'INSERT' then
    if not private.has_perm('warehouses.manage') then raise exception 'WAREHOUSE_FORBIDDEN' using errcode = '42501'; end if;
  elsif tg_op = 'UPDATE' then
    if not private.wh_can(old.id, 'manager') then raise exception 'WAREHOUSE_FORBIDDEN' using errcode = '42501'; end if;
  else
    if not private.has_perm('warehouses.manage') then raise exception 'WAREHOUSE_FORBIDDEN' using errcode = '42501'; end if;
  end if;
  return coalesce(new, old);
end $$;
create trigger warehouses_access_guard_iud before insert or update or delete on public.warehouses
  for each row execute function private.warehouses_access_guard();

-- Le créateur d'un entrepôt en devient responsable (déclenché avant la création de l'emplacement général, ordre alphabétique)
create function private.warehouses_access_i() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null then
    insert into public.user_warehouses (company_id, user_id, warehouse_id, role, granted_by) values (new.company_id, auth.uid(), new.id, 'manager', auth.uid());
  end if;
  return new;
end $$;
create trigger warehouses_access_i after insert on public.warehouses
  for each row execute function private.warehouses_access_i();

-- Garde-fous sur les zones et emplacements
create function private.warehouse_locations_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare w public.warehouses%rowtype;
begin
  if tg_op = 'INSERT' then
    select * into w from public.warehouses where id = new.warehouse_id;
    if not found then raise exception 'WAREHOUSE_NOT_FOUND' using errcode = 'P0002'; end if;
    new.company_id := w.company_id; new.created_by := auth.uid(); new.updated_by := auth.uid();
    if w.archived_at is not null then raise exception 'WAREHOUSE_ARCHIVED' using errcode = '55000'; end if;
  else
    if new.warehouse_id is distinct from old.warehouse_id or new.company_id is distinct from old.company_id or new.code is distinct from old.code then
      raise exception 'WAREHOUSE_REF_LOCKED' using errcode = '42501';
    end if;
    new.updated_at := now(); new.updated_by := auth.uid();
  end if;
  new.code := upper(btrim(new.code)); new.name := btrim(new.name);
  return new;
end $$;
create trigger warehouse_locations_before_iu before insert or update on public.warehouse_locations
  for each row execute function private.warehouse_locations_before();

create function private.stock_locations_zone_check() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.zone_id is not null and not exists (select 1 from public.warehouse_locations z where z.id = new.zone_id and z.warehouse_id = new.warehouse_id) then
    raise exception 'WAREHOUSE_ZONE_MISMATCH' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger stock_locations_zone_check_iu before insert or update on public.stock_locations
  for each row execute function private.stock_locations_zone_check();

-- ---------------------------------------------------------------------
-- 5. Traçabilité (audit_logs, entity_type = 'warehouse', id = entrepôt)
-- ---------------------------------------------------------------------
create function private.audit_warehouse_locations() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_chg jsonb; v_wh_code text;
begin
  select code into v_wh_code from public.warehouses where id = new.warehouse_id;
  if tg_op = 'INSERT' then
    perform private.write_audit(new.company_id, 'warehouse.zone_add', 'warehouse', new.warehouse_id::text, v_wh_code, null,
      jsonb_build_object('zone', new.code, 'name', new.name, 'type', new.zone_type));
  else
    v_chg := private.jsonb_changes(to_jsonb(old), to_jsonb(new), (select array_agg(k) from jsonb_object_keys(to_jsonb(new)) k
      where k not in ('name', 'zone_type', 'notes', 'archived_at')));
    if v_chg -> 'after' <> '{}'::jsonb then
      perform private.write_audit(new.company_id, case when new.archived_at is not null and old.archived_at is null then 'warehouse.zone_archive' else 'warehouse.zone_update' end,
        'warehouse', new.warehouse_id::text, v_wh_code, v_chg -> 'before', v_chg -> 'after', jsonb_build_object('zone', new.code));
    end if;
  end if;
  return new;
end $$;
create trigger audit_warehouse_locations_iu after insert or update on public.warehouse_locations
  for each row execute function private.audit_warehouse_locations();

create function private.audit_stock_locations_wh() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_chg jsonb; v_wh_code text;
begin
  select code into v_wh_code from public.warehouses where id = new.warehouse_id;
  if tg_op = 'INSERT' then
    perform private.write_audit(new.company_id, 'warehouse.location_add', 'warehouse', new.warehouse_id::text, v_wh_code, null,
      jsonb_build_object('location', new.code, 'name', new.name, 'kind', new.kind, 'zone_id', new.zone_id));
  else
    v_chg := private.jsonb_changes(to_jsonb(old), to_jsonb(new), (select array_agg(k) from jsonb_object_keys(to_jsonb(new)) k
      where k not in ('name', 'kind', 'zone_id', 'archived_at')));
    if v_chg -> 'after' <> '{}'::jsonb then
      perform private.write_audit(new.company_id, 'warehouse.location_update', 'warehouse', new.warehouse_id::text, v_wh_code, v_chg -> 'before', v_chg -> 'after', jsonb_build_object('location', new.code));
    end if;
  end if;
  return new;
end $$;
create trigger audit_stock_locations_wh_iu after insert or update on public.stock_locations
  for each row execute function private.audit_stock_locations_wh();

-- ---------------------------------------------------------------------
-- 6. Garde d'écriture et lecture filtrée sur les tables portant un entrepôt.
--    Chaque table n'est traitée que si elle existe (les modules achats, variantes et sous-traitance
--    peuvent être absents d'une base de test partielle).
-- ---------------------------------------------------------------------
do $$
declare r record;
begin
  for r in select * from (values
      ('stock_lots', 'warehouse_id', 'operator'), ('stock_reservations', 'warehouse_id', 'operator'), ('stock_thresholds', 'warehouse_id', 'operator'),
      ('stock_inventories', 'warehouse_id', 'operator'), ('stock_movements', 'warehouse_id', 'operator'), ('stock_movements', 'to_warehouse_id', 'operator'),
      ('stock_locations', 'warehouse_id', 'manager'), ('warehouse_locations', 'warehouse_id', 'manager'),
      ('purchase_receipts', 'warehouse_id', 'operator'), ('variant_stock', 'warehouse_id', 'operator'),
      ('variant_stock_moves', 'warehouse_id', 'operator'), ('subcontract_receipts', 'warehouse_id', 'operator')) v(t, c, l)
  loop
    if to_regclass('public.' || r.t) is not null then
      execute format('create trigger %I before insert or update or delete on public.%I for each row execute function private.wh_write_guard(%L, %L)',
        r.t || '_wh_guard_' || r.c, r.t, r.c, r.l);
    end if;
  end loop;
end $$;

do $$
declare r record;
begin
  for r in select * from (values
      ('warehouses', 'private.wh_can(id, ''viewer'')'),
      ('warehouse_locations', 'private.wh_can(warehouse_id, ''viewer'')'),
      ('stock_locations', 'private.wh_can(warehouse_id, ''viewer'')'),
      ('stock_lots', 'private.wh_can(warehouse_id, ''viewer'')'),
      ('stock_reservations', 'private.wh_can(warehouse_id, ''viewer'')'),
      ('stock_thresholds', 'private.wh_can(warehouse_id, ''viewer'')'),
      ('stock_inventories', 'private.wh_can(warehouse_id, ''viewer'')'),
      ('stock_movements', 'private.wh_can(warehouse_id, ''viewer'') or (to_warehouse_id is not null and private.wh_can(to_warehouse_id, ''viewer''))'),
      ('purchase_receipts', 'private.wh_can(warehouse_id, ''viewer'')'),
      ('variant_stock', 'private.wh_can(warehouse_id, ''viewer'')'),
      ('variant_stock_moves', 'private.wh_can(warehouse_id, ''viewer'')'),
      ('subcontract_receipts', 'warehouse_id is null or private.wh_can(warehouse_id, ''viewer'')'),
      ('stock_inventory_lines', 'exists (select 1 from public.stock_inventories i where i.id = inventory_id and private.wh_can(i.warehouse_id, ''viewer''))'),
      ('stock_movement_allocations', 'exists (select 1 from public.stock_movements m where m.id = movement_id and (private.wh_can(m.warehouse_id, ''viewer'') or (m.to_warehouse_id is not null and private.wh_can(m.to_warehouse_id, ''viewer''))))'),
      ('stock_movement_costs', 'exists (select 1 from public.stock_movements m where m.id = movement_id and (private.wh_can(m.warehouse_id, ''viewer'') or (m.to_warehouse_id is not null and private.wh_can(m.to_warehouse_id, ''viewer''))))'),
      ('stock_lot_costs', 'exists (select 1 from public.stock_lots l where l.id = lot_id and private.wh_can(l.warehouse_id, ''viewer''))'),
      ('purchase_receipt_lines', 'exists (select 1 from public.purchase_receipts r where r.id = receipt_id and private.wh_can(r.warehouse_id, ''viewer''))')
    ) v(t, e)
  loop
    if to_regclass('public.' || r.t) is not null then
      execute format('create policy %I on public.%I as restrictive for select to authenticated using (%s)', r.t || '_wh_scope', r.t, r.e);
    end if;
  end loop;
end $$;

create policy user_warehouses_scope on public.user_warehouses as restrictive for select to authenticated
  using (user_id = auth.uid() or private.wh_can(warehouse_id, 'manager') or private.has_perm('warehouses.manage'));

-- Zones : écriture par responsable de l'entrepôt
alter table public.warehouse_locations enable row level security;
alter table public.user_warehouses enable row level security;
grant select, insert, update on public.warehouse_locations to authenticated;
grant select on public.user_warehouses to authenticated;
grant all on public.warehouse_locations, public.user_warehouses to service_role;
grant insert (warehouse_id, code, name, zone_type, notes) on public.warehouse_locations to authenticated;
grant update (name, zone_type, notes, archived_at) on public.warehouse_locations to authenticated;
grant insert (name, city, address, kind) on public.warehouses to authenticated;
grant update (name, city, address, kind) on public.warehouses to authenticated;
grant insert (warehouse_id, code, name, kind, zone_id) on public.stock_locations to authenticated;
grant update (name, kind, zone_id) on public.stock_locations to authenticated;

create policy warehouse_locations_select on public.warehouse_locations for select to authenticated
  using (company_id = private.current_company() and private.has_perm('stock.read'));
create policy warehouse_locations_insert on public.warehouse_locations for insert to authenticated
  with check (company_id = private.current_company() and private.wh_can(warehouse_id, 'manager'));
create policy warehouse_locations_update on public.warehouse_locations for update to authenticated
  using (company_id = private.current_company() and private.wh_can(warehouse_id, 'manager'))
  with check (company_id = private.current_company() and private.wh_can(warehouse_id, 'manager'));
create policy user_warehouses_select on public.user_warehouses for select to authenticated
  using (company_id = private.current_company());

-- ---------------------------------------------------------------------
-- 8. RPC : affectation et retrait des utilisateurs, accès de l'utilisateur courant
-- ---------------------------------------------------------------------
create function public.wh_assign_user(p_user uuid, p_warehouse uuid, p_role text) returns void
language plpgsql security definer set search_path = '' as $$
declare w public.warehouses%rowtype; v_co uuid := private.current_company(); v_target public.profiles%rowtype; v_email text;
begin
  if p_role not in ('viewer', 'operator', 'manager') then raise exception 'WAREHOUSE_BAD_ROLE' using errcode = '22023'; end if;
  if not private.wh_can(p_warehouse, 'manager') then raise exception 'WAREHOUSE_FORBIDDEN' using errcode = '42501'; end if;
  select * into w from public.warehouses where id = p_warehouse and company_id = v_co;
  if not found then raise exception 'WAREHOUSE_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into v_target from public.profiles where id = p_user and company_id = v_co;
  if not found then raise exception 'WAREHOUSE_USER_NOT_FOUND' using errcode = 'P0002'; end if;
  insert into public.user_warehouses (company_id, user_id, warehouse_id, role, active, granted_by, granted_at, revoked_by, revoked_at)
    values (v_co, p_user, p_warehouse, p_role, true, auth.uid(), now(), null, null)
  on conflict (user_id, warehouse_id) do update set role = excluded.role, active = true, granted_by = auth.uid(), granted_at = now(), revoked_by = null, revoked_at = null;
  perform private.write_audit(v_co, 'warehouse.access_grant', 'warehouse', w.id::text, w.code, null,
    jsonb_build_object('user', v_target.full_name, 'email', v_target.email, 'role', p_role), jsonb_build_object('warehouse', w.name), 'rpc');
end $$;

create function public.wh_revoke_user(p_user uuid, p_warehouse uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare w public.warehouses%rowtype; uw public.user_warehouses%rowtype; v_co uuid := private.current_company(); v_target public.profiles%rowtype;
begin
  if not private.wh_can(p_warehouse, 'manager') then raise exception 'WAREHOUSE_FORBIDDEN' using errcode = '42501'; end if;
  select * into w from public.warehouses where id = p_warehouse and company_id = v_co;
  if not found then raise exception 'WAREHOUSE_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into uw from public.user_warehouses where user_id = p_user and warehouse_id = p_warehouse and company_id = v_co and active for update;
  if not found then raise exception 'WAREHOUSE_ACCESS_NOT_FOUND' using errcode = 'P0002'; end if;
  if uw.role = 'manager' and not private.has_perm('warehouses.manage') and (select count(*) from public.user_warehouses x where x.warehouse_id = p_warehouse and x.active and x.role = 'manager') <= 1 then
    raise exception 'WAREHOUSE_LAST_MANAGER' using errcode = '55000';          -- un entrepôt garde au moins un responsable
  end if;
  update public.user_warehouses set active = false, revoked_by = auth.uid(), revoked_at = now() where id = uw.id;
  select * into v_target from public.profiles where id = p_user;
  perform private.write_audit(v_co, 'warehouse.access_revoke', 'warehouse', w.id::text, w.code, jsonb_build_object('user', v_target.full_name, 'role', uw.role), null,
    jsonb_build_object('email', v_target.email), 'rpc');
end $$;

create function public.wh_my_access() returns table (warehouse_id uuid, code text, name text, kind text, role text)
language sql stable security definer set search_path = '' as $$
  select w.id, w.code, w.name, w.kind,
         coalesce((select uw.role from public.user_warehouses uw where uw.warehouse_id = w.id and uw.user_id = auth.uid() and uw.active),
                  case when private.has_perm('warehouses.manage') then 'manager' else 'viewer' end)
  from public.warehouses w
  where w.company_id = private.current_company() and private.wh_can(w.id, 'viewer')
  order by w.name
$$;

do $$
declare f text;
begin
  foreach f in array array['wh_assign_user(uuid,uuid,text)', 'wh_revoke_user(uuid,uuid)', 'wh_my_access()'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 9. Reprise de l'existant : chaque utilisateur déjà habilité sur le stock reçoit les entrepôts de la société
--    (responsable pour le magasinier, opérateur pour qui écrit, lecteur pour qui lit)
-- ---------------------------------------------------------------------
insert into public.user_warehouses (company_id, user_id, warehouse_id, role, granted_at)
select distinct p.company_id, p.id, w.id,
  case when exists (select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id where ur.user_id = p.id and r.code = 'magasin') then 'manager'
       when exists (select 1 from public.user_roles ur join public.role_permissions rp on rp.role_id = ur.role_id join public.permissions pm on pm.id = rp.permission_id
                    where ur.user_id = p.id and pm.code = 'stock.write') then 'operator'
       else 'viewer' end,
  now()
from public.profiles p join public.warehouses w on w.company_id = p.company_id
where exists (select 1 from public.user_roles ur join public.role_permissions rp on rp.role_id = ur.role_id join public.permissions pm on pm.id = rp.permission_id
              where ur.user_id = p.id and pm.code in ('stock.read', 'stock.write'))
on conflict (user_id, warehouse_id) do nothing;
