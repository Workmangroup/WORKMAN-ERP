-- 0055 — Livraisons (BL, lots, confirmation idempotente) et retours clients
-- Additive. Aucune fonction existante n'est remplacée : le BL reste émis par shipment_ship (0021), la livraison par shipment_deliver (0021).
-- Ajouts : lots de produits finis (quantité, statut libéré / non conforme), affectation des lots aux lignes d'expédition
-- (obligatoire au passage à « expédié », consommation une seule fois), reprint de BL sans effet, confirmation de livraison idempotente,
-- retours clients (demande, réception, inspection qualité réutilisée, règlement) — distincts des avoirs et des remboursements.
-- Réutilise : expéditions et stock (0015, 0021), inspections qualité et décisions (0020, 0033), blocage de stock (0053), numérotation (0033).

-- ---------------------------------------------------------------------
-- 1. Droits : aucun nouveau. Lecture des BL : shipments.read ; expéditions et retours : shipments.write ; lots : stock.write ;
--    non-conformité et blocage : quality.write ; règlement de retour : shipments.write et décision qualité existante.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- 2. Lots de produits finis
-- ---------------------------------------------------------------------
create table public.finished_lots (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null default private.current_company() references public.companies(id),
  lot_code     text not null check (length(btrim(lot_code)) between 2 and 60),
  variant_id   uuid not null references public.product_variants(id),
  warehouse_id uuid not null references public.warehouses(id),
  qty_in       int not null check (qty_in > 0),
  qty_out      int not null default 0 check (qty_out >= 0),
  status       text not null default 'released' check (status in ('released', 'nc')),
  origin       text not null check (origin in ('receipt', 'return')),
  origin_ref   text check (origin_ref is null or length(origin_ref) <= 60),
  nc_reason    text check (nc_reason is null or length(btrim(nc_reason)) between 5 and 300),
  nc_by        uuid,
  nc_at        timestamptz,
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now(),
  unique (company_id, lot_code),
  check (qty_out <= qty_in),
  check ((status = 'nc') = (nc_reason is not null))
);
create function private.finished_lot_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'APPEND_ONLY' using errcode = '55000'; end if;
  if (new.company_id, new.lot_code, new.variant_id, new.warehouse_id, new.qty_in, new.origin, new.origin_ref, new.created_by, new.created_at)
     is distinct from (old.company_id, old.lot_code, old.variant_id, old.warehouse_id, old.qty_in, old.origin, old.origin_ref, old.created_by, old.created_at) then
    raise exception 'APPEND_ONLY' using errcode = '55000';
  end if;
  if new.qty_out is distinct from old.qty_out then
    if old.status <> 'released' or new.qty_out < old.qty_out then raise exception 'LOT_NOT_RELEASED' using errcode = '55000'; end if;
  end if;
  if old.status = 'nc' and (new.status, new.nc_reason, new.nc_by, new.nc_at) is distinct from (old.status, old.nc_reason, old.nc_by, old.nc_at) then
    raise exception 'LOT_NC_FINAL' using errcode = '55000';
  end if;
  return new;
end $$;
create trigger finished_lots_guard before update or delete on public.finished_lots
  for each row execute function private.finished_lot_guard();
alter table public.finished_lots enable row level security;
create policy finished_lots_select on public.finished_lots for select to authenticated
  using (company_id = private.current_company() and private.has_perm('stock.read'));
grant select on public.finished_lots to authenticated;

