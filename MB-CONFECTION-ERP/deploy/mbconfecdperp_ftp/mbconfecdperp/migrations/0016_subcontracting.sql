-- =====================================================================
-- 0016_subcontracting — Sous-traitance (broderie, sérigraphie, impression, lavage, finition…)
--  Workflow : Production → Envoi sous-traitant → Réception sous-traitant → Contrôle qualité → Stock.
--  Tables : subcontractors, subcontract_orders, subcontract_shipments (envois), subcontract_receipts (retours),
--           subcontract_costs (coûts : prestation, transport, autres).
--  Règles : les envois et réceptions ne se saisissent que par RPC (quantités cumulées contrôlées : reçu ≤ envoyé ≤ commandé) ;
--           le contrôle qualité ventile chaque retour en accepté / rejeté ; seul l'accepté entre en stock (variant_stock_move) ;
--           une commande ne se clôt qu'après contrôle et entrée en stock de tous les retours acceptés.
--  Coûts : réservés à subcontract.costs ou costs.read (jamais dans l'historique ni les listes).
--  Permissions nouvelles : subcontract.read / subcontract.write / subcontract.qc / subcontract.costs.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Permissions
-- ---------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('subcontract.read',  'suppliers', 'Voir la sous-traitance',                'Sous-traitants, envois, retours, performance, tableau de bord'),
  ('subcontract.write', 'suppliers', 'Gérer la sous-traitance',               'Sous-traitants, commandes, envois, réceptions'),
  ('subcontract.qc',    'suppliers', 'Contrôler les retours sous-traitant',   'Contrôle qualité des réceptions et entrée en stock'),
  ('subcontract.costs', 'suppliers', 'Voir et saisir les coûts de sous-traitance', 'Prix des prestations et frais de transport')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on r.is_system and (
     (r.code = 'admin'      and p.code like 'subcontract.%')
  or (r.code = 'production' and p.code in ('subcontract.read', 'subcontract.write', 'subcontract.qc'))
  or (r.code = 'qualite'    and p.code in ('subcontract.read', 'subcontract.qc'))
  or (r.code = 'achat'      and p.code in ('subcontract.read', 'subcontract.write', 'subcontract.costs'))
  or (r.code = 'finance'    and p.code in ('subcontract.read', 'subcontract.costs'))
  or (r.code = 'direction'  and p.code in ('subcontract.read', 'subcontract.costs'))
  or (r.code = 'magasin'    and p.code = 'subcontract.read'))
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------
create table public.subcontractors (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id),
  code             text not null,                                            -- SST-0001
  name             text not null check (length(btrim(name)) between 2 and 120),
  services         text[] not null check (cardinality(services) between 1 and 6
                     and services <@ array['embroidery','screen_printing','printing','washing','finishing','other']::text[]),
  country          char(2) check (country is null or country ~ '^[A-Z]{2}$'),
  city             text check (city is null or length(city) <= 80),
  contact_name     text check (contact_name is null or length(contact_name) <= 120),
  email            text check (email is null or email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone            text check (phone is null or length(phone) <= 40),
  default_lead_days int not null default 14 check (default_lead_days between 0 and 365),
  active           boolean not null default true,
  notes            text check (notes is null or length(notes) <= 2000),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid,
  unique (company_id, code)
);
create unique index subcontractors_name_uq on public.subcontractors (company_id, lower(btrim(name)));

create table public.subcontract_orders (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id),
  code             text not null,                                            -- SC-0001
  subcontractor_id uuid not null references public.subcontractors(id) on delete restrict,
  service          text not null check (service in ('embroidery','screen_printing','printing','washing','finishing','other')),
  product_id       uuid references public.product_master(id) on delete set null,
  description      text not null check (length(btrim(description)) between 2 and 300),
  qty              int not null check (qty > 0 and qty <= 1000000),
  qty_shipped      int not null default 0 check (qty_shipped >= 0),
  qty_received     int not null default 0 check (qty_received >= 0),
  qty_accepted     int not null default 0 check (qty_accepted >= 0),
  qty_rejected     int not null default 0 check (qty_rejected >= 0),
  status           text not null default 'draft' check (status in ('draft','sent','partially_received','received','closed','cancelled')),
  requested_on     date not null default current_date,
  sent_on          date,
  due_date         date,
  closed_at        timestamptz,
  cancel_reason    text check (cancel_reason is null or length(cancel_reason) <= 300),
  notes            text check (notes is null or length(notes) <= 2000),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid,
  updated_by       uuid,
  unique (company_id, code),
  constraint sc_orders_due_ck check (due_date is null or due_date >= requested_on),
  constraint sc_orders_shipped_ck check (qty_shipped <= qty),
  constraint sc_orders_received_ck check (qty_received <= qty_shipped),
  constraint sc_orders_qc_ck check (qty_accepted + qty_rejected <= qty_received)
);
create index sc_orders_idx on public.subcontract_orders (company_id, status, due_date);
create index sc_orders_sub_idx on public.subcontract_orders (subcontractor_id, status);

create table public.subcontract_shipments (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id),
  order_id    uuid not null references public.subcontract_orders(id) on delete cascade,
  number      int not null check (number >= 1),
  qty         int not null check (qty > 0),
  shipped_on  date not null,
  carrier     text check (carrier is null or length(carrier) <= 80),
  tracking    text check (tracking is null or length(tracking) <= 80),
  created_at  timestamptz not null default now(),
  created_by  uuid,
  unique (order_id, number)
);

