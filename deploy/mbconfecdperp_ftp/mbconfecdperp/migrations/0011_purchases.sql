-- =====================================================================
-- 0011_purchases — Module Achats
--  Workflow : Demande d'achat (DA) → validation → Bon de commande fournisseur (BC) → Réception → (Retour fournisseur)
--  Réception et retour alimentent le stock automatiquement (lots FIFO au prix de la commande).
--  Statistiques d'achat. Les commandes d'achat réutilisent `purchase_orders` (module Fournisseurs) : mêmes statuts
--  (draft / sent / partial / received / cancelled), donc l'historique et les statistiques fournisseur restent valables.
--  Permissions : purchases.read / purchases.write / purchases.approve (existantes)
--                purchases.request (demander), purchases.receive (réceptionner, retourner) — nouvelles.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Permissions
-- ---------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('purchases.request', 'purchases', 'Créer des demandes d''achat', 'Saisir et soumettre ses demandes d''achat'),
  ('purchases.receive', 'purchases', 'Réceptionner et retourner', 'Réceptions de commandes fournisseur (entrée en stock) et retours fournisseur')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on r.is_system and (
     (r.code = 'admin'      and p.code in ('purchases.request', 'purchases.receive'))
  or (r.code = 'achat'      and p.code in ('purchases.request', 'purchases.receive'))
  or (r.code = 'production' and p.code = 'purchases.request')
  or (r.code = 'magasin'    and p.code in ('purchases.request', 'purchases.receive')))
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 2. Entrée de stock « de confiance » : le coût du lot reçu est le prix de la commande, quel que soit le droit de l'utilisateur
--    (même fonction que 0009, une seule ligne modifiée : GUC stock.trusted_cost)
-- ---------------------------------------------------------------------
create or replace function private.stock_apply(p_type text, p_dir text, p_material uuid, p_qty numeric, p_wh uuid, p_loc uuid, p_to_loc uuid,
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
    v_cost := case when p_cost is not null and (private.has_perm('costs.read') or coalesce(current_setting('stock.trusted_cost', true), 'off') = 'on') then p_cost end;
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

-- ---------------------------------------------------------------------
-- 3. Demandes d'achat
-- ---------------------------------------------------------------------
create table public.purchase_requests (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id),
  code             text not null,                                           -- DA-0001
  status           text not null default 'draft' check (status in ('draft','submitted','approved','rejected','ordered','cancelled')),
  needed_date      date,
  reason           text check (reason is null or length(reason) <= 500),
  source           text not null default 'manual' check (source in ('manual','mrp')),
  mrp_run_id       uuid references public.mrp_runs(id) on delete set null,
  requested_by     uuid,
  submitted_at     timestamptz,
  decided_by       uuid,
  decided_at       timestamptz,
  decision_comment text check (decision_comment is null or length(decision_comment) <= 500),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (company_id, code)
);
create index purchase_requests_idx on public.purchase_requests (company_id, status, created_at desc);

create table public.purchase_request_lines (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id),
  request_id   uuid not null references public.purchase_requests(id) on delete cascade,
  material_id  uuid not null references public.bom_materials(id),
  qty          numeric(14,4) not null check (qty > 0 and qty <= 100000000),
  supplier_id  uuid references public.suppliers(id) on delete set null,     -- fournisseur souhaité (sinon celui du composant)
  needed_date  date,
  note         text check (note is null or length(note) <= 300),
  po_line_id   uuid,                                                        -- renseigné à la transformation en commande
  created_at   timestamptz not null default now()
);
create index purchase_request_lines_idx on public.purchase_request_lines (request_id);

alter table public.mrp_run_suggestions add column request_id uuid references public.purchase_requests(id) on delete set null;

-- ---------------------------------------------------------------------
-- 4. Commandes fournisseur : colonnes supplémentaires + lignes
-- ---------------------------------------------------------------------
alter table public.purchase_orders
  add column request_id uuid references public.purchase_requests(id) on delete set null,
  add column sent_at timestamptz,
  add column sent_by uuid;

create table public.purchase_order_lines (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id),
  po_id         uuid not null references public.purchase_orders(id) on delete cascade,
  material_id   uuid not null references public.bom_materials(id),
  qty_ordered   numeric(14,4) not null check (qty_ordered > 0 and qty_ordered <= 100000000),
  unit_price    numeric(14,4) not null default 0 check (unit_price >= 0 and unit_price < 1000000000),
  expected_date date,
  qty_received  numeric(14,4) not null default 0 check (qty_received >= 0),
  qty_returned  numeric(14,4) not null default 0 check (qty_returned >= 0),
  note          text check (note is null or length(note) <= 300),
  request_line_id uuid,
  created_at    timestamptz not null default now(),
  constraint purchase_order_lines_returned_ck check (qty_returned <= qty_received)
);
create index purchase_order_lines_idx on public.purchase_order_lines (po_id);
create index purchase_order_lines_mat_idx on public.purchase_order_lines (material_id);

-- ---------------------------------------------------------------------
-- 5. Réceptions et retours (immuables : écrits uniquement par les fonctions ci-dessous)
-- ---------------------------------------------------------------------
create table public.purchase_receipts (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id),
  code          text not null,                                              -- REC-0001
  po_id         uuid not null references public.purchase_orders(id),
  supplier_id   uuid not null references public.suppliers(id),
  warehouse_id  uuid not null references public.warehouses(id),
  delivery_note text check (delivery_note is null or length(delivery_note) <= 80),   -- n° de bon de livraison du fournisseur
  notes         text check (notes is null or length(notes) <= 300),
  received_at   timestamptz not null default now(),
  received_by   uuid,
  unique (company_id, code)
);
create index purchase_receipts_idx on public.purchase_receipts (po_id, received_at desc);