-- Stock : entrée (même chemin que les réceptions de variantes, avec journal de stock)
create function private.variant_stock_receive(p_variant uuid, p_warehouse uuid, p_qty int, p_reason text, p_reference text) returns void
language plpgsql security definer set search_path = '' as $$
declare s public.variant_stock%rowtype; v public.product_variants%rowtype;
begin
  select * into v from public.product_variants where id = p_variant;
  insert into public.variant_stock (company_id, variant_id, warehouse_id) values (v.company_id, v.id, p_warehouse) on conflict (variant_id, warehouse_id) do nothing;
  select * into s from public.variant_stock where variant_id = p_variant and warehouse_id = p_warehouse for update;
  perform set_config('variants.rpc', 'on', true);
  update public.variant_stock set qty_on_hand = qty_on_hand + p_qty, updated_at = now() where id = s.id;
  insert into public.variant_stock_moves (company_id, variant_id, warehouse_id, move_type, qty_delta, balance_after, reason, reference, created_by)
  values (v.company_id, v.id, p_warehouse, 'receipt', p_qty, s.qty_on_hand + p_qty, p_reason, p_reference, auth.uid());
  perform set_config('variants.rpc', 'off', true);
end $$;
revoke execute on function private.variant_stock_receive(uuid, uuid, int, text, text) from public, anon, authenticated;

create function public.finished_lot_receive(p_variant uuid, p_warehouse uuid, p_lot_code text, p_qty int, p_origin_ref text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid; v_code text := btrim(coalesce(p_lot_code, ''));
begin
  perform private.require_perm('stock.write');
  if not exists (select 1 from public.product_variants where id = p_variant and company_id = v_co) then raise exception 'VARIANT_NOT_FOUND' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.warehouses where id = p_warehouse and company_id = v_co) then raise exception 'WAREHOUSE_NOT_FOUND' using errcode = 'P0002'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'LOT_QTY_INVALID' using errcode = '22023'; end if;
  insert into public.finished_lots (company_id, lot_code, variant_id, warehouse_id, qty_in, origin, origin_ref)
  values (v_co, v_code, p_variant, p_warehouse, p_qty, 'receipt', nullif(btrim(coalesce(p_origin_ref, '')), '')) returning id into v_id;
  perform private.variant_stock_receive(p_variant, p_warehouse, p_qty, 'Réception lot ' || v_code, v_code);
  perform private.write_audit(v_co, 'lot.receive', 'finished_lot', v_id::text, v_code, null, jsonb_build_object('qty', p_qty), '{}'::jsonb, 'rpc');
  return v_id;
end $$;
grant execute on function public.finished_lot_receive(uuid, uuid, text, int, text) to authenticated, service_role;

-- Non-conformité : le lot n'est plus vendable ; son stock restant est bloqué (0053), donc hors promesse
create function public.finished_lot_mark_nc(p_lot uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); l public.finished_lots%rowtype; v_remaining int;
begin
  perform private.require_perm('quality.write');
  select * into l from public.finished_lots where id = p_lot and company_id = v_co for update;
  if not found then raise exception 'LOT_NOT_FOUND' using errcode = 'P0002'; end if;
  if l.status <> 'released' then raise exception 'LOT_NC_FINAL' using errcode = '55000'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 5 then raise exception 'LOT_REASON_REQUIRED' using errcode = '22023'; end if;
  update public.finished_lots set status = 'nc', nc_reason = btrim(p_reason), nc_by = auth.uid(), nc_at = now() where id = l.id;
  v_remaining := l.qty_in - l.qty_out;
  if v_remaining > 0 then
    perform public.stock_block(l.variant_id, l.warehouse_id, v_remaining, 'Lot ' || l.lot_code || ' non conforme : ' || btrim(p_reason));
  end if;
  perform private.write_audit(v_co, 'lot.nc', 'finished_lot', l.id::text, l.lot_code, jsonb_build_object('status', 'released'),
    jsonb_build_object('status', 'nc', 'blocked', v_remaining), jsonb_build_object('reason', btrim(p_reason)), 'rpc');