create table public.subcontract_receipts (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id),
  order_id     uuid not null references public.subcontract_orders(id) on delete cascade,
  shipment_id  uuid references public.subcontract_shipments(id) on delete set null,
  number       int not null check (number >= 1),
  qty_received int not null check (qty_received > 0),
  received_on  date not null,
  qc_status    text not null default 'pending' check (qc_status in ('pending','accepted','partial','rejected')),
  qty_accepted int not null default 0 check (qty_accepted >= 0),
  qty_rejected int not null default 0 check (qty_rejected >= 0),
  qc_notes     text check (qc_notes is null or length(qc_notes) <= 500),
  qc_by        uuid,
  qc_at        timestamptz,
  variant_id   uuid references public.product_variants(id) on delete set null,
  warehouse_id uuid references public.warehouses(id) on delete set null,
  stock_posted boolean not null default false,
  stock_posted_at timestamptz,
  created_at   timestamptz not null default now(),
  created_by   uuid,
  unique (order_id, number),
  constraint sc_receipts_qc_ck check (
    (qc_status = 'pending' and qty_accepted = 0 and qty_rejected = 0 and qc_at is null)
    or (qc_status <> 'pending' and qty_accepted + qty_rejected = qty_received and qc_at is not null)),
  constraint sc_receipts_stock_ck check (not stock_posted or (qc_status <> 'pending' and variant_id is not null and warehouse_id is not null))
);
create index sc_receipts_order_idx on public.subcontract_receipts (order_id, received_on);

create table public.subcontract_costs (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id),
  order_id    uuid not null references public.subcontract_orders(id) on delete cascade,
  shipment_id uuid references public.subcontract_shipments(id) on delete cascade,
  kind        text not null default 'service' check (kind in ('service','shipping','other')),
  description text not null check (length(btrim(description)) between 1 and 200),
  quantity    numeric(12,3) not null default 1 check (quantity > 0 and quantity < 100000000),
  unit_cost   numeric(14,4) not null default 0 check (unit_cost >= 0 and unit_cost < 1000000000),
  amount      numeric(16,2) generated always as (round(quantity * unit_cost, 2)) stored,
  incurred_on date not null default current_date,
  created_at  timestamptz not null default now(),
  created_by  uuid
);
-- une seule prestation facturée par commande (les frais de transport et autres sont libres)
create unique index sc_costs_one_service_uq on public.subcontract_costs (order_id) where kind = 'service';
create index sc_costs_order_idx on public.subcontract_costs (order_id);

-- ---------------------------------------------------------------------
-- 3. Outils internes
-- ---------------------------------------------------------------------
create function private.sc_flag() returns boolean
language sql stable set search_path = '' as $$ select coalesce(current_setting('subcontract.rpc', true), 'off') = 'on' $$;
revoke execute on function private.sc_flag() from public, anon, authenticated;

create function private.sc_meta(p_company uuid, p_extra jsonb default '{}'::jsonb) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('company', (select name from public.companies where id = p_company)) || coalesce(p_extra, '{}'::jsonb)
$$;
revoke execute on function private.sc_meta(uuid, jsonb) from public, anon, authenticated;