create table public.purchase_receipt_lines (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id),
  receipt_id    uuid not null references public.purchase_receipts(id) on delete cascade,
  po_line_id    uuid not null references public.purchase_order_lines(id),
  material_id   uuid not null references public.bom_materials(id),
  location_id   uuid not null references public.stock_locations(id),
  qty           numeric(14,4) not null check (qty > 0),
  qty_returned  numeric(14,4) not null default 0 check (qty_returned >= 0 and qty_returned <= qty),
  unit_price    numeric(14,4) not null,
  movement_id   uuid references public.stock_movements(id)
);
create index purchase_receipt_lines_idx on public.purchase_receipt_lines (receipt_id);

create table public.purchase_returns (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id),
  code         text not null,                                               -- RET-0001
  receipt_id   uuid not null references public.purchase_receipts(id),
  po_id        uuid not null references public.purchase_orders(id),
  supplier_id  uuid not null references public.suppliers(id),
  warehouse_id uuid not null references public.warehouses(id),
  reason       text not null check (length(btrim(reason)) between 3 and 300),
  returned_at  timestamptz not null default now(),
  returned_by  uuid,
  unique (company_id, code)
);

create table public.purchase_return_lines (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id),
  return_id       uuid not null references public.purchase_returns(id) on delete cascade,
  receipt_line_id uuid not null references public.purchase_receipt_lines(id),
  material_id     uuid not null references public.bom_materials(id),
  qty             numeric(14,4) not null check (qty > 0),
  unit_price      numeric(14,4) not null,
  movement_id     uuid references public.stock_movements(id)
);
create index purchase_return_lines_idx on public.purchase_return_lines (return_id);

-- ---------------------------------------------------------------------
-- 6. Triggers
-- ---------------------------------------------------------------------
create function private.purchase_rpc() returns boolean language sql stable set search_path = '' as $$
  select coalesce(current_setting('purchases.rpc', true), 'off') = 'on' $$;

create function private.purchase_requests_before() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.company_id := coalesce(new.company_id, private.current_company());
    new.code := 'DA-' || lpad(private.next_seq(new.company_id, 'purchase_request')::text, 4, '0');
    new.requested_by := coalesce(auth.uid(), new.requested_by); new.status := 'draft';
    new.submitted_at := null; new.decided_by := null; new.decided_at := null; new.decision_comment := null;
    if new.source = 'mrp' and not private.purchase_rpc() then raise exception 'PURCHASE_BAD_SOURCE' using errcode = '42501'; end if;
  elsif not private.purchase_rpc() then
    if old.status <> 'draft' then raise exception 'PURCHASE_LOCKED' using errcode = '55000'; end if;
    new.updated_at := now();
  end if;
  new.reason := nullif(btrim(coalesce(new.reason, '')), '');
  return new;
end $$;
create trigger purchase_requests_before_iu before insert or update on public.purchase_requests
  for each row execute function private.purchase_requests_before();

create function private.purchase_request_lines_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r public.purchase_requests%rowtype; m public.bom_materials%rowtype; v_req uuid := coalesce(new.request_id, old.request_id);
begin
  select * into r from public.purchase_requests where id = v_req;
  if not private.purchase_rpc() and found and r.status <> 'draft' then raise exception 'PURCHASE_LOCKED' using errcode = '55000'; end if;
  if tg_op = 'DELETE' then return old; end if;
  if tg_op = 'INSERT' then
    if not found then raise exception 'PURCHASE_NOT_FOUND' using errcode = 'P0002'; end if;
    new.company_id := r.company_id;
    select * into m from public.bom_materials where id = new.material_id and company_id = r.company_id;
    if not found then raise exception 'PURCHASE_BAD_MATERIAL' using errcode = '22023'; end if;
    if m.archived_at is not null and not private.purchase_rpc() then raise exception 'PURCHASE_BAD_MATERIAL' using errcode = '22023'; end if;
    new.po_line_id := null;
  end if;
  if new.supplier_id is not null and not exists (select 1 from public.suppliers where id = new.supplier_id and company_id = new.company_id and archived_at is null) then
    raise exception 'PURCHASE_BAD_SUPPLIER' using errcode = '22023';
  end if;
  new.note := nullif(btrim(coalesce(new.note, '')), '');
  return new;
end $$;
create trigger purchase_request_lines_before_iud before insert or update or delete on public.purchase_request_lines
  for each row execute function private.purchase_request_lines_before();

-- Protection des commandes : création en brouillon, modifications limitées au brouillon (le reste passe par les fonctions)
create function private.purchase_orders_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.purchase_rpc() then return new; end if;
  if tg_op = 'INSERT' then
    new.status := 'draft'; new.total_amount := 0; new.received_date := null; new.sent_at := null; new.sent_by := null; new.request_id := null;
  elsif old.status <> 'draft' then
    raise exception 'PURCHASE_LOCKED' using errcode = '55000';
  end if;
  return new;
end $$;
create trigger purchase_orders_guard_iu before insert or update on public.purchase_orders
  for each row execute function private.purchase_orders_guard();