end $$;
grant execute on function public.finished_lot_mark_nc(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 3. Affectation des lots aux lignes d'expédition (obligatoire, exacte, sur lots libérés)
-- ---------------------------------------------------------------------
create table public.shipment_line_lots (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null default private.current_company() references public.companies(id),
  shipment_line_id uuid not null references public.shipment_lines(id) on delete cascade,
  lot_id           uuid not null references public.finished_lots(id),
  qty              int not null check (qty > 0),
  created_at       timestamptz not null default now(),
  unique (shipment_line_id, lot_id)
);
create function private.shipment_line_lot_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare sh public.shipments%rowtype; ln public.shipment_lines%rowtype; l public.finished_lots%rowtype; v_open_assigned int; v_line_assigned int;
begin
  if tg_op = 'UPDATE' then raise exception 'APPEND_ONLY' using errcode = '55000'; end if;
  if tg_op = 'DELETE' then
    select * into sh from public.shipments where id = (select shipment_id from public.shipment_lines where id = old.shipment_line_id);
    if sh.status not in ('preparing', 'picking', 'packed') then raise exception 'SHIPPING_BAD_STATUS' using errcode = '55000'; end if;
    return old;
  end if;
  select * into ln from public.shipment_lines where id = new.shipment_line_id;
  select * into sh from public.shipments where id = ln.shipment_id;
  if sh.status not in ('preparing', 'picking', 'packed') then raise exception 'SHIPPING_BAD_STATUS' using errcode = '55000'; end if;
  select * into l from public.finished_lots where id = new.lot_id;
  if not found or l.company_id <> sh.company_id then raise exception 'LOT_NOT_FOUND' using errcode = 'P0002'; end if;
  if l.variant_id <> ln.variant_id then raise exception 'LOT_VARIANT_MISMATCH' using errcode = '22023'; end if;
  if l.status <> 'released' then raise exception 'LOT_NOT_RELEASED' using errcode = '55000', detail = l.lot_code; end if;
  select coalesce(sum(a.qty), 0) into v_line_assigned from public.shipment_line_lots a where a.shipment_line_id = ln.id;
  if v_line_assigned + new.qty > ln.qty_picked then raise exception 'LOT_QTY_EXCEEDS_PICKED' using errcode = '22023'; end if;
  -- Quantité encore libre du lot : ce qui est affecté à des expéditions ouvertes n'est pas disponible une seconde fois
  select coalesce(sum(a.qty), 0) into v_open_assigned from public.shipment_line_lots a
    join public.shipment_lines sl on sl.id = a.shipment_line_id join public.shipments s on s.id = sl.shipment_id
   where a.lot_id = l.id and s.status in ('preparing', 'picking', 'packed');
  if l.qty_in - l.qty_out - v_open_assigned < new.qty then raise exception 'LOT_QTY_INSUFFICIENT' using errcode = '22023'; end if;
  return new;
end $$;
create trigger shipment_line_lots_guard before insert or update or delete on public.shipment_line_lots
  for each row execute function private.shipment_line_lot_guard();
alter table public.shipment_line_lots enable row level security;
create policy shipment_line_lots_select on public.shipment_line_lots for select to authenticated
  using (company_id = private.current_company() and private.has_perm('shipments.read'));
grant select on public.shipment_line_lots to authenticated;

create function public.shipment_line_lot_assign(p_line uuid, p_lot uuid, p_qty int) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid;
begin
  perform private.require_perm('shipments.write');
  if not exists (select 1 from public.shipment_lines sl join public.shipments s on s.id = sl.shipment_id where sl.id = p_line and s.company_id = v_co) then
    raise exception 'SHIPPING_NOT_FOUND' using errcode = 'P0002';
  end if;
  insert into public.shipment_line_lots (company_id, shipment_line_id, lot_id, qty) values (v_co, p_line, p_lot, p_qty) returning id into v_id;
  perform private.write_audit(v_co, 'shipping.lot_assign', 'shipment_line', p_line::text, null, null, jsonb_build_object('lot', p_lot, 'qty', p_qty), '{}'::jsonb, 'rpc');
  return v_id;
end $$;
grant execute on function public.shipment_line_lot_assign(uuid, uuid, int) to authenticated, service_role;

create function public.shipment_line_lot_unassign(p_assignment uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); a public.shipment_line_lots%rowtype;
begin
  perform private.require_perm('shipments.write');
  select * into a from public.shipment_line_lots where id = p_assignment and company_id = v_co;
  if not found then raise exception 'SHIPPING_NOT_FOUND' using errcode = 'P0002'; end if;
  delete from public.shipment_line_lots where id = a.id;
  perform private.write_audit(v_co, 'shipping.lot_unassign', 'shipment_line', a.shipment_line_id::text, null, jsonb_build_object('lot', a.lot_id, 'qty', a.qty), null, '{}'::jsonb, 'rpc');
end $$;
grant execute on function public.shipment_line_lot_unassign(uuid) to authenticated, service_role;

-- Au passage à « expédié » : chaque quantité prélevée est couverte exactement par des lots libérés ; les lots sont consommés une fois
create function private.shipment_consume_lots() returns trigger
language plpgsql security definer set search_path = '' as $$
declare ln record; a record; v_assigned int;
begin
  for ln in select sl.id, sl.qty_picked from public.shipment_lines sl where sl.shipment_id = new.id and sl.qty_picked > 0 loop
    select coalesce(sum(qty), 0) into v_assigned from public.shipment_line_lots where shipment_line_id = ln.id;
    if v_assigned <> ln.qty_picked then raise exception 'SHIPPING_LOT_REQUIRED' using errcode = '55000', detail = 'affecter les lots à toutes les quantités prélevées'; end if;
  end loop;
  for a in select sla.lot_id, sla.qty from public.shipment_line_lots sla join public.shipment_lines sl on sl.id = sla.shipment_line_id where sl.shipment_id = new.id loop
    update public.finished_lots set qty_out = qty_out + a.qty where id = a.lot_id;
  end loop;
  return new;
end $$;
create trigger shipments_consume_lots before update of status on public.shipments
  for each row when (new.status = 'shipped' and old.status = 'packed') execute function private.shipment_consume_lots();

-- ---------------------------------------------------------------------
-- 4. BL : reprint sans effet ; confirmation de livraison idempotente
-- ---------------------------------------------------------------------
create function public.bl_reprint(p_shipment uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.shipments%rowtype;
begin
  perform private.require_perm('shipments.read');
  select * into s from public.shipments where id = p_shipment and company_id = private.current_company();
  if not found then raise exception 'SHIPPING_NOT_FOUND' using errcode = 'P0002'; end if;
  if s.bl_number is null then raise exception 'SHIPPING_BAD_STATUS' using errcode = '55000', detail = 'aucun BL émis'; end if;
  perform private.write_audit(s.company_id, 'bl.reprint', 'shipment', s.id::text, s.bl_number, null, null, '{}'::jsonb, 'rpc');
  return jsonb_build_object('shipment_id', s.id, 'bl_number', s.bl_number, 'bl_issued_at', s.bl_issued_at, 'status', s.status);
end $$;
grant execute on function public.bl_reprint(uuid) to authenticated, service_role;

create table public.delivery_confirmations (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null default private.current_company() references public.companies(id),
  shipment_id      uuid not null unique references public.shipments(id),
  idempotency_key  text not null check (length(btrim(idempotency_key)) between 8 and 80),
  receiver_name    text not null check (length(btrim(receiver_name)) between 2 and 120),
  confirmed_by     uuid default auth.uid(),
  confirmed_at     timestamptz not null default now(),
  unique (company_id, idempotency_key)
);
create trigger delivery_confirmations_no_change before update or delete on public.delivery_confirmations
  for each row execute function private.append_only_guard();
alter table public.delivery_confirmations enable row level security;
create policy delivery_confirmations_select on public.delivery_confirmations for select to authenticated
  using (company_id = private.current_company() and private.has_perm('shipments.read'));
grant select on public.delivery_confirmations to authenticated;

-- Même clé pour la même expédition : même réponse, aucun effet. Autre clé : refus (déjà confirmée).
create function public.delivery_confirm(p_shipment uuid, p_key text, p_receiver text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); s public.shipments%rowtype; c public.delivery_confirmations%rowtype; v_key text := btrim(coalesce(p_key, ''));
begin
  perform private.require_perm('shipments.write');
  if length(v_key) < 8 then raise exception 'DELIVERY_KEY_REQUIRED' using errcode = '22023'; end if;
  if length(btrim(coalesce(p_receiver, ''))) < 2 then raise exception 'DELIVERY_RECEIVER_REQUIRED' using errcode = '22023'; end if;
  select * into c from public.delivery_confirmations where company_id = v_co and idempotency_key = v_key;
  if found then
    if c.shipment_id = p_shipment then
      return jsonb_build_object('confirmation_id', c.id, 'replayed', true, 'confirmed_at', c.confirmed_at);
    end if;
    raise exception 'DELIVERY_KEY_REUSED' using errcode = '23505';
  end if;
  select * into s from public.shipments where id = p_shipment and company_id = v_co for update;
  if not found then raise exception 'SHIPPING_NOT_FOUND' using errcode = 'P0002'; end if;
  if exists (select 1 from public.delivery_confirmations where shipment_id = s.id) then
    raise exception 'DELIVERY_ALREADY_CONFIRMED' using errcode = '55000';
  end if;
  if s.status <> 'shipped' then raise exception 'DELIVERY_BAD_STATUS' using errcode = '55000'; end if;
  perform public.shipment_deliver(s.id);
  insert into public.delivery_confirmations (company_id, shipment_id, idempotency_key, receiver_name)
  values (v_co, s.id, v_key, btrim(p_receiver)) returning * into c;
  perform private.write_audit(v_co, 'delivery.confirm', 'shipment', s.id::text, s.number, null,
    jsonb_build_object('receiver', btrim(p_receiver), 'bl', s.bl_number), '{}'::jsonb, 'rpc');
  return jsonb_build_object('confirmation_id', c.id, 'replayed', false, 'confirmed_at', c.confirmed_at);
end $$;
grant execute on function public.delivery_confirm(uuid, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 5. Retours clients : demande → réception → inspection qualité → règlement
--    Retour, avoir et remboursement restent séparés : un retour ne crée ni avoir ni remboursement.
-- ---------------------------------------------------------------------
create table public.customer_returns (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null default private.current_company() references public.companies(id),
  number           text not null,
  shipment_line_id uuid not null references public.shipment_lines(id),
  variant_id       uuid not null references public.product_variants(id),
  origin_lot_id    uuid references public.finished_lots(id),
  qty              int not null check (qty > 0),
  reason           text not null check (length(btrim(reason)) between 5 and 300),
  declared_condition text not null default 'unknown' check (declared_condition in ('good', 'damaged', 'unknown')),
  status           text not null default 'requested' check (status in ('requested', 'received', 'inspecting', 'accepted', 'rejected')),
  inspection_id    uuid references public.quality_inspections(id),
  restocked_lot_id uuid references public.finished_lots(id),
  nc_lot_id        uuid references public.finished_lots(id),
  requested_by     uuid default auth.uid(),
  requested_at     timestamptz not null default now(),
  received_at      timestamptz,
  settled_at       timestamptz,
  unique (company_id, number),
  check ((status in ('accepted', 'rejected')) = (settled_at is not null)),
  check (status <> 'accepted' or restocked_lot_id is not null),
  check (status <> 'rejected' or nc_lot_id is not null)
);
create trigger customer_returns_number_i before insert on public.customer_returns for each row execute function private.doc_number('RET-', 'customer_return');
create function private.customer_return_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'APPEND_ONLY' using errcode = '55000'; end if;
  if (new.company_id, new.number, new.shipment_line_id, new.variant_id, new.origin_lot_id, new.qty, new.reason, new.requested_by, new.requested_at)
     is distinct from (old.company_id, old.number, old.shipment_line_id, old.variant_id, old.origin_lot_id, old.qty, old.reason, old.requested_by, old.requested_at) then
    raise exception 'APPEND_ONLY' using errcode = '55000';
  end if;
  if not ((old.status = 'requested' and new.status = 'received')
       or (old.status = 'received' and new.status = 'inspecting')
       or (old.status = 'inspecting' and new.status in ('accepted', 'rejected'))
       or new.status = old.status) then
    raise exception 'RETURN_BAD_STATUS' using errcode = '55000';
  end if;
  return new;
end $$;
create trigger customer_returns_guard before update or delete on public.customer_returns
  for each row execute function private.customer_return_guard();
alter table public.customer_returns enable row level security;
create policy customer_returns_select on public.customer_returns for select to authenticated
  using (company_id = private.current_company() and private.has_perm('shipments.read'));
grant select on public.customer_returns to authenticated;

create function public.return_request(p_shipment_line uuid, p_qty int, p_reason text, p_lot uuid default null, p_condition text default 'unknown') returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); ln public.shipment_lines%rowtype; s public.shipments%rowtype; v_id uuid; v_returned int; v_lot uuid := p_lot;
begin
  perform private.require_perm('shipments.write');
  select * into ln from public.shipment_lines where id = p_shipment_line and company_id = v_co;
  if not found then raise exception 'SHIPPING_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into s from public.shipments where id = ln.shipment_id;
  if s.status not in ('shipped', 'delivered') then raise exception 'RETURN_NOT_SHIPPED' using errcode = '55000'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'RETURN_QTY_INVALID' using errcode = '22023'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 5 then raise exception 'RETURN_REASON_REQUIRED' using errcode = '22023'; end if;
  if p_condition not in ('good', 'damaged', 'unknown') then raise exception 'RETURN_CONDITION_INVALID' using errcode = '22023'; end if;
  -- Quantité retournable : expédiée, moins ce qui a déjà fait l'objet d'un retour (toutes issues confondues)
  select coalesce(sum(qty), 0) into v_returned from public.customer_returns where shipment_line_id = ln.id;
  if p_qty > ln.qty_shipped - v_returned then raise exception 'RETURN_QTY_EXCEEDS_SHIPPED' using errcode = '22023'; end if;
  if v_lot is not null and not exists (select 1 from public.shipment_line_lots where shipment_line_id = ln.id and lot_id = v_lot) then
    raise exception 'RETURN_LOT_MISMATCH' using errcode = '22023';
  end if;
  insert into public.customer_returns (company_id, shipment_line_id, variant_id, origin_lot_id, qty, reason, declared_condition)
  values (v_co, ln.id, ln.variant_id, v_lot, p_qty, btrim(p_reason), p_condition) returning id into v_id;
  perform private.write_audit(v_co, 'return.request', 'shipment', s.id::text, s.number, null, jsonb_build_object('qty', p_qty), jsonb_build_object('return', v_id), 'rpc');
  return v_id;
end $$;
grant execute on function public.return_request(uuid, int, text, uuid, text) to authenticated, service_role;

create function public.return_receive(p_return uuid, p_condition text) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.customer_returns%rowtype;
begin
  perform private.require_perm('shipments.write');
  select * into r from public.customer_returns where id = p_return and company_id = private.current_company() for update;
  if not found then raise exception 'RETURN_NOT_FOUND' using errcode = 'P0002'; end if;
  if r.status <> 'requested' then raise exception 'RETURN_BAD_STATUS' using errcode = '55000'; end if;
  if p_condition not in ('good', 'damaged', 'unknown') then raise exception 'RETURN_CONDITION_INVALID' using errcode = '22023'; end if;
  update public.customer_returns set status = 'received', received_at = now(), declared_condition = p_condition where id = r.id;
  perform private.write_audit(r.company_id, 'return.receive', 'return', r.id::text, r.number, jsonb_build_object('status', 'requested'),
    jsonb_build_object('status', 'received', 'condition', p_condition), '{}'::jsonb, 'rpc');
end $$;
grant execute on function public.return_receive(uuid, text) to authenticated, service_role;

-- Inspection qualité du retour (contrôle final sur l'article) : décision prise par le contrôle qualité existant
create function public.return_open_inspection(p_return uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare r public.customer_returns%rowtype; v_article uuid; v_insp uuid;
begin
  perform private.require_perm('quality.write');
  select * into r from public.customer_returns where id = p_return and company_id = private.current_company() for update;
  if not found then raise exception 'RETURN_NOT_FOUND' using errcode = 'P0002'; end if;
  if r.status <> 'received' then raise exception 'RETURN_BAD_STATUS' using errcode = '55000'; end if;
  select pm.article_id into v_article from public.product_variants v join public.product_master pm on pm.id = v.product_id where v.id = r.variant_id;
  if v_article is null then raise exception 'RETURN_NO_ARTICLE' using errcode = '22023'; end if;
  v_insp := public.quality_inspection_open('final', null, v_article, null, null, null, r.qty, 'Retour ' || r.number);
  update public.customer_returns set status = 'inspecting', inspection_id = v_insp where id = r.id;
  return v_insp;
end $$;
grant execute on function public.return_open_inspection(uuid) to authenticated, service_role;

-- Règlement : accepté → remis en stock vendable (lot libéré) ; refusé ou conditionnel → lot non conforme, rien en stock vendable
create function public.return_settle(p_return uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.customer_returns%rowtype; i public.quality_inspections%rowtype; s public.shipments%rowtype; ln public.shipment_lines%rowtype;
  v_lot uuid; v_code text; v_decision text; v_status text;
begin
  perform private.require_perm('shipments.write');
  select * into r from public.customer_returns where id = p_return and company_id = private.current_company() for update;
  if not found then raise exception 'RETURN_NOT_FOUND' using errcode = 'P0002'; end if;
  if r.status <> 'inspecting' then raise exception 'RETURN_BAD_STATUS' using errcode = '55000'; end if;
  select * into i from public.quality_inspections where id = r.inspection_id;
  if i.status <> 'closed' or i.decision is null then raise exception 'RETURN_DECISION_PENDING' using errcode = '55000'; end if;
  select * into ln from public.shipment_lines where id = r.shipment_line_id;
  select * into s from public.shipments where id = ln.shipment_id;
  v_code := 'RET-' || r.number;
  v_decision := i.decision;
  if v_decision = 'accepted' then
    perform private.variant_stock_receive(r.variant_id, s.warehouse_id, r.qty, 'Retour client accepté ' || r.number, r.number);
    insert into public.finished_lots (company_id, lot_code, variant_id, warehouse_id, qty_in, origin, origin_ref)
    values (r.company_id, v_code, r.variant_id, s.warehouse_id, r.qty, 'return', r.number) returning id into v_lot;
    v_status := 'accepted';
    update public.customer_returns set status = 'accepted', restocked_lot_id = v_lot, settled_at = now() where id = r.id;
  else
    insert into public.finished_lots (company_id, lot_code, variant_id, warehouse_id, qty_in, status, origin, origin_ref, nc_reason, nc_at)
    values (r.company_id, v_code, r.variant_id, s.warehouse_id, r.qty, 'nc', 'return', r.number, 'Retour non conforme (' || v_decision || ')', now()) returning id into v_lot;
    v_status := 'rejected';
    update public.customer_returns set status = 'rejected', nc_lot_id = v_lot, settled_at = now() where id = r.id;
  end if;
  perform private.write_audit(r.company_id, 'return.settle', 'return', r.id::text, r.number, jsonb_build_object('status', 'inspecting'),
    jsonb_build_object('status', v_status, 'decision', v_decision, 'lot', v_code), '{}'::jsonb, 'rpc');
  return jsonb_build_object('status', v_status, 'decision', v_decision, 'lot_id', v_lot, 'lot_code', v_code);
end $$;
grant execute on function public.return_settle(uuid) to authenticated, service_role;

-- Verrouillage : écritures par fonctions uniquement
revoke all on public.finished_lots, public.shipment_line_lots, public.delivery_confirmations, public.customer_returns from anon;
revoke insert, update, delete, truncate on public.finished_lots, public.shipment_line_lots, public.delivery_confirmations, public.customer_returns from authenticated;