-- Métriques par commande (fonction interne : les appelants contrôlent les droits ; les coûts ne sortent que si subcontract.costs)
create function private.sc_metrics(p_company uuid) returns table (
  order_id uuid, subcontractor_id uuid, service text, status text, product_id uuid, qty int, qty_received int, qty_accepted int, qty_rejected int,
  requested_on date, due_date date, sent_on date, closed_at timestamptz, last_received date, pending_qc int, unposted int,
  cost_service numeric, cost_shipping numeric, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select o.id, o.subcontractor_id, o.service, o.status, o.product_id, o.qty, o.qty_received, o.qty_accepted, o.qty_rejected,
    o.requested_on, o.due_date, o.sent_on, o.closed_at,
    (select max(r.received_on) from public.subcontract_receipts r where r.order_id = o.id),
    (select count(*)::int from public.subcontract_receipts r where r.order_id = o.id and r.qc_status = 'pending'),
    (select count(*)::int from public.subcontract_receipts r where r.order_id = o.id and r.qty_accepted > 0 and not r.stock_posted),
    coalesce((select sum(c.amount) from public.subcontract_costs c where c.order_id = o.id and c.kind = 'service'), 0)::numeric,
    coalesce((select sum(c.amount) from public.subcontract_costs c where c.order_id = o.id and c.kind <> 'service'), 0)::numeric,
    o.created_at
  from public.subcontract_orders o where o.company_id = p_company
$$;
revoke execute on function private.sc_metrics(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. Triggers de cohérence
-- ---------------------------------------------------------------------
create function private.subcontractors_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_co uuid;
begin
  if tg_op = 'INSERT' then
    v_co := private.current_company();
    if v_co is null then raise exception 'SC_NO_COMPANY' using errcode = '42501'; end if;
    new.company_id := v_co;
    new.code := 'SST-' || lpad(private.next_seq(v_co, 'subcontractor')::text, 4, '0');
    new.created_by := auth.uid();
  else
    if new.company_id is distinct from old.company_id or new.code is distinct from old.code then raise exception 'SC_REF_LOCKED' using errcode = '42501'; end if;
    if new.services is distinct from old.services and exists (
         select 1 from public.subcontract_orders o where o.subcontractor_id = new.id and o.status in ('draft','sent','partially_received','received')
           and not (o.service = any (new.services))) then
      raise exception 'SC_SERVICE_IN_USE' using errcode = '55000';         -- une prestation encore utilisée ne se retire pas
    end if;
    new.updated_at := now();
  end if;
  new.name := btrim(new.name);
  return new;
end $$;
create trigger subcontractors_before_iu before insert or update on public.subcontractors
  for each row execute function private.subcontractors_before();

create function private.subcontract_orders_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare s public.subcontractors%rowtype;
begin
  if tg_op = 'INSERT' then
    select * into s from public.subcontractors where id = new.subcontractor_id;
    if not found then raise exception 'SC_NOT_FOUND' using errcode = 'P0002'; end if;
    if not s.active then raise exception 'SC_SUBCONTRACTOR_INACTIVE' using errcode = '55000'; end if;
    if not (new.service = any (s.services)) then raise exception 'SC_SERVICE_NOT_OFFERED' using errcode = '22023'; end if;
    if new.product_id is not null and not exists (select 1 from public.product_master p where p.id = new.product_id and p.company_id = s.company_id) then
      raise exception 'SC_BAD_PRODUCT' using errcode = '22023';
    end if;
    if new.due_date is not null and new.due_date < new.requested_on then raise exception 'SC_DATE_ORDER' using errcode = '22023'; end if;
    new.company_id := s.company_id;
    new.code := 'SC-' || lpad(private.next_seq(s.company_id, 'subcontract')::text, 4, '0');
    new.status := 'draft'; new.qty_shipped := 0; new.qty_received := 0; new.qty_accepted := 0; new.qty_rejected := 0;
    new.sent_on := null; new.closed_at := null; new.cancel_reason := null;
    new.created_by := auth.uid(); new.updated_by := auth.uid();
  else
    if not private.sc_flag() then
      if new.company_id is distinct from old.company_id or new.code is distinct from old.code or new.status is distinct from old.status
         or new.sent_on is distinct from old.sent_on or new.closed_at is distinct from old.closed_at or new.cancel_reason is distinct from old.cancel_reason
         or new.qty_shipped is distinct from old.qty_shipped or new.qty_received is distinct from old.qty_received
         or new.qty_accepted is distinct from old.qty_accepted or new.qty_rejected is distinct from old.qty_rejected then
        raise exception 'SC_REF_LOCKED' using errcode = '42501';
      end if;
      if old.status in ('closed', 'cancelled') then raise exception 'SC_ORDER_CLOSED' using errcode = '55000'; end if;
      if old.status <> 'draft' and (new.subcontractor_id is distinct from old.subcontractor_id or new.service is distinct from old.service
           or new.product_id is distinct from old.product_id or new.qty is distinct from old.qty) then
        raise exception 'SC_ORDER_LOCKED' using errcode = '55000';          -- après envoi : seuls l'échéance et les notes bougent
      end if;
      if new.subcontractor_id is distinct from old.subcontractor_id then
        select * into s from public.subcontractors where id = new.subcontractor_id;
        if not found or not s.active or not (new.service = any (s.services)) then raise exception 'SC_SERVICE_NOT_OFFERED' using errcode = '22023'; end if;
      end if;
      if new.product_id is not null and new.product_id is distinct from old.product_id
         and not exists (select 1 from public.product_master p where p.id = new.product_id and p.company_id = old.company_id) then
        raise exception 'SC_BAD_PRODUCT' using errcode = '22023';
      end if;
      if new.due_date is not null and new.due_date < new.requested_on then raise exception 'SC_DATE_ORDER' using errcode = '22023'; end if;
      new.updated_at := now(); new.updated_by := auth.uid();
    else
      new.updated_at := now();
    end if;
  end if;
  new.description := btrim(new.description);
  return new;
end $$;
create trigger subcontract_orders_before_iu before insert or update on public.subcontract_orders
  for each row execute function private.subcontract_orders_before();

-- Envois et retours : uniquement via RPC (aucun droit d'écriture direct), la RPC pose le drapeau
create function private.subcontract_moves_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not private.sc_flag() then raise exception 'SC_RPC_ONLY' using errcode = '42501'; end if;
  return coalesce(new, old);
end $$;
create trigger subcontract_shipments_guard before insert or update or delete on public.subcontract_shipments
  for each row execute function private.subcontract_moves_guard();
create trigger subcontract_receipts_guard before insert or update or delete on public.subcontract_receipts
  for each row execute function private.subcontract_moves_guard();

create function private.subcontract_costs_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare o public.subcontract_orders%rowtype;
begin
  if tg_op = 'DELETE' then
    select * into o from public.subcontract_orders where id = old.order_id;
    if o.status in ('closed', 'cancelled') then raise exception 'SC_ORDER_CLOSED' using errcode = '55000'; end if;
    return old;
  end if;
  select * into o from public.subcontract_orders where id = new.order_id;
  if not found then raise exception 'SC_NOT_FOUND' using errcode = 'P0002'; end if;
  if o.status in ('closed', 'cancelled') then raise exception 'SC_ORDER_CLOSED' using errcode = '55000'; end if;
  if new.shipment_id is not null and not exists (select 1 from public.subcontract_shipments s where s.id = new.shipment_id and s.order_id = new.order_id) then
    raise exception 'SC_BAD_SHIPMENT' using errcode = '22023';
  end if;
  new.company_id := o.company_id;
  if tg_op = 'INSERT' then new.created_by := auth.uid(); end if;
  return new;
end $$;
create trigger subcontract_costs_before_iud before insert or update or delete on public.subcontract_costs
  for each row execute function private.subcontract_costs_before();

-- ---------------------------------------------------------------------
-- 5. Historique (audit_logs : 'subcontractor' et 'subcontract' ; aucun montant dans l'historique)
-- ---------------------------------------------------------------------
create function private.audit_subcontractors() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_chg jsonb;
begin
  if tg_op = 'INSERT' then
    perform private.write_audit(new.company_id, 'subcontractor.create', 'subcontractor', new.id::text, new.code, null,
      jsonb_build_object('code', new.code, 'name', new.name, 'services', new.services), private.sc_meta(new.company_id));
  else
    v_chg := private.jsonb_changes(to_jsonb(old), to_jsonb(new), (select array_agg(k) from jsonb_object_keys(to_jsonb(new)) k
      where k not in ('name','services','country','city','contact_name','email','phone','default_lead_days','active','notes')));
    if v_chg -> 'after' <> '{}'::jsonb then
      perform private.write_audit(new.company_id, case when v_chg -> 'after' ? 'active' then 'subcontractor.status' else 'subcontractor.update' end,
        'subcontractor', new.id::text, new.code, v_chg -> 'before', v_chg -> 'after', private.sc_meta(new.company_id));
    end if;
  end if;
  return new;
end $$;
create trigger audit_subcontractors_iu after insert or update on public.subcontractors
  for each row execute function private.audit_subcontractors();

create function private.audit_subcontract_orders() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_chg jsonb;
begin
  if private.sc_flag() then return new; end if;                  -- les RPC tracent elles-mêmes
  if tg_op = 'INSERT' then
    perform private.write_audit(new.company_id, 'subcontract.create', 'subcontract', new.id::text, new.code, null,
      jsonb_build_object('service', new.service, 'qty', new.qty, 'due_date', new.due_date), private.sc_meta(new.company_id));
  else
    v_chg := private.jsonb_changes(to_jsonb(old), to_jsonb(new), (select array_agg(k) from jsonb_object_keys(to_jsonb(new)) k
      where k not in ('subcontractor_id','service','product_id','qty','description','requested_on','due_date','notes')));
    if v_chg -> 'after' <> '{}'::jsonb then
      perform private.write_audit(new.company_id, 'subcontract.update', 'subcontract', new.id::text, new.code, v_chg -> 'before', v_chg -> 'after', private.sc_meta(new.company_id));
    end if;
  end if;
  return new;
end $$;
create trigger audit_subcontract_orders_iu after insert or update on public.subcontract_orders
  for each row execute function private.audit_subcontract_orders();

create function private.audit_subcontract_costs() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r public.subcontract_costs%rowtype; v_code text;
begin
  r := case when tg_op = 'DELETE' then old else new end;
  select code into v_code from public.subcontract_orders where id = r.order_id;
  perform private.write_audit(r.company_id, case tg_op when 'INSERT' then 'subcontract.cost_add' when 'UPDATE' then 'subcontract.cost_update' else 'subcontract.cost_delete' end,
    'subcontract', r.order_id::text, v_code, null, null, private.sc_meta(r.company_id, jsonb_build_object('kind', r.kind, 'description', r.description)));   -- sans montant
  return coalesce(new, old);
end $$;
create trigger audit_subcontract_costs_iud after insert or update or delete on public.subcontract_costs
  for each row execute function private.audit_subcontract_costs();

create policy audit_logs_select_subcontract on public.audit_logs for select to authenticated
  using (entity_type in ('subcontractor', 'subcontract') and company_id = private.current_company() and private.has_perm('subcontract.read'));

-- ---------------------------------------------------------------------
-- 6. RLS + privilèges de colonnes
-- ---------------------------------------------------------------------
alter table public.subcontractors         enable row level security;
alter table public.subcontract_orders     enable row level security;
alter table public.subcontract_shipments  enable row level security;
alter table public.subcontract_receipts   enable row level security;
alter table public.subcontract_costs      enable row level security;

revoke all on public.subcontractors, public.subcontract_orders, public.subcontract_shipments, public.subcontract_receipts, public.subcontract_costs from anon, authenticated;
grant all on public.subcontractors, public.subcontract_orders, public.subcontract_shipments, public.subcontract_receipts, public.subcontract_costs to service_role;
grant select on public.subcontractors, public.subcontract_orders, public.subcontract_shipments, public.subcontract_receipts, public.subcontract_costs to authenticated;
grant insert (name, services, country, city, contact_name, email, phone, default_lead_days, active, notes) on public.subcontractors to authenticated;
grant update (name, services, country, city, contact_name, email, phone, default_lead_days, active, notes) on public.subcontractors to authenticated;
grant insert (subcontractor_id, service, product_id, description, qty, requested_on, due_date, notes) on public.subcontract_orders to authenticated;
grant update (subcontractor_id, service, product_id, description, qty, requested_on, due_date, notes) on public.subcontract_orders to authenticated;
grant insert (order_id, shipment_id, kind, description, quantity, unit_cost, incurred_on) on public.subcontract_costs to authenticated;
grant update (shipment_id, kind, description, quantity, unit_cost, incurred_on) on public.subcontract_costs to authenticated;
grant delete on public.subcontract_costs to authenticated;

create policy subcontractors_select on public.subcontractors for select to authenticated
  using (company_id = private.current_company() and private.has_perm('subcontract.read'));
create policy subcontractors_insert on public.subcontractors for insert to authenticated
  with check (company_id = private.current_company() and private.has_perm('subcontract.write'));
create policy subcontractors_update on public.subcontractors for update to authenticated
  using (company_id = private.current_company() and private.has_perm('subcontract.write'))
  with check (company_id = private.current_company() and private.has_perm('subcontract.write'));

create policy sc_orders_select on public.subcontract_orders for select to authenticated
  using (company_id = private.current_company() and private.has_perm('subcontract.read'));
create policy sc_orders_insert on public.subcontract_orders for insert to authenticated
  with check (company_id = private.current_company() and private.has_perm('subcontract.write'));
create policy sc_orders_update on public.subcontract_orders for update to authenticated
  using (company_id = private.current_company() and private.has_perm('subcontract.write'))
  with check (company_id = private.current_company() and private.has_perm('subcontract.write'));

create policy sc_shipments_select on public.subcontract_shipments for select to authenticated
  using (company_id = private.current_company() and private.has_perm('subcontract.read'));
create policy sc_receipts_select on public.subcontract_receipts for select to authenticated
  using (company_id = private.current_company() and private.has_perm('subcontract.read'));

create policy sc_costs_select on public.subcontract_costs for select to authenticated
  using (company_id = private.current_company() and (private.has_perm('subcontract.costs') or private.has_perm('costs.read')));
create policy sc_costs_insert on public.subcontract_costs for insert to authenticated
  with check (company_id = private.current_company() and private.has_perm('subcontract.costs'));
create policy sc_costs_update on public.subcontract_costs for update to authenticated
  using (company_id = private.current_company() and private.has_perm('subcontract.costs'))
  with check (company_id = private.current_company() and private.has_perm('subcontract.costs'));
create policy sc_costs_delete on public.subcontract_costs for delete to authenticated
  using (company_id = private.current_company() and private.has_perm('subcontract.costs'));

-- ---------------------------------------------------------------------
-- 7. RPC : cycle de vie d'une commande, envois, réceptions, contrôle qualité, stock, clôture
-- ---------------------------------------------------------------------
create function private.sc_order_for_update(p_order uuid) returns public.subcontract_orders
language plpgsql security definer set search_path = '' as $$
declare o public.subcontract_orders%rowtype;
begin
  select * into o from public.subcontract_orders where id = p_order and company_id = private.current_company() for update;
  if not found then raise exception 'SC_NOT_FOUND' using errcode = 'P0002'; end if;
  return o;
end $$;
revoke execute on function private.sc_order_for_update(uuid) from public, anon, authenticated;

create function public.sc_order_send(p_order uuid, p_due date default null) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.subcontract_orders%rowtype; v_prev text := coalesce(current_setting('subcontract.rpc', true), 'off');
begin
  perform private.require_perm('subcontract.write');
  o := private.sc_order_for_update(p_order);
  if o.status <> 'draft' then raise exception 'SC_BAD_STATUS' using errcode = '55000'; end if;
  if coalesce(p_due, o.due_date) is null then raise exception 'SC_DUE_REQUIRED' using errcode = '22023'; end if;
  perform set_config('subcontract.rpc', 'on', true);
  update public.subcontract_orders set status = 'sent', sent_on = current_date, due_date = coalesce(p_due, due_date), updated_by = auth.uid(), updated_at = now() where id = o.id;
  perform set_config('subcontract.rpc', v_prev, true);
  perform private.write_audit(o.company_id, 'subcontract.send', 'subcontract', o.id::text, o.code, jsonb_build_object('status', 'draft'), jsonb_build_object('status', 'sent'),
    private.sc_meta(o.company_id, jsonb_build_object('due_date', coalesce(p_due, o.due_date))), 'rpc');
end $$;

create function public.sc_order_cancel(p_order uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.subcontract_orders%rowtype; v_prev text := coalesce(current_setting('subcontract.rpc', true), 'off'); v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  perform private.require_perm('subcontract.write');
  o := private.sc_order_for_update(p_order);
  if o.status not in ('draft', 'sent') or o.qty_shipped > 0 then raise exception 'SC_BAD_STATUS' using errcode = '55000'; end if;
  if v_reason is null or length(v_reason) < 3 then raise exception 'SC_REASON_REQUIRED' using errcode = '22023'; end if;
  perform set_config('subcontract.rpc', 'on', true);
  update public.subcontract_orders set status = 'cancelled', cancel_reason = v_reason, updated_by = auth.uid(), updated_at = now() where id = o.id;
  perform set_config('subcontract.rpc', v_prev, true);
  perform private.write_audit(o.company_id, 'subcontract.cancel', 'subcontract', o.id::text, o.code, jsonb_build_object('status', o.status), jsonb_build_object('status', 'cancelled'),
    private.sc_meta(o.company_id, jsonb_build_object('reason', v_reason)), 'rpc');
end $$;

create function public.sc_shipment_add(p_order uuid, p_qty int, p_shipped_on date, p_carrier text default null, p_tracking text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare o public.subcontract_orders%rowtype; v_id uuid := gen_random_uuid(); v_no int; v_prev text := coalesce(current_setting('subcontract.rpc', true), 'off');
begin
  perform private.require_perm('subcontract.write');
  o := private.sc_order_for_update(p_order);
  if o.status not in ('sent', 'partially_received') then raise exception 'SC_BAD_STATUS' using errcode = '55000'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'SC_BAD_QTY' using errcode = '22023'; end if;
  if o.qty_shipped + p_qty > o.qty then raise exception 'SC_OVER_QTY' using errcode = '22023'; end if;
  select coalesce(max(number), 0) + 1 into v_no from public.subcontract_shipments where order_id = o.id;
  perform set_config('subcontract.rpc', 'on', true);
  insert into public.subcontract_shipments (id, company_id, order_id, number, qty, shipped_on, carrier, tracking, created_by)
    values (v_id, o.company_id, o.id, v_no, p_qty, coalesce(p_shipped_on, current_date), nullif(btrim(coalesce(p_carrier, '')), ''), nullif(btrim(coalesce(p_tracking, '')), ''), auth.uid());
  update public.subcontract_orders set qty_shipped = qty_shipped + p_qty, updated_by = auth.uid(), updated_at = now() where id = o.id;
  perform set_config('subcontract.rpc', v_prev, true);
  perform private.write_audit(o.company_id, 'subcontract.shipment', 'subcontract', o.id::text, o.code, null, jsonb_build_object('qty', p_qty, 'number', v_no),
    private.sc_meta(o.company_id, jsonb_build_object('shipment', v_no, 'tracking', nullif(btrim(coalesce(p_tracking, '')), ''))), 'rpc');
  return v_id;
end $$;

create function public.sc_receipt_add(p_order uuid, p_qty int, p_received_on date, p_shipment uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare o public.subcontract_orders%rowtype; v_id uuid := gen_random_uuid(); v_no int; v_new_status text; v_prev text := coalesce(current_setting('subcontract.rpc', true), 'off');
begin
  perform private.require_perm('subcontract.write');
  o := private.sc_order_for_update(p_order);
  if o.status not in ('sent', 'partially_received') then raise exception 'SC_BAD_STATUS' using errcode = '55000'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'SC_BAD_QTY' using errcode = '22023'; end if;
  if p_shipment is not null and not exists (select 1 from public.subcontract_shipments s where s.id = p_shipment and s.order_id = o.id) then
    raise exception 'SC_BAD_SHIPMENT' using errcode = '22023';
  end if;
  if o.qty_received + p_qty > o.qty_shipped then raise exception 'SC_RECEIPT_EXCEEDS_SHIPMENT' using errcode = '22023'; end if;
  select coalesce(max(number), 0) + 1 into v_no from public.subcontract_receipts where order_id = o.id;
  v_new_status := case when o.qty_received + p_qty >= o.qty then 'received' else 'partially_received' end;
  perform set_config('subcontract.rpc', 'on', true);
  insert into public.subcontract_receipts (id, company_id, order_id, shipment_id, number, qty_received, received_on, created_by)
    values (v_id, o.company_id, o.id, p_shipment, v_no, p_qty, coalesce(p_received_on, current_date), auth.uid());
  update public.subcontract_orders set qty_received = qty_received + p_qty, status = v_new_status, updated_by = auth.uid(), updated_at = now() where id = o.id;
  perform set_config('subcontract.rpc', v_prev, true);
  perform private.write_audit(o.company_id, 'subcontract.receipt', 'subcontract', o.id::text, o.code, jsonb_build_object('status', o.status), jsonb_build_object('status', v_new_status),
    private.sc_meta(o.company_id, jsonb_build_object('receipt', v_no, 'qty', p_qty)), 'rpc');
  return v_id;
end $$;

create function public.sc_receipt_qc(p_receipt uuid, p_accepted int, p_rejected int, p_notes text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.subcontract_receipts%rowtype; o public.subcontract_orders%rowtype; v_status text; v_prev text := coalesce(current_setting('subcontract.rpc', true), 'off');
begin
  perform private.require_perm('subcontract.qc');
  select * into r from public.subcontract_receipts where id = p_receipt and company_id = private.current_company() for update;
  if not found then raise exception 'SC_NOT_FOUND' using errcode = 'P0002'; end if;
  o := private.sc_order_for_update(r.order_id);
  if r.qc_status <> 'pending' then raise exception 'SC_BAD_STATUS' using errcode = '55000'; end if;
  if p_accepted is null or p_rejected is null or p_accepted < 0 or p_rejected < 0 then raise exception 'SC_BAD_QTY' using errcode = '22023'; end if;
  if p_accepted + p_rejected <> r.qty_received then raise exception 'SC_QC_SUM' using errcode = '22023'; end if;
  v_status := case when p_rejected = 0 then 'accepted' when p_accepted = 0 then 'rejected' else 'partial' end;
  perform set_config('subcontract.rpc', 'on', true);
  update public.subcontract_receipts set qc_status = v_status, qty_accepted = p_accepted, qty_rejected = p_rejected,
    qc_notes = nullif(btrim(coalesce(p_notes, '')), ''), qc_by = auth.uid(), qc_at = now() where id = r.id;
  update public.subcontract_orders set qty_accepted = qty_accepted + p_accepted, qty_rejected = qty_rejected + p_rejected, updated_by = auth.uid(), updated_at = now() where id = o.id;
  perform set_config('subcontract.rpc', v_prev, true);
  perform private.write_audit(o.company_id, 'subcontract.qc', 'subcontract', o.id::text, o.code, null, jsonb_build_object('accepted', p_accepted, 'rejected', p_rejected),
    private.sc_meta(o.company_id, jsonb_build_object('receipt', r.number, 'result', v_status, 'notes', nullif(btrim(coalesce(p_notes, '')), ''))), 'rpc');
end $$;

-- Entrée en stock de la part acceptée d'un retour (stock fini par variante, via le module Variantes)
create function public.sc_receipt_stock(p_receipt uuid, p_variant uuid, p_warehouse uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.subcontract_receipts%rowtype; o public.subcontract_orders%rowtype; v_prev text := coalesce(current_setting('subcontract.rpc', true), 'off');
begin
  perform private.require_perm('subcontract.qc');
  select * into r from public.subcontract_receipts where id = p_receipt and company_id = private.current_company() for update;
  if not found then raise exception 'SC_NOT_FOUND' using errcode = 'P0002'; end if;
  o := private.sc_order_for_update(r.order_id);
  if r.qc_status = 'pending' or r.qty_accepted = 0 or r.stock_posted then raise exception 'SC_BAD_STATUS' using errcode = '55000'; end if;
  if not exists (select 1 from public.product_variants v where v.id = p_variant and v.product_id = o.product_id) then
    raise exception 'SC_BAD_VARIANT' using errcode = '22023';
  end if;
  perform public.variant_stock_move(p_variant, 'receipt', p_warehouse, r.qty_accepted, null, 'Retour sous-traitance ' || o.code, o.code || ' R' || r.number);
  perform set_config('subcontract.rpc', 'on', true);
  update public.subcontract_receipts set stock_posted = true, stock_posted_at = now(), variant_id = p_variant, warehouse_id = p_warehouse where id = r.id;
  perform set_config('subcontract.rpc', v_prev, true);
  perform private.write_audit(o.company_id, 'subcontract.stock', 'subcontract', o.id::text, o.code, null, jsonb_build_object('qty', r.qty_accepted),
    private.sc_meta(o.company_id, jsonb_build_object('receipt', r.number, 'variant', p_variant)), 'rpc');
end $$;

create function public.sc_order_close(p_order uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.subcontract_orders%rowtype; v_prev text := coalesce(current_setting('subcontract.rpc', true), 'off');
begin
  perform private.require_perm('subcontract.write');
  o := private.sc_order_for_update(p_order);
  if o.status <> 'received' then raise exception 'SC_BAD_STATUS' using errcode = '55000'; end if;
  if exists (select 1 from public.subcontract_receipts r where r.order_id = o.id and r.qc_status = 'pending') then raise exception 'SC_QC_PENDING' using errcode = '55000'; end if;
  if exists (select 1 from public.subcontract_receipts r where r.order_id = o.id and r.qty_accepted > 0 and not r.stock_posted) then raise exception 'SC_STOCK_PENDING' using errcode = '55000'; end if;
  perform set_config('subcontract.rpc', 'on', true);
  update public.subcontract_orders set status = 'closed', closed_at = now(), updated_by = auth.uid(), updated_at = now() where id = o.id;
  perform set_config('subcontract.rpc', v_prev, true);
  perform private.write_audit(o.company_id, 'subcontract.close', 'subcontract', o.id::text, o.code, jsonb_build_object('status', 'received'), jsonb_build_object('status', 'closed'),
    private.sc_meta(o.company_id), 'rpc');
end $$;

-- ---------------------------------------------------------------------
-- 8. Tableau de bord et performance des sous-traitants
-- ---------------------------------------------------------------------
create function public.subcontract_dashboard() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_costs boolean := private.has_perm('subcontract.costs') or private.has_perm('costs.read'); v jsonb; v_kpi jsonb;
begin
  perform private.require_perm('subcontract.read');
  select jsonb_build_object(
    'orders', count(*) filter (where status <> 'cancelled'),
    'open', count(*) filter (where status in ('sent', 'partially_received', 'received')),
    'overdue', count(*) filter (where status in ('sent', 'partially_received') and due_date < current_date),
    'pending_qc', coalesce(sum(pending_qc), 0),
    'unposted', coalesce(sum(unposted), 0),
    'qty_in_progress', coalesce(sum(qty - qty_received) filter (where status in ('sent', 'partially_received')), 0),
    'on_time_rate', round(100.0 * count(*) filter (where status in ('received', 'closed') and last_received <= due_date)
                    / nullif(count(*) filter (where status in ('received', 'closed') and last_received is not null), 0), 1),
    'avg_lead_days', round(avg(coalesce(closed_at::date, last_received) - sent_on) filter (where sent_on is not null and last_received is not null and status in ('received', 'closed')), 1),
    'rejection_rate', round(100.0 * sum(qty_rejected) / nullif(sum(qty_accepted + qty_rejected), 0), 1),
    'qty_received', coalesce(sum(qty_received), 0),
    'qty_accepted', coalesce(sum(qty_accepted), 0),
    'cost_total', coalesce(sum(cost_service + cost_shipping), 0),
    'cost_per_piece', round((sum(cost_service + cost_shipping)) / nullif(sum(qty_accepted), 0), 3)
  ) into v_kpi from private.sc_metrics(v_co);
  if not v_costs then v_kpi := v_kpi - 'cost_total' - 'cost_per_piece'; end if;
  v := jsonb_build_object(
    'kpi', v_kpi,
    'by_status', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (select status, count(*) n from public.subcontract_orders where company_id = v_co group by status) x),
    'by_service', (select coalesce(jsonb_agg(jsonb_build_object('service', x.svc, 'orders', x.orders, 'received', x.received) order by x.svc), '[]'::jsonb) from (
                    select sv.svc,
                      (select count(*) from public.subcontract_orders o where o.company_id = v_co and o.service = sv.svc and o.status <> 'cancelled') as orders,
                      (select coalesce(sum(o.qty_received), 0) from public.subcontract_orders o where o.company_id = v_co and o.service = sv.svc) as received
                    from unnest(array['embroidery','screen_printing','printing','washing','finishing','other']::text[]) as sv(svc)) x),
    'overdue', (select coalesce(jsonb_agg(x order by x ->> 'due_date'), '[]'::jsonb) from (
                  select jsonb_build_object('id', o.id, 'code', o.code, 'subcontractor', s.name, 'service', o.service, 'due_date', o.due_date,
                    'days', (current_date - o.due_date), 'qty', o.qty, 'received', o.qty_received) x
                  from public.subcontract_orders o join public.subcontractors s on s.id = o.subcontractor_id
                  where o.company_id = v_co and o.status in ('sent', 'partially_received') and o.due_date < current_date limit 10) y),
    'pending_qc', (select coalesce(jsonb_agg(x order by x ->> 'received_on'), '[]'::jsonb) from (
                  select jsonb_build_object('id', r.id, 'order_id', o.id, 'code', o.code, 'receipt', r.number, 'qty', r.qty_received, 'received_on', r.received_on) x
                  from public.subcontract_receipts r join public.subcontract_orders o on o.id = r.order_id
                  where r.company_id = v_co and r.qc_status = 'pending' limit 10) y),
    'by_month', (select coalesce(jsonb_agg(jsonb_build_object('month', to_char(m, 'YYYY-MM'), 'orders', (select count(*) from public.subcontract_orders o where o.company_id = v_co and date_trunc('month', o.created_at) = m and o.status <> 'cancelled')) order by m), '[]'::jsonb)
                 from generate_series(date_trunc('month', current_date) - interval '5 months', date_trunc('month', current_date), interval '1 month') m)
  );
  if v_costs then
    v := v || jsonb_build_object(
      'costs_by_month', (select coalesce(jsonb_agg(jsonb_build_object('month', to_char(m, 'YYYY-MM'), 'amount', (select coalesce(sum(c.amount), 0) from public.subcontract_costs c where c.company_id = v_co and date_trunc('month', c.incurred_on::timestamp) = m)) order by m), '[]'::jsonb)
                         from generate_series(date_trunc('month', current_date) - interval '5 months', date_trunc('month', current_date), interval '1 month') m),
      'top_subcontractors', (select coalesce(jsonb_agg(x order by (x ->> 'amount')::numeric desc), '[]'::jsonb) from (
                  select jsonb_build_object('name', s.name, 'amount', sum(m.cost_service + m.cost_shipping)) x
                  from private.sc_metrics(v_co) m join public.subcontractors s on s.id = m.subcontractor_id
                  group by s.name order by sum(m.cost_service + m.cost_shipping) desc limit 5) y));
  end if;
  return v;
end $$;

create function public.subcontractor_performance() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_costs boolean := private.has_perm('subcontract.costs') or private.has_perm('costs.read'); v jsonb;
begin
  perform private.require_perm('subcontract.read');
  select coalesce(jsonb_agg(row_to_json(x)::jsonb order by x.name), '[]'::jsonb) into v from (
    select s.id, s.code, s.name, s.services, s.default_lead_days, s.active,
      count(m.order_id) filter (where m.status not in ('draft', 'cancelled')) as orders,
      coalesce(sum(m.qty_received), 0) as qty_received,
      count(*) filter (where m.status in ('received', 'closed') and m.last_received is not null and m.last_received <= m.due_date) as on_time,
      count(*) filter (where m.status in ('received', 'closed') and m.last_received is not null) as delivered,
      round(avg(coalesce(m.closed_at::date, m.last_received) - m.sent_on) filter (where m.sent_on is not null and m.last_received is not null and m.status in ('received', 'closed')), 1) as avg_lead_days,
      round(avg(greatest(m.last_received - m.due_date, 0)) filter (where m.due_date is not null and m.last_received is not null and m.status in ('received', 'closed')), 1) as avg_delay_days,
      round(100.0 * coalesce(sum(m.qty_rejected), 0) / nullif(coalesce(sum(m.qty_accepted + m.qty_rejected), 0), 0), 1) as rejection_rate,
      case when v_costs then round(coalesce(sum(m.cost_service + m.cost_shipping), 0), 2) end as cost_total,
      case when v_costs then round(sum(m.cost_service + m.cost_shipping) / nullif(sum(m.qty_accepted), 0), 3) end as cost_per_piece
    from public.subcontractors s
    left join private.sc_metrics(v_co) m on m.subcontractor_id = s.id
    where s.company_id = v_co
    group by s.id, s.code, s.name, s.services, s.default_lead_days, s.active
  ) x;
  return v;
end $$;

-- ---------------------------------------------------------------------
-- 9. Droits d'exécution
-- ---------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array['sc_order_send(uuid,date)', 'sc_order_cancel(uuid,text)', 'sc_shipment_add(uuid,int,date,text,text)', 'sc_receipt_add(uuid,int,date,uuid)',
                           'sc_receipt_qc(uuid,int,int,text)', 'sc_receipt_stock(uuid,uuid,uuid)', 'sc_order_close(uuid)', 'subcontract_dashboard()', 'subcontractor_performance()'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