create function private.purchase_recalc(p_po uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_prev text := coalesce(current_setting('purchases.rpc', true), 'off');
begin
  perform set_config('purchases.rpc', 'on', true);
  update public.purchase_orders set total_amount = coalesce((select sum(qty_ordered * unit_price) from public.purchase_order_lines where po_id = p_po), 0), updated_at = now() where id = p_po;
  perform set_config('purchases.rpc', v_prev, true);
end $$;
revoke execute on function private.purchase_recalc(uuid) from public, anon, authenticated;

create function private.purchase_order_lines_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare o public.purchase_orders%rowtype; m public.bom_materials%rowtype; v_po uuid := coalesce(new.po_id, old.po_id);
begin
  select * into o from public.purchase_orders where id = v_po;
  if not private.purchase_rpc() and found and o.status <> 'draft' then raise exception 'PURCHASE_LOCKED' using errcode = '55000'; end if;
  if tg_op = 'DELETE' then return old; end if;
  if tg_op = 'INSERT' then
    if not found then raise exception 'PURCHASE_NOT_FOUND' using errcode = 'P0002'; end if;
    new.company_id := o.company_id;
    select * into m from public.bom_materials where id = new.material_id and company_id = o.company_id;
    if not found or (m.archived_at is not null and not private.purchase_rpc()) then raise exception 'PURCHASE_BAD_MATERIAL' using errcode = '22023'; end if;
    if not private.purchase_rpc() then new.qty_received := 0; new.qty_returned := 0; new.request_line_id := null; end if;
  elsif not private.purchase_rpc() then
    new.qty_received := old.qty_received; new.qty_returned := old.qty_returned;
  end if;
  new.note := nullif(btrim(coalesce(new.note, '')), '');
  return new;
end $$;
create trigger purchase_order_lines_before_iud before insert or update or delete on public.purchase_order_lines
  for each row execute function private.purchase_order_lines_before();

create function private.purchase_order_lines_after() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.qty_ordered = old.qty_ordered and new.unit_price = old.unit_price then return new; end if;
  perform private.purchase_recalc(coalesce(new.po_id, old.po_id));
  return coalesce(new, old);
end $$;
create trigger purchase_order_lines_after_iud after insert or update or delete on public.purchase_order_lines
  for each row execute function private.purchase_order_lines_after();

create function private.audit_purchase_requests() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.purchase_rpc() then return new; end if;
  perform private.write_audit(new.company_id, 'purchase.request_create', 'purchase', new.id::text, new.code, null, jsonb_build_object('code', new.code, 'reason', new.reason));
  return new;
end $$;
create trigger audit_purchase_requests_i after insert on public.purchase_requests for each row execute function private.audit_purchase_requests();

create function private.audit_purchase_orders() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.purchase_rpc() then return new; end if;
  perform private.write_audit(new.company_id, 'purchase.po_create', 'purchase', new.id::text, new.po_no, null,
    jsonb_build_object('po_no', new.po_no, 'supplier', (select name from public.suppliers where id = new.supplier_id)));
  return new;
end $$;
create trigger audit_purchase_orders_i after insert on public.purchase_orders for each row execute function private.audit_purchase_orders();

-- ---------------------------------------------------------------------
-- 7. Fonctions : demandes d'achat
-- ---------------------------------------------------------------------
create function private.can_edit_request(p_requested_by uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.has_perm('purchases.write') or (private.has_perm('purchases.request') and p_requested_by = auth.uid()) $$;
revoke execute on function private.can_edit_request(uuid) from public, anon;
grant execute on function private.can_edit_request(uuid) to authenticated;

create function public.purchase_request_submit(p_request uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.purchase_requests%rowtype;
begin
  select * into r from public.purchase_requests where id = p_request and company_id = private.current_company() for update;
  if not found then raise exception 'PURCHASE_NOT_FOUND' using errcode = 'P0002'; end if;
  if not private.can_edit_request(r.requested_by) then raise exception 'RBAC_FORBIDDEN' using errcode = '42501'; end if;
  if r.status <> 'draft' then raise exception 'PURCHASE_BAD_STATUS' using errcode = '55000'; end if;
  if not exists (select 1 from public.purchase_request_lines where request_id = p_request) then raise exception 'PURCHASE_EMPTY' using errcode = '55000'; end if;
  perform set_config('purchases.rpc', 'on', true);
  update public.purchase_requests set status = 'submitted', submitted_at = now() where id = p_request;
  perform set_config('purchases.rpc', 'off', true);
  perform private.write_audit(r.company_id, 'purchase.request_submit', 'purchase', r.id::text, r.code, null, null, '{}'::jsonb, 'rpc');
end $$;

create function public.purchase_request_decide(p_request uuid, p_approve boolean, p_comment text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.purchase_requests%rowtype;
begin
  perform private.require_perm('purchases.approve');
  select * into r from public.purchase_requests where id = p_request and company_id = private.current_company() for update;
  if not found then raise exception 'PURCHASE_NOT_FOUND' using errcode = 'P0002'; end if;
  if r.status <> 'submitted' then raise exception 'PURCHASE_BAD_STATUS' using errcode = '55000'; end if;
  if r.requested_by = auth.uid() then raise exception 'PURCHASE_SELF_APPROVAL' using errcode = '42501'; end if;     -- séparation des tâches
  if not p_approve and length(btrim(coalesce(p_comment, ''))) < 3 then raise exception 'PURCHASE_COMMENT_REQUIRED' using errcode = '22023'; end if;
  perform set_config('purchases.rpc', 'on', true);
  update public.purchase_requests set status = case when p_approve then 'approved' else 'rejected' end, decided_by = auth.uid(), decided_at = now(),
         decision_comment = nullif(btrim(coalesce(p_comment, '')), '') where id = p_request;
  perform set_config('purchases.rpc', 'off', true);
  perform private.write_audit(r.company_id, case when p_approve then 'purchase.request_approve' else 'purchase.request_reject' end, 'purchase', r.id::text, r.code, null, null,
    jsonb_build_object('comment', nullif(btrim(coalesce(p_comment, '')), '')), 'rpc');
end $$;

create function public.purchase_request_cancel(p_request uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.purchase_requests%rowtype;
begin
  select * into r from public.purchase_requests where id = p_request and company_id = private.current_company() for update;
  if not found then raise exception 'PURCHASE_NOT_FOUND' using errcode = 'P0002'; end if;
  if not private.can_edit_request(r.requested_by) then raise exception 'RBAC_FORBIDDEN' using errcode = '42501'; end if;
  if r.status not in ('draft', 'submitted', 'approved') then raise exception 'PURCHASE_BAD_STATUS' using errcode = '55000'; end if;
  if exists (select 1 from public.purchase_request_lines where request_id = p_request and po_line_id is not null) then raise exception 'PURCHASE_ALREADY_ORDERED' using errcode = '55000'; end if;
  perform set_config('purchases.rpc', 'on', true);
  update public.purchase_requests set status = 'cancelled' where id = p_request;
  update public.mrp_run_suggestions set request_id = null where request_id = p_request;      -- les suggestions MRP redeviennent disponibles
  perform set_config('purchases.rpc', 'off', true);
  perform private.write_audit(r.company_id, 'purchase.request_cancel', 'purchase', r.id::text, r.code, null, null, '{}'::jsonb, 'rpc');
end $$;

-- Demande approuvée → un bon de commande (brouillon) par fournisseur
create function public.purchase_request_to_orders(p_request uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r public.purchase_requests%rowtype; g record; ln record; v_po uuid; v_pol uuid; v_ids jsonb := '[]'::jsonb; v_missing text; v_price numeric; v_lead int; v_exp date;
begin
  perform private.require_perm('purchases.write');
  select * into r from public.purchase_requests where id = p_request and company_id = private.current_company() for update;
  if not found then raise exception 'PURCHASE_NOT_FOUND' using errcode = 'P0002'; end if;
  if r.status <> 'approved' then raise exception 'PURCHASE_BAD_STATUS' using errcode = '55000'; end if;
  select string_agg(distinct m.code, ', ') into v_missing
  from public.purchase_request_lines l join public.bom_materials m on m.id = l.material_id
  where l.request_id = p_request and l.po_line_id is null and coalesce(l.supplier_id, m.supplier_id) is null;
  if v_missing is not null then raise exception 'PURCHASE_NO_SUPPLIER' using errcode = '22023', detail = v_missing; end if;

  perform set_config('purchases.rpc', 'on', true);
  for g in
    select coalesce(l.supplier_id, m.supplier_id) as supplier_id
    from public.purchase_request_lines l join public.bom_materials m on m.id = l.material_id
    where l.request_id = p_request and l.po_line_id is null group by 1 order by 1
  loop
    select coalesce(lead_time_days, 14) into v_lead from public.suppliers where id = g.supplier_id;
    insert into public.purchase_orders (id, supplier_id, status, request_id, notes, created_by)
    values (gen_random_uuid(), g.supplier_id, 'draft', p_request, 'Issu de la demande ' || r.code, auth.uid()) returning id into v_po;
    for ln in
      select l.*, m.supplier_id as m_supplier from public.purchase_request_lines l join public.bom_materials m on m.id = l.material_id
      where l.request_id = p_request and l.po_line_id is null and coalesce(l.supplier_id, m.supplier_id) = g.supplier_id order by l.created_at, l.id
    loop
      select unit_cost into v_price from public.bom_material_prices where material_id = ln.material_id;
      v_exp := coalesce(ln.needed_date, r.needed_date, current_date + v_lead);
      v_pol := gen_random_uuid();
      insert into public.purchase_order_lines (id, po_id, material_id, qty_ordered, unit_price, expected_date, note, request_line_id)
      values (v_pol, v_po, ln.material_id, ln.qty, coalesce(v_price, 0), v_exp, ln.note, ln.id);
      update public.purchase_request_lines set po_line_id = v_pol where id = ln.id;
    end loop;
    update public.purchase_orders set expected_date = (select max(expected_date) from public.purchase_order_lines where po_id = v_po) where id = v_po;
    v_ids := v_ids || to_jsonb(v_po);
    perform private.write_audit(r.company_id, 'purchase.po_create', 'purchase', v_po::text, (select po_no from public.purchase_orders where id = v_po), null, null,
      jsonb_build_object('request', r.code, 'supplier', (select name from public.suppliers where id = g.supplier_id)), 'rpc');
  end loop;
  update public.purchase_requests set status = 'ordered' where id = p_request;
  perform set_config('purchases.rpc', 'off', true);
  perform private.write_audit(r.company_id, 'purchase.request_convert', 'purchase', r.id::text, r.code, null, null, jsonb_build_object('orders', jsonb_array_length(v_ids)), 'rpc');
  return v_ids;
end $$;

-- Suggestions MRP acceptées → demande d'achat (brouillon, source « mrp »)
create function public.purchase_request_from_mrp(p_run uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid := gen_random_uuid(); v_run public.mrp_runs%rowtype; v_n int;
begin
  perform private.require_perm('mrp.read');
  if not (private.has_perm('purchases.request') or private.has_perm('purchases.write')) then raise exception 'RBAC_FORBIDDEN' using errcode = '42501'; end if;
  select * into v_run from public.mrp_runs where id = p_run and company_id = v_co;
  if not found then raise exception 'PURCHASE_NOT_FOUND' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.mrp_run_suggestions where run_id = p_run and status = 'accepted' and request_id is null) then raise exception 'PURCHASE_NO_SUGGESTION' using errcode = '55000'; end if;
  perform set_config('purchases.rpc', 'on', true);
  insert into public.purchase_requests (id, company_id, source, mrp_run_id, reason, needed_date)
  values (v_id, v_co, 'mrp', p_run, 'Suggestions acceptées de la simulation ' || v_run.code,
          (select min(need_date) from public.mrp_run_suggestions where run_id = p_run and status = 'accepted' and request_id is null));
  insert into public.purchase_request_lines (company_id, request_id, material_id, qty, supplier_id, needed_date, note)
  select v_co, v_id, s.material_id, sum(s.qty), s.supplier_id, min(s.need_date), 'MRP ' || v_run.code
  from public.mrp_run_suggestions s where s.run_id = p_run and s.status = 'accepted' and s.request_id is null group by s.material_id, s.supplier_id;
  get diagnostics v_n = row_count;
  update public.mrp_run_suggestions set request_id = v_id where run_id = p_run and status = 'accepted' and request_id is null;
  perform set_config('purchases.rpc', 'off', true);
  perform private.write_audit(v_co, 'purchase.request_create', 'purchase', v_id::text, (select code from public.purchase_requests where id = v_id), null,
    jsonb_build_object('source', 'mrp'), jsonb_build_object('run', v_run.code, 'lines', v_n), 'rpc');
  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- 8. Fonctions : commandes fournisseur, réception, retour
-- ---------------------------------------------------------------------
create function public.purchase_order_send(p_po uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.purchase_orders%rowtype; v_lead int; v_exp date;
begin
  perform private.require_perm('purchases.write');
  select * into o from public.purchase_orders where id = p_po and company_id = private.current_company() for update;
  if not found then raise exception 'PURCHASE_NOT_FOUND' using errcode = 'P0002'; end if;
  if o.status <> 'draft' then raise exception 'PURCHASE_BAD_STATUS' using errcode = '55000'; end if;
  if not exists (select 1 from public.purchase_order_lines where po_id = p_po) then raise exception 'PURCHASE_EMPTY' using errcode = '55000'; end if;
  perform private.supplier_assert_open(o.supplier_id);
  select coalesce(lead_time_days, 14) into v_lead from public.suppliers where id = o.supplier_id;
  v_exp := coalesce(o.expected_date, (select max(expected_date) from public.purchase_order_lines where po_id = p_po), current_date + v_lead);
  perform set_config('purchases.rpc', 'on', true);
  update public.purchase_orders set status = 'sent', sent_at = now(), sent_by = auth.uid(), order_date = current_date, expected_date = v_exp where id = p_po;
  perform set_config('purchases.rpc', 'off', true);
  perform private.write_audit(o.company_id, 'purchase.po_send', 'purchase', o.id::text, o.po_no, null, null, jsonb_build_object('total', o.total_amount), 'rpc');
end $$;

create function public.purchase_order_cancel(p_po uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.purchase_orders%rowtype;
begin
  perform private.require_perm('purchases.write');
  select * into o from public.purchase_orders where id = p_po and company_id = private.current_company() for update;
  if not found then raise exception 'PURCHASE_NOT_FOUND' using errcode = 'P0002'; end if;
  if o.status not in ('draft', 'sent') then raise exception 'PURCHASE_BAD_STATUS' using errcode = '55000'; end if;
  if exists (select 1 from public.purchase_receipts where po_id = p_po) then raise exception 'PURCHASE_HAS_RECEIPTS' using errcode = '55000'; end if;
  perform set_config('purchases.rpc', 'on', true);
  update public.purchase_request_lines set po_line_id = null where po_line_id in (select id from public.purchase_order_lines where po_id = p_po);
  update public.purchase_requests set status = 'approved' where id = o.request_id and status = 'ordered';
  update public.purchase_orders set status = 'cancelled' where id = p_po;
  perform set_config('purchases.rpc', 'off', true);
  perform private.write_audit(o.company_id, 'purchase.po_cancel', 'purchase', o.id::text, o.po_no, jsonb_build_object('status', o.status), null, '{}'::jsonb, 'rpc');
end $$;

-- Recalcule le statut d'une commande d'après les quantités nettes reçues (reçu − retourné)
create function private.purchase_refresh_status(p_po uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_all boolean; v_any boolean; v_status text; v_prev text := coalesce(current_setting('purchases.rpc', true), 'off');
begin
  select bool_and(qty_received - qty_returned >= qty_ordered), bool_or(qty_received - qty_returned > 0) into v_all, v_any from public.purchase_order_lines where po_id = p_po;
  v_status := case when v_all then 'received' when v_any then 'partial' else 'sent' end;
  perform set_config('purchases.rpc', 'on', true);
  update public.purchase_orders set status = v_status, received_date = case when v_status = 'received' then coalesce(received_date, current_date) else null end where id = p_po;
  perform set_config('purchases.rpc', v_prev, true);
end $$;
revoke execute on function private.purchase_refresh_status(uuid) from public, anon, authenticated;

-- Réception : p_lines = [{ "line_id": uuid, "qty": n, "location_id": uuid? }]. Chaque ligne crée un lot FIFO au prix de la commande.
create function public.purchase_receive(p_po uuid, p_warehouse uuid, p_location uuid, p_lines jsonb, p_delivery_note text default null, p_notes text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  o public.purchase_orders%rowtype; v_co uuid := private.current_company(); v_id uuid := gen_random_uuid(); v_code text; j jsonb; pl public.purchase_order_lines%rowtype;
  v_qty numeric; v_loc uuid; v_mov uuid; v_n int := 0; v_ref text;
begin
  perform private.require_perm('purchases.receive');
  select * into o from public.purchase_orders where id = p_po and company_id = v_co for update;
  if not found then raise exception 'PURCHASE_NOT_FOUND' using errcode = 'P0002'; end if;
  if o.status not in ('sent', 'partial') then raise exception 'PURCHASE_BAD_STATUS' using errcode = '55000'; end if;
  if coalesce(jsonb_typeof(p_lines), '') <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'PURCHASE_EMPTY' using errcode = '55000'; end if;
  v_code := 'REC-' || lpad(private.next_seq(v_co, 'purchase_receipt')::text, 4, '0');
  v_ref := left(v_code || coalesce(' / BL ' || nullif(btrim(coalesce(p_delivery_note, '')), ''), ''), 120);
  perform set_config('purchases.rpc', 'on', true);
  insert into public.purchase_receipts (id, company_id, code, po_id, supplier_id, warehouse_id, delivery_note, notes, received_by)
  values (v_id, v_co, v_code, p_po, o.supplier_id, p_warehouse, nullif(btrim(coalesce(p_delivery_note, '')), ''), nullif(btrim(coalesce(p_notes, '')), ''), auth.uid());
  perform set_config('stock.trusted_cost', 'on', true);
  for j in select * from jsonb_array_elements(p_lines) loop
    v_qty := nullif(j ->> 'qty', '')::numeric;
    if v_qty is null or v_qty <= 0 then continue; end if;
    select * into pl from public.purchase_order_lines where id = (j ->> 'line_id')::uuid and po_id = p_po for update;
    if not found then raise exception 'PURCHASE_BAD_LINE' using errcode = '22023'; end if;
    if v_qty > pl.qty_ordered - (pl.qty_received - pl.qty_returned) then raise exception 'PURCHASE_OVER_RECEIPT' using errcode = '22023', detail = (select code from public.bom_materials where id = pl.material_id); end if;
    v_loc := coalesce(nullif(j ->> 'location_id', '')::uuid, p_location);
    if v_loc is null then raise exception 'STOCK_LOCATION_REQUIRED' using errcode = '22023'; end if;
    v_mov := private.stock_apply('in', 'in', pl.material_id, v_qty, p_warehouse, v_loc, null, v_ref, 'Réception ' || o.po_no, pl.unit_price, null, null);
    insert into public.purchase_receipt_lines (company_id, receipt_id, po_line_id, material_id, location_id, qty, unit_price, movement_id)
    values (v_co, v_id, pl.id, pl.material_id, v_loc, v_qty, pl.unit_price, v_mov);
    update public.purchase_order_lines set qty_received = qty_received + v_qty where id = pl.id;
    v_n := v_n + 1;
  end loop;
  perform set_config('stock.trusted_cost', 'off', true);
  if v_n = 0 then raise exception 'PURCHASE_EMPTY' using errcode = '55000'; end if;
  perform private.purchase_refresh_status(p_po);
  perform set_config('purchases.rpc', 'off', true);
  perform private.write_audit(v_co, 'purchase.receive', 'purchase', v_id::text, v_code, null, null,
    jsonb_build_object('po', o.po_no, 'lines', v_n, 'delivery_note', p_delivery_note), 'rpc');
  return v_id;
end $$;

-- Retour fournisseur : p_lines = [{ "receipt_line_id": uuid, "qty": n }] ; sortie de stock (FIFO sur l'emplacement de réception)
create function public.purchase_return(p_receipt uuid, p_lines jsonb, p_reason text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  rc public.purchase_receipts%rowtype; v_co uuid := private.current_company(); v_id uuid := gen_random_uuid(); v_code text; j jsonb;
  rl public.purchase_receipt_lines%rowtype; v_qty numeric; v_mov uuid; v_n int := 0; v_po public.purchase_orders%rowtype;
begin
  perform private.require_perm('purchases.receive');
  if length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'PURCHASE_REASON_REQUIRED' using errcode = '22023'; end if;
  select * into rc from public.purchase_receipts where id = p_receipt and company_id = v_co;
  if not found then raise exception 'PURCHASE_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into v_po from public.purchase_orders where id = rc.po_id for update;
  if coalesce(jsonb_typeof(p_lines), '') <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'PURCHASE_EMPTY' using errcode = '55000'; end if;
  v_code := 'RET-' || lpad(private.next_seq(v_co, 'purchase_return')::text, 4, '0');
  perform set_config('purchases.rpc', 'on', true);
  insert into public.purchase_returns (id, company_id, code, receipt_id, po_id, supplier_id, warehouse_id, reason, returned_by)
  values (v_id, v_co, v_code, p_receipt, rc.po_id, rc.supplier_id, rc.warehouse_id, btrim(p_reason), auth.uid());
  for j in select * from jsonb_array_elements(p_lines) loop
    v_qty := nullif(j ->> 'qty', '')::numeric;
    if v_qty is null or v_qty <= 0 then continue; end if;
    select * into rl from public.purchase_receipt_lines where id = (j ->> 'receipt_line_id')::uuid and receipt_id = p_receipt for update;
    if not found then raise exception 'PURCHASE_BAD_LINE' using errcode = '22023'; end if;
    if v_qty > rl.qty - rl.qty_returned then raise exception 'PURCHASE_OVER_RETURN' using errcode = '22023'; end if;
    v_mov := private.stock_apply('out', 'out', rl.material_id, v_qty, rc.warehouse_id, rl.location_id, null, v_code, 'Retour fournisseur : ' || left(btrim(p_reason), 200), null, null, null);
    insert into public.purchase_return_lines (company_id, return_id, receipt_line_id, material_id, qty, unit_price, movement_id) values (v_co, v_id, rl.id, rl.material_id, v_qty, rl.unit_price, v_mov);
    update public.purchase_receipt_lines set qty_returned = qty_returned + v_qty where id = rl.id;
    update public.purchase_order_lines set qty_returned = qty_returned + v_qty where id = rl.po_line_id;
    v_n := v_n + 1;
  end loop;
  if v_n = 0 then raise exception 'PURCHASE_EMPTY' using errcode = '55000'; end if;
  if v_po.status in ('partial', 'received') then perform private.purchase_refresh_status(rc.po_id); end if;      -- un retour rouvre le besoin
  perform set_config('purchases.rpc', 'off', true);
  perform private.write_audit(v_co, 'purchase.return', 'purchase', v_id::text, v_code, null, null, jsonb_build_object('receipt', rc.code, 'po', v_po.po_no, 'reason', btrim(p_reason), 'lines', v_n), 'rpc');
  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- 9. Statistiques d'achat
-- ---------------------------------------------------------------------
create function public.purchase_stats(p_from date default null, p_to date default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_from date := coalesce(p_from, current_date - 365); v_to date := coalesce(p_to, current_date); v_res jsonb;
begin
  perform private.require_perm('purchases.read');
  with po as (
    select * from public.purchase_orders where company_id = v_co and status in ('sent', 'partial', 'received') and order_date between v_from and v_to
  ), rcv as (
    select rl.qty * rl.unit_price as amount, coalesce(rl.qty_returned, 0) * rl.unit_price as returned
    from public.purchase_receipt_lines rl join public.purchase_receipts r on r.id = rl.receipt_id
    where r.company_id = v_co and r.received_at::date between v_from and v_to
  )
  select jsonb_build_object(
    'period', jsonb_build_object('from', v_from, 'to', v_to),
    'orders', (select count(*) from po),
    'amount', (select coalesce(sum(total_amount), 0) from po),
    'avg_order', (select coalesce(round(avg(total_amount), 2), 0) from po),
    'open_count', (select count(*) from po where status in ('sent', 'partial')),
    'open_amount', (select coalesce(sum(total_amount), 0) from po where status in ('sent', 'partial')),
    'late_open', (select count(*) from po where status in ('sent', 'partial') and expected_date is not null and expected_date < current_date),
    'received_count', (select count(*) from po where status = 'received'),
    'on_time_rate', (select case when count(*) filter (where status = 'received' and expected_date is not null) = 0 then null
        else round(100.0 * count(*) filter (where status = 'received' and expected_date is not null and received_date <= expected_date) / count(*) filter (where status = 'received' and expected_date is not null), 1) end from po),
    'avg_delay_days', (select round(avg(received_date - expected_date) filter (where status = 'received' and expected_date is not null and received_date is not null), 1) from po),
    'avg_lead_days', (select round(avg(received_date - order_date) filter (where status = 'received' and received_date is not null), 1) from po),
    'received_amount', (select coalesce(sum(amount), 0) from rcv),
    'returned_amount', (select coalesce(sum(returned), 0) from rcv),
    'return_rate', (select case when coalesce(sum(amount), 0) = 0 then null else round(100.0 * sum(returned) / sum(amount), 1) end from rcv),
    'by_month', coalesce((
      select jsonb_agg(jsonb_build_object('month', m.month, 'amount', coalesce(x.amount, 0), 'count', coalesce(x.n, 0)) order by m.month)
      from (select to_char(date_trunc('month', v_to) - (g || ' month')::interval, 'YYYY-MM') as month from generate_series(0, 11) g) m
      left join (select to_char(date_trunc('month', order_date), 'YYYY-MM') as month, sum(total_amount) as amount, count(*) as n from public.purchase_orders
                 where company_id = v_co and status in ('sent', 'partial', 'received') group by 1) x on x.month = m.month), '[]'::jsonb),
    'by_supplier', coalesce((
      select jsonb_agg(t order by (t ->> 'amount')::numeric desc) from (
        select jsonb_build_object('supplier_id', s.id, 'name', s.name, 'orders', count(*), 'amount', sum(po.total_amount),
          'on_time_rate', case when count(*) filter (where po.status = 'received' and po.expected_date is not null) = 0 then null
             else round(100.0 * count(*) filter (where po.status = 'received' and po.expected_date is not null and po.received_date <= po.expected_date) / count(*) filter (where po.status = 'received' and po.expected_date is not null), 1) end,
          'avg_lead_days', round(avg(po.received_date - po.order_date) filter (where po.status = 'received' and po.received_date is not null), 1)) as t
        from po join public.suppliers s on s.id = po.supplier_id group by s.id, s.name order by sum(po.total_amount) desc limit 10) q), '[]'::jsonb),
    'top_materials', coalesce((
      select jsonb_agg(t) from (
        select jsonb_build_object('material_id', m.id, 'code', m.code, 'name', m.name, 'unit', m.unit, 'qty', sum(l.qty_ordered), 'amount', sum(l.qty_ordered * l.unit_price)) as t
        from public.purchase_order_lines l join po on po.id = l.po_id join public.bom_materials m on m.id = l.material_id
        group by m.id, m.code, m.name, m.unit order by sum(l.qty_ordered * l.unit_price) desc limit 10) q), '[]'::jsonb),
    'requests', jsonb_build_object(
      'draft', (select count(*) from public.purchase_requests where company_id = v_co and status = 'draft'),
      'submitted', (select count(*) from public.purchase_requests where company_id = v_co and status = 'submitted'),
      'approved', (select count(*) from public.purchase_requests where company_id = v_co and status = 'approved'),
      'rejected', (select count(*) from public.purchase_requests where company_id = v_co and status = 'rejected' and created_at::date between v_from and v_to),
      'ordered', (select count(*) from public.purchase_requests where company_id = v_co and status = 'ordered' and created_at::date between v_from and v_to),
      'avg_approval_hours', (select round((avg(extract(epoch from decided_at - submitted_at)) / 3600)::numeric, 1) from public.purchase_requests
                              where company_id = v_co and decided_at is not null and submitted_at is not null and created_at::date between v_from and v_to))
  ) into v_res;
  return v_res;
end $$;

-- ---------------------------------------------------------------------
-- 10. Historique, RLS, privilèges
-- ---------------------------------------------------------------------
create policy audit_logs_select_purchase on public.audit_logs for select to authenticated
  using (entity_type = 'purchase' and company_id = private.current_company() and private.has_perm('purchases.read'));

alter table public.purchase_requests enable row level security;
alter table public.purchase_request_lines enable row level security;
alter table public.purchase_order_lines enable row level security;
alter table public.purchase_receipts enable row level security;
alter table public.purchase_receipt_lines enable row level security;
alter table public.purchase_returns enable row level security;
alter table public.purchase_return_lines enable row level security;

revoke all on public.purchase_requests, public.purchase_request_lines, public.purchase_order_lines, public.purchase_receipts, public.purchase_receipt_lines,
              public.purchase_returns, public.purchase_return_lines from anon, authenticated;
grant all on public.purchase_requests, public.purchase_request_lines, public.purchase_order_lines, public.purchase_receipts, public.purchase_receipt_lines,
             public.purchase_returns, public.purchase_return_lines to service_role;
grant select on public.purchase_requests, public.purchase_request_lines, public.purchase_order_lines, public.purchase_receipts, public.purchase_receipt_lines,
                public.purchase_returns, public.purchase_return_lines to authenticated;

-- commandes : plus d'écriture directe du statut, des montants ni des dates (fonctions uniquement)
revoke insert, update on public.purchase_orders from authenticated;
grant insert (supplier_id, expected_date, currency, notes) on public.purchase_orders to authenticated;
grant update (expected_date, notes) on public.purchase_orders to authenticated;

grant insert (needed_date, reason) on public.purchase_requests to authenticated;
grant update (needed_date, reason) on public.purchase_requests to authenticated;
grant insert (request_id, material_id, qty, supplier_id, needed_date, note) on public.purchase_request_lines to authenticated;
grant update (qty, supplier_id, needed_date, note) on public.purchase_request_lines to authenticated;
grant delete on public.purchase_request_lines to authenticated;
grant insert (po_id, material_id, qty_ordered, unit_price, expected_date, note) on public.purchase_order_lines to authenticated;
grant update (qty_ordered, unit_price, expected_date, note) on public.purchase_order_lines to authenticated;
grant delete on public.purchase_order_lines to authenticated;

create policy purchase_requests_select on public.purchase_requests for select to authenticated
  using (company_id = private.current_company() and (private.has_perm('purchases.read') or (private.has_perm('purchases.request') and requested_by = auth.uid())));
create policy purchase_requests_insert on public.purchase_requests for insert to authenticated
  with check (company_id = private.current_company() and (private.has_perm('purchases.request') or private.has_perm('purchases.write')));
create policy purchase_requests_update on public.purchase_requests for update to authenticated
  using (company_id = private.current_company() and private.can_edit_request(requested_by)) with check (company_id = private.current_company() and private.can_edit_request(requested_by));

create policy purchase_request_lines_select on public.purchase_request_lines for select to authenticated
  using (company_id = private.current_company() and exists (select 1 from public.purchase_requests r where r.id = request_id));
create policy purchase_request_lines_insert on public.purchase_request_lines for insert to authenticated
  with check (company_id = private.current_company() and exists (select 1 from public.purchase_requests r where r.id = request_id and private.can_edit_request(r.requested_by)));
create policy purchase_request_lines_update on public.purchase_request_lines for update to authenticated
  using (company_id = private.current_company() and exists (select 1 from public.purchase_requests r where r.id = request_id and private.can_edit_request(r.requested_by)))
  with check (company_id = private.current_company());
create policy purchase_request_lines_delete on public.purchase_request_lines for delete to authenticated
  using (company_id = private.current_company() and exists (select 1 from public.purchase_requests r where r.id = request_id and private.can_edit_request(r.requested_by)));

do $$
declare t text;
begin
  foreach t in array array['purchase_order_lines', 'purchase_receipts', 'purchase_receipt_lines', 'purchase_returns', 'purchase_return_lines'] loop
    execute format($f$create policy %I on public.%I for select to authenticated using (company_id = private.current_company() and private.has_perm('purchases.read'))$f$, t || '_select', t);
  end loop;
end $$;
create policy purchase_order_lines_insert on public.purchase_order_lines for insert to authenticated with check (company_id = private.current_company() and private.has_perm('purchases.write'));
create policy purchase_order_lines_update on public.purchase_order_lines for update to authenticated using (company_id = private.current_company() and private.has_perm('purchases.write')) with check (company_id = private.current_company() and private.has_perm('purchases.write'));
create policy purchase_order_lines_delete on public.purchase_order_lines for delete to authenticated using (company_id = private.current_company() and private.has_perm('purchases.write'));

do $$
declare f text;
begin
  foreach f in array array['purchase_request_submit(uuid)', 'purchase_request_decide(uuid,boolean,text)', 'purchase_request_cancel(uuid)', 'purchase_request_to_orders(uuid)',
      'purchase_request_from_mrp(uuid)', 'purchase_order_send(uuid)', 'purchase_order_cancel(uuid)', 'purchase_receive(uuid,uuid,uuid,jsonb,text,text)',
      'purchase_return(uuid,jsonb,text)', 'purchase_stats(date,date)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
