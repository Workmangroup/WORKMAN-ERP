-- =====================================================================
-- 0021_shipping — Expédition : préparation de commandes, picking, colisage, bon de livraison,
--                 packing list, facture export, suivi et indicateurs logistiques
--  Tables :
--    shipments        : expéditions (une commande confirmée peut en avoir plusieurs), statut, transport, documents
--    shipment_lines   : lignes par variante (taille × couleur) : demandé, prélevé, expédié, prix unitaire figé
--    shipment_events  : journal de suivi IMMUABLE (picking, colisage, expédition, transit, incident, livraison)
--  Flux : préparer (commande confirmée, quantité ≤ commandée par article) → picker (réservation du stock)
--         → colisser (toutes les lignes prélevées) → expédier (sortie de stock, bon de livraison)
--         → livrer. Une expédition peut être annulée tant qu'elle n'est pas expédiée (réservations libérées).
--  Facture export : émise sur une expédition expédiée, avec incoterm et pays de destination renseignés.
--  Stock : réservation = variant_stock.qty_reserved ; expédition = sortie de qty_on_hand, journalisée dans variant_stock_moves.
--  Droits : shipments.read (voir), shipments.write (tout le flux).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Permissions (codes existants en 0003)
-- ---------------------------------------------------------------------
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on r.is_system and (
     (r.code = 'admin'     and p.code in ('shipments.read', 'shipments.write'))
  or (r.code = 'magasin'   and p.code in ('shipments.read', 'shipments.write'))
  or (r.code = 'commercial' and p.code = 'shipments.read')
  or (r.code = 'direction' and p.code = 'shipments.read'))
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------
create table public.shipments (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null default private.current_company() references public.companies(id) on delete cascade,
  number              text not null,
  sales_order_id      uuid not null references public.sales_orders(id),
  client_id           uuid not null references public.clients(id),
  warehouse_id        uuid not null references public.warehouses(id),
  status              text not null default 'preparing' check (status in ('preparing', 'picking', 'packed', 'shipped', 'delivered', 'cancelled')),
  incoterm            text check (incoterm is null or incoterm in ('EXW', 'FCA', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP')),
  destination_country char(2) check (destination_country is null or destination_country ~ '^[A-Z]{2}$'),
  currency            char(3) not null default 'EUR' check (currency ~ '^[A-Z]{3}$'),
  carrier             text check (carrier is null or length(carrier) <= 80),
  tracking_number     text check (tracking_number is null or length(tracking_number) <= 80),
  packages            int check (packages is null or packages >= 0),
  gross_weight_kg     numeric(10,2) check (gross_weight_kg is null or gross_weight_kg >= 0),
  net_weight_kg       numeric(10,2) check (net_weight_kg is null or net_weight_kg >= 0),
  bl_number           text,
  bl_issued_at        timestamptz,
  export_invoice_number text,
  export_invoice_at   timestamptz,
  export_total        numeric(14,2),
  cancel_reason       text check (cancel_reason is null or length(cancel_reason) <= 300),
  created_at          timestamptz not null default now(),
  created_by          uuid default auth.uid(),
  packed_at           timestamptz,
  shipped_at          timestamptz,
  delivered_at        timestamptz,
  cancelled_at        timestamptz,
  unique (company_id, number),
  unique (company_id, bl_number),
  unique (company_id, export_invoice_number),
  check ((status = 'shipped' and bl_number is not null and shipped_at is not null) or status <> 'shipped'),
  check (status <> 'delivered' or delivered_at is not null),
  check (status <> 'cancelled' or cancelled_at is not null),
  check (export_invoice_number is null or status in ('shipped', 'delivered'))
);
create index shipments_status_idx on public.shipments (company_id, status, created_at desc);
create index shipments_order_idx on public.shipments (sales_order_id);

create table public.shipment_lines (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null default private.current_company() references public.companies(id) on delete cascade,
  shipment_id   uuid not null references public.shipments(id) on delete cascade,
  variant_id    uuid not null references public.product_variants(id),
  qty_requested int not null check (qty_requested > 0 and qty_requested <= 1000000),
  qty_picked    int not null default 0 check (qty_picked >= 0),
  qty_shipped   int not null default 0 check (qty_shipped >= 0),
  unit_price    numeric(14,2) not null default 0 check (unit_price >= 0),
  created_at    timestamptz not null default now(),
  unique (shipment_id, variant_id),
  check (qty_picked <= qty_requested),
  check (qty_shipped <= qty_picked)
);
create index shipment_lines_shipment_idx on public.shipment_lines (shipment_id);

create table public.shipment_events (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null default private.current_company() references public.companies(id) on delete cascade,
  shipment_id uuid not null references public.shipments(id),
  event_type  text not null check (event_type in ('created', 'picked', 'packed', 'shipped', 'in_transit', 'exception', 'delivered', 'cancelled')),
  location    text check (location is null or length(location) <= 120),
  note        text check (note is null or length(note) <= 300),
  occurred_at timestamptz not null default now(),
  created_by  uuid default auth.uid()
);
create index shipment_events_idx on public.shipment_events (shipment_id, occurred_at);

-- ---------------------------------------------------------------------
-- 3. Garde-fous : numérotation, immuabilité du suivi, cohérence société
-- ---------------------------------------------------------------------
create function private.doc_number() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.number is null then
    new.number := TG_ARGV[0] || to_char(now(), 'YYYY') || '-' || lpad(private.next_seq(new.company_id, TG_ARGV[1])::text, 6, '0');
  end if;
  return new;
end $$;
revoke execute on function private.doc_number() from public, anon, authenticated;
create trigger shipments_number_i before insert on public.shipments for each row execute function private.doc_number('SHP-', 'shipment');

create function private.shipping_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'SHIPPING_IMMUTABLE' using errcode = '42501';
end $$;
revoke execute on function private.shipping_immutable() from public, anon, authenticated;
create trigger shipment_events_immutable before update or delete on public.shipment_events
  for each row execute function private.shipping_immutable();

-- Commande, client, entrepôt et variante : même société ; entrepôt actif.
create function private.shipments_check() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.sales_orders o where o.id = new.sales_order_id and o.company_id = new.company_id and o.client_id = new.client_id) then
    raise exception 'SHIPPING_ORDER_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.warehouses w where w.id = new.warehouse_id and w.company_id = new.company_id and w.archived_at is null) then
    raise exception 'SHIPPING_WAREHOUSE_NOT_FOUND' using errcode = 'P0002';
  end if;
  return new;
end $$;
revoke execute on function private.shipments_check() from public, anon, authenticated;
create trigger shipments_check_i before insert on public.shipments for each row execute function private.shipments_check();

-- ---------------------------------------------------------------------
-- 4. Sécurité des lignes (lecture par droit et entrepôt affecté)
-- ---------------------------------------------------------------------
alter table public.shipments enable row level security;
alter table public.shipment_lines enable row level security;
alter table public.shipment_events enable row level security;
create policy shipments_select on public.shipments for select to authenticated
  using (company_id = private.current_company() and private.has_perm('shipments.read'));
create policy shipments_wh_scope on public.shipments as restrictive for select to authenticated
  using (private.wh_can(warehouse_id, 'viewer'));
create policy shipment_lines_select on public.shipment_lines for select to authenticated
  using (company_id = private.current_company() and private.has_perm('shipments.read'));
create policy shipment_events_select on public.shipment_events for select to authenticated
  using (company_id = private.current_company() and private.has_perm('shipments.read'));
create trigger shipments_wh_guard before insert or update or delete on public.shipments
  for each row execute function private.wh_write_guard('warehouse_id', 'operator');
revoke all on public.shipments, public.shipment_lines, public.shipment_events from anon, authenticated;
grant select on public.shipments, public.shipment_lines, public.shipment_events to authenticated;

-- ---------------------------------------------------------------------
-- 5. Fonctions internes
-- ---------------------------------------------------------------------
create function private.shipment_lock(p_id uuid) returns public.shipments
language plpgsql security definer set search_path = '' as $$
declare s public.shipments%rowtype;
begin
  select * into s from public.shipments where id = p_id and company_id = private.current_company() for update;
  if not found then raise exception 'SHIPPING_NOT_FOUND' using errcode = 'P0002'; end if;
  return s;
end $$;
revoke execute on function private.shipment_lock(uuid) from public, anon, authenticated;

create function private.shipment_event(p_shipment uuid, p_type text, p_location text default null, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.shipment_events (shipment_id, event_type, location, note)
  values (p_shipment, p_type, nullif(btrim(coalesce(p_location, '')), ''), nullif(btrim(coalesce(p_note, '')), ''));
end $$;
revoke execute on function private.shipment_event(uuid, text, text, text) from public, anon, authenticated;

-- Variante du stock : réservation et sortie, journalisées comme les autres mouvements de variante (0015).
create function private.shipping_stock(p_variant uuid, p_warehouse uuid, p_op text, p_qty int, p_reference text) returns void
language plpgsql security definer set search_path = '' as $$
declare s public.variant_stock%rowtype; v public.product_variants%rowtype;
begin
  select * into v from public.product_variants where id = p_variant;
  insert into public.variant_stock (company_id, variant_id, warehouse_id) values (v.company_id, v.id, p_warehouse) on conflict (variant_id, warehouse_id) do nothing;
  select * into s from public.variant_stock where variant_id = p_variant and warehouse_id = p_warehouse for update;
  perform set_config('variants.rpc', 'on', true);
  if p_op = 'reserve' then
    if p_qty > s.qty_on_hand - s.qty_reserved then raise exception 'SHIPPING_STOCK_INSUFFICIENT' using errcode = '55000'; end if;
    update public.variant_stock set qty_reserved = qty_reserved + p_qty, updated_at = now() where id = s.id;
  elsif p_op = 'release' then
    update public.variant_stock set qty_reserved = qty_reserved - p_qty, updated_at = now() where id = s.id;
  elsif p_op = 'issue' then
    if p_qty > s.qty_on_hand then raise exception 'SHIPPING_STOCK_INSUFFICIENT' using errcode = '55000'; end if;
    update public.variant_stock set qty_on_hand = qty_on_hand - p_qty, qty_reserved = qty_reserved - p_qty, updated_at = now() where id = s.id;
    insert into public.variant_stock_moves (company_id, variant_id, warehouse_id, move_type, qty_delta, balance_after, reason, reference, created_by)
      values (v.company_id, v.id, p_warehouse, 'issue', -p_qty, s.qty_on_hand - p_qty, 'Expédition', p_reference, auth.uid());
  end if;
  perform set_config('variants.rpc', 'off', true);
end $$;
revoke execute on function private.shipping_stock(uuid, uuid, text, int, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 6. Flux : préparation, picking, colisage, expédition, livraison, annulation, suivi
-- ---------------------------------------------------------------------
-- Préparer une expédition depuis une commande confirmée.
create function public.shipment_create(p_order uuid, p_warehouse uuid, p_incoterm text default null, p_country text default null,
  p_currency text default 'EUR') returns uuid
language plpgsql security definer set search_path = '' as $$
declare o public.sales_orders%rowtype; v_id uuid := gen_random_uuid(); v_number text;
begin
  perform private.require_perm('shipments.write');
  select * into o from public.sales_orders where id = p_order and company_id = private.current_company();
  if not found then raise exception 'SHIPPING_ORDER_NOT_FOUND' using errcode = 'P0002'; end if;
  if o.status <> 'confirmed' then raise exception 'SHIPPING_ORDER_NOT_CONFIRMED' using errcode = '55000'; end if;
  insert into public.shipments (id, sales_order_id, client_id, warehouse_id, incoterm, destination_country, currency)
  values (v_id, o.id, o.client_id, p_warehouse, nullif(p_incoterm, ''), nullif(upper(p_country), ''), upper(coalesce(p_currency, 'EUR')))
  returning number into v_number;
  perform private.shipment_event(v_id, 'created', null, 'Expédition ' || v_number);
  perform private.write_audit(o.company_id, 'shipping.create', 'shipment', v_id::text, v_number, null,
    jsonb_build_object('order', o.code), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

-- Ajouter une variante : son article doit figurer dans la commande, et la quantité ne dépasse pas la commande pour cet article.
create function public.shipment_add_line(p_shipment uuid, p_variant uuid, p_qty int) returns uuid
language plpgsql security definer set search_path = '' as $$
declare s public.shipments%rowtype; v public.product_variants%rowtype; v_article uuid; v_ordered numeric; v_allocated numeric; v_id uuid := gen_random_uuid();
begin
  perform private.require_perm('shipments.write');
  s := private.shipment_lock(p_shipment);
  if s.status not in ('preparing', 'picking') then raise exception 'SHIPPING_BAD_STATUS' using errcode = '55000'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'SHIPPING_BAD_QTY' using errcode = '22023'; end if;
  select * into v from public.product_variants where id = p_variant and company_id = s.company_id;
  if not found then raise exception 'SHIPPING_VARIANT_NOT_FOUND' using errcode = 'P0002'; end if;
  select pm.article_id into v_article from public.product_master pm where pm.id = v.product_id;
  if v_article is null or not exists (select 1 from public.sales_order_lines l where l.order_id = s.sales_order_id and l.article_id = v_article) then
    raise exception 'SHIPPING_ARTICLE_NOT_IN_ORDER' using errcode = '22023';
  end if;
  select coalesce(sum(qty), 0) into v_ordered from public.sales_order_lines where order_id = s.sales_order_id and article_id = v_article;
  select coalesce(sum(sl.qty_requested), 0) into v_allocated
    from public.shipment_lines sl
    join public.shipments sh on sh.id = sl.shipment_id
    join public.product_variants pv on pv.id = sl.variant_id
    join public.product_master pm on pm.id = pv.product_id
    where sh.sales_order_id = s.sales_order_id and sh.status <> 'cancelled' and pm.article_id = v_article;
  if v_allocated + p_qty > v_ordered then raise exception 'SHIPPING_QTY_EXCEEDS_ORDER' using errcode = '22023'; end if;
  insert into public.shipment_lines (id, shipment_id, variant_id, qty_requested, unit_price)
  values (v_id, s.id, v.id, p_qty, coalesce(v.price, 0));
  return v_id;
end $$;

-- Picking : réserve le stock disponible pour une ligne.
create function public.shipment_pick(p_line uuid, p_qty int) returns void
language plpgsql security definer set search_path = '' as $$
declare l public.shipment_lines%rowtype; s public.shipments%rowtype;
begin
  perform private.require_perm('shipments.write');
  select * into l from public.shipment_lines where id = p_line for update;
  if not found then raise exception 'SHIPPING_NOT_FOUND' using errcode = 'P0002'; end if;
  s := private.shipment_lock(l.shipment_id);
  if s.status not in ('preparing', 'picking') then raise exception 'SHIPPING_BAD_STATUS' using errcode = '55000'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'SHIPPING_BAD_QTY' using errcode = '22023'; end if;
  if l.qty_picked + p_qty > l.qty_requested then raise exception 'SHIPPING_QTY_EXCEEDS_LINE' using errcode = '22023'; end if;
  perform private.shipping_stock(l.variant_id, s.warehouse_id, 'reserve', p_qty, s.number);
  update public.shipment_lines set qty_picked = qty_picked + p_qty where id = p_line;
  update public.shipments set status = 'picking' where id = s.id and status = 'preparing';
  perform private.shipment_event(s.id, 'picked', null, 'Prélèvement de ' || p_qty || ' pièce(s)');
end $$;

-- Colisage : toutes les lignes entièrement prélevées.
create function public.shipment_pack(p_shipment uuid, p_packages int, p_gross numeric, p_net numeric) returns void
language plpgsql security definer set search_path = '' as $$
declare s public.shipments%rowtype; v_open int;
begin
  perform private.require_perm('shipments.write');
  s := private.shipment_lock(p_shipment);
  if s.status <> 'picking' then raise exception 'SHIPPING_BAD_STATUS' using errcode = '55000'; end if;
  select count(*) into v_open from public.shipment_lines where shipment_id = s.id and qty_picked < qty_requested;
  if v_open > 0 then raise exception 'SHIPPING_NOT_PICKED' using errcode = '55000'; end if;
  if p_packages is null or p_packages <= 0 then raise exception 'SHIPPING_BAD_QTY' using errcode = '22023'; end if;
  if p_net is not null and p_gross is not null and p_net > p_gross then raise exception 'SHIPPING_BAD_WEIGHT' using errcode = '22023'; end if;
  update public.shipments set status = 'packed', packed_at = now(), packages = p_packages, gross_weight_kg = p_gross, net_weight_kg = p_net where id = s.id;
  perform private.shipment_event(s.id, 'packed', null, p_packages || ' colis');
end $$;

-- Expédition : sortie de stock, numéro de bon de livraison.
create function public.shipment_ship(p_shipment uuid, p_carrier text, p_tracking text) returns text
language plpgsql security definer set search_path = '' as $$
declare s public.shipments%rowtype; l record; v_bl text;
begin
  perform private.require_perm('shipments.write');
  s := private.shipment_lock(p_shipment);
  if s.status <> 'packed' then raise exception 'SHIPPING_BAD_STATUS' using errcode = '55000'; end if;
  for l in select * from public.shipment_lines where shipment_id = s.id loop
    perform private.shipping_stock(l.variant_id, s.warehouse_id, 'issue', l.qty_picked, s.number);
    update public.shipment_lines set qty_shipped = l.qty_picked where id = l.id;
  end loop;
  v_bl := 'BL-' || to_char(now(), 'YYYY') || '-' || lpad(private.next_seq(s.company_id, 'delivery_note')::text, 6, '0');
  update public.shipments set status = 'shipped', shipped_at = now(), bl_number = v_bl, bl_issued_at = now(),
    carrier = nullif(btrim(coalesce(p_carrier, '')), ''), tracking_number = nullif(btrim(coalesce(p_tracking, '')), '') where id = s.id;
  perform private.shipment_event(s.id, 'shipped', null, 'Bon de livraison ' || v_bl);
  perform private.write_audit(s.company_id, 'shipping.ship', 'shipment', s.id::text, s.number, null,
    jsonb_build_object('bl', v_bl), '{}'::jsonb, 'rpc');
  return v_bl;
end $$;

create function public.shipment_deliver(p_shipment uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare s public.shipments%rowtype;
begin
  perform private.require_perm('shipments.write');
  s := private.shipment_lock(p_shipment);
  if s.status <> 'shipped' then raise exception 'SHIPPING_BAD_STATUS' using errcode = '55000'; end if;
  update public.shipments set status = 'delivered', delivered_at = now() where id = s.id;
  perform private.shipment_event(s.id, 'delivered', null, null);
end $$;

-- Annulation avant expédition : réservations libérées.
create function public.shipment_cancel(p_shipment uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare s public.shipments%rowtype; l record; v_reason text := btrim(coalesce(p_reason, ''));
begin
  perform private.require_perm('shipments.write');
  if length(v_reason) < 5 then raise exception 'SHIPPING_REASON_REQUIRED' using errcode = '22023'; end if;
  s := private.shipment_lock(p_shipment);
  if s.status not in ('preparing', 'picking', 'packed') then raise exception 'SHIPPING_BAD_STATUS' using errcode = '55000'; end if;
  for l in select * from public.shipment_lines where shipment_id = s.id and qty_picked > 0 loop
    perform private.shipping_stock(l.variant_id, s.warehouse_id, 'release', l.qty_picked, s.number);
  end loop;
  update public.shipments set status = 'cancelled', cancelled_at = now(), cancel_reason = v_reason where id = s.id;
  perform private.shipment_event(s.id, 'cancelled', null, v_reason);
end $$;

-- Suivi transport : transit ou incident.
create function public.shipment_track(p_shipment uuid, p_event text, p_location text, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare s public.shipments%rowtype;
begin
  perform private.require_perm('shipments.write');
  if p_event not in ('in_transit', 'exception') then raise exception 'SHIPPING_BAD_EVENT' using errcode = '22023'; end if;
  s := private.shipment_lock(p_shipment);
  if s.status not in ('shipped', 'delivered') then raise exception 'SHIPPING_BAD_STATUS' using errcode = '55000'; end if;
  perform private.shipment_event(s.id, p_event, p_location, p_note);
end $$;

-- Facture export : expédition expédiée, incoterm et pays de destination renseignés.
create function public.shipment_export_invoice(p_shipment uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare s public.shipments%rowtype; v_no text; v_total numeric;
begin
  perform private.require_perm('shipments.write');
  s := private.shipment_lock(p_shipment);
  if s.status not in ('shipped', 'delivered') then raise exception 'SHIPPING_BAD_STATUS' using errcode = '55000'; end if;
  if s.export_invoice_number is not null then raise exception 'SHIPPING_ALREADY_INVOICED' using errcode = '55000'; end if;
  if s.incoterm is null or s.destination_country is null then raise exception 'SHIPPING_EXPORT_DATA_MISSING' using errcode = '22023'; end if;
  select coalesce(sum(qty_shipped * unit_price), 0) into v_total from public.shipment_lines where shipment_id = s.id;
  v_no := 'EXP-' || to_char(now(), 'YYYY') || '-' || lpad(private.next_seq(s.company_id, 'export_invoice')::text, 6, '0');
  update public.shipments set export_invoice_number = v_no, export_invoice_at = now(), export_total = v_total where id = s.id;
  perform private.write_audit(s.company_id, 'shipping.export_invoice', 'shipment', s.id::text, s.number, null,
    jsonb_build_object('invoice', v_no, 'total', v_total), '{}'::jsonb, 'rpc');
  return v_no;
end $$;

-- ---------------------------------------------------------------------
-- 7. Indicateurs logistiques
-- ---------------------------------------------------------------------
create function public.shipping_dashboard() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); r jsonb;
begin
  perform private.require_perm('shipments.read');
  select jsonb_build_object(
    'by_status', (select coalesce(jsonb_object_agg(s, c), '{}'::jsonb) from (select status s, count(*) c from public.shipments where company_id = v_co group by status) x),
    'open', (select count(*) from public.shipments where company_id = v_co and status in ('preparing', 'picking', 'packed')),
    'late_open', (select count(*) from public.shipments sh where sh.company_id = v_co and sh.status in ('preparing', 'picking', 'packed')
        and (select min(l.due_date) from public.sales_order_lines l where l.order_id = sh.sales_order_id) < current_date),
    'on_time_pct', (select case when count(*) = 0 then null else round(100.0 * count(*) filter (where sh.shipped_at::date <= (select min(l.due_date) from public.sales_order_lines l where l.order_id = sh.sales_order_id))
        / count(*), 1) end from public.shipments sh where sh.company_id = v_co and sh.shipped_at is not null),
    'avg_lead_time_days', (select round(avg(extract(epoch from (shipped_at - created_at)) / 86400)::numeric, 1) from public.shipments
        where company_id = v_co and shipped_at is not null),
    'fill_rate_pct', (select case when ordered = 0 then null else round(100.0 * shipped / ordered, 1) end from (
        select (select coalesce(sum(qty_shipped), 0) from public.shipment_lines sl join public.shipments s2 on s2.id = sl.shipment_id where s2.company_id = v_co) shipped,
               (select coalesce(sum(l.qty), 0) from public.sales_order_lines l where l.company_id = v_co
                  and l.order_id in (select distinct sales_order_id from public.shipments where company_id = v_co and status in ('shipped', 'delivered'))) ordered) f),
    'packages_total', (select coalesce(sum(packages), 0) from public.shipments where company_id = v_co and status in ('shipped', 'delivered')),
    'avg_gross_kg_per_shipment', (select round(avg(gross_weight_kg), 2) from public.shipments where company_id = v_co and gross_weight_kg is not null),
    'exports_invoiced', (select count(*) from public.shipments where company_id = v_co and export_invoice_number is not null),
    'export_total', (select coalesce(sum(export_total), 0) from public.shipments where company_id = v_co and export_invoice_number is not null),
    'exceptions_open', (select count(distinct e.shipment_id) from public.shipment_events e where e.company_id = v_co and e.event_type = 'exception'
        and not exists (select 1 from public.shipment_events d where d.shipment_id = e.shipment_id and d.event_type = 'delivered' and d.occurred_at > e.occurred_at))
  ) into r;
  return r;
end $$;

-- ---------------------------------------------------------------------
-- 8. Droits d'exécution
-- ---------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'public.shipment_create(uuid, uuid, text, text, text)',
    'public.shipment_add_line(uuid, uuid, int)',
    'public.shipment_pick(uuid, int)',
    'public.shipment_pack(uuid, int, numeric, numeric)',
    'public.shipment_ship(uuid, text, text)',
    'public.shipment_deliver(uuid)',
    'public.shipment_cancel(uuid, text)',
    'public.shipment_track(uuid, text, text, text)',
    'public.shipment_export_invoice(uuid)',
    'public.shipping_dashboard()'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
