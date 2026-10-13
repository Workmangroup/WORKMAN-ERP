-- 0052 — Commandes et reliquats : quantités livrées et annulées par ligne, reliquats, annulation motivée,
-- échéanciers, adresse de livraison, versions des engagements (append-only).
-- Additive, sauf trois fonctions remplacées (expédition : ajout de ligne et livraison ; statut de commande : annulation),
-- dont le comportement existant est conservé et seulement complété. Aucune donnée n'est supprimée ni réécrite.

-- ---------------------------------------------------------------------
-- 1. Colonnes
-- ---------------------------------------------------------------------
alter table public.sales_order_lines
  add column qty_delivered numeric(12,2) not null default 0 check (qty_delivered >= 0),
  add column qty_cancelled numeric(12,2) not null default 0 check (qty_cancelled >= 0),
  add constraint sales_order_lines_fulfilment_ck check (qty_delivered + qty_cancelled <= qty);

alter table public.sales_orders add column delivery_address text check (delivery_address is null or length(btrim(delivery_address)) between 5 and 300);

alter table public.shipment_lines add column order_line_id uuid references public.sales_order_lines(id);
create index shipment_lines_order_line_idx on public.shipment_lines (order_line_id);

-- Correction (défaut trouvé par le test P027) : la garde d'historique des SKU (0039) se nommait avant le déclencheur qui génère
-- le SKU (0015, variants_before_iu). Les déclencheurs BEFORE d'un même événement s'exécutent par ordre alphabétique : la garde
-- voyait un SKU vide et la génération de variantes échouait. Même logique, nom placé après la génération.
drop trigger product_variants_sku_guard_iu on public.product_variants;
create trigger variants_sku_history_iu before insert or update on public.product_variants
  for each row execute function private.variant_sku_guard();

-- Quantités livrées ou annulées : modifiables seulement par les fonctions de ce lot (jamais par saisie directe)
create function private.order_line_fulfilment_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (new.qty_delivered, new.qty_cancelled) is distinct from (old.qty_delivered, old.qty_cancelled)
     and coalesce(current_setting('orders.rpc', true), 'off') <> 'on' then
    raise exception 'ORDER_FULFILMENT_LOCKED' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger sales_order_lines_fulfilment_guard before update on public.sales_order_lines
  for each row execute function private.order_line_fulfilment_guard();

-- ---------------------------------------------------------------------
-- 2. Échéanciers (par ligne, définis en brouillon, figés à la confirmation)
-- ---------------------------------------------------------------------
create table public.sales_order_schedules (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null default private.current_company() references public.companies(id),
  order_id    uuid not null references public.sales_orders(id) on delete cascade,
  line_id     uuid not null references public.sales_order_lines(id) on delete cascade,
  seq         int not null check (seq >= 1),
  due_date    date not null,
  qty         numeric(12,2) not null check (qty > 0),
  unique (line_id, seq)
);
alter table public.sales_order_schedules enable row level security;
create policy sales_order_schedules_select on public.sales_order_schedules for select to authenticated
  using (company_id = private.current_company() and private.has_perm('orders.read'));
grant select on public.sales_order_schedules to authenticated;

create function private.schedule_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if coalesce(current_setting('orders.rpc', true), 'off') <> 'on' then raise exception 'ORDER_LOCKED' using errcode = '55000'; end if;
  return coalesce(new, old);
end $$;
create trigger sales_order_schedules_guard before insert or update or delete on public.sales_order_schedules
  for each row execute function private.schedule_guard();

-- ---------------------------------------------------------------------
-- 3. Versions des engagements (ajout seul) : confirmation, modification, annulation
-- ---------------------------------------------------------------------
create table public.sales_order_versions (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null default private.current_company() references public.companies(id),
  order_id     uuid not null references public.sales_orders(id),
  seq          int not null check (seq >= 1),
  label        text not null check (label in ('confirmed', 'amended', 'cancelled')),
  reason       text check (reason is null or length(btrim(reason)) between 5 and 300),
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  snapshot     jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  recorded_by  uuid default auth.uid(),
  recorded_at  timestamptz not null default now(),
  unique (order_id, seq)
);
create trigger sales_order_versions_no_change before update or delete on public.sales_order_versions
  for each row execute function private.append_only_guard();
alter table public.sales_order_versions enable row level security;
create policy sales_order_versions_select on public.sales_order_versions for select to authenticated
  using (company_id = private.current_company() and private.has_perm('orders.read'));
grant select on public.sales_order_versions to authenticated;

create function private.order_snapshot(p_order uuid) returns jsonb
language plpgsql stable set search_path = '' as $$
declare o public.sales_orders%rowtype;
begin
  select * into o from public.sales_orders where id = p_order;
  return jsonb_build_object('code', o.code, 'status', o.status, 'client_id', o.client_id, 'delivery_address', o.delivery_address,
    'lines', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'article_id', l.article_id, 'description', l.description,
        'qty', l.qty, 'unit_price', l.unit_price, 'discount_pct', l.discount_pct, 'due_date', l.due_date,
        'qty_delivered', l.qty_delivered, 'qty_cancelled', l.qty_cancelled) order by l.due_date, l.id)
        from public.sales_order_lines l where l.order_id = o.id), '[]'::jsonb),
    'schedule', coalesce((select jsonb_agg(jsonb_build_object('line_id', s.line_id, 'seq', s.seq, 'due_date', s.due_date, 'qty', s.qty)
        order by s.line_id, s.seq) from public.sales_order_schedules s where s.order_id = o.id), '[]'::jsonb));
end $$;

create function private.order_record_version(p_order uuid, p_label text, p_reason text) returns int
language plpgsql security definer set search_path = '' as $$
declare v_snap jsonb := private.order_snapshot(p_order); v_co uuid; v_seq int;
begin
  select company_id into v_co from public.sales_orders where id = p_order;
  select coalesce(max(seq), 0) + 1 into v_seq from public.sales_order_versions where order_id = p_order;
  insert into public.sales_order_versions (company_id, order_id, seq, label, reason, content_hash, snapshot)
  values (v_co, p_order, v_seq, p_label, nullif(btrim(coalesce(p_reason, '')), ''), private.approval_hash(v_snap), v_snap);
  return v_seq;
end $$;

-- Confirmation : première version (automatique, quel que soit le chemin de confirmation)
create function private.order_confirmed_version() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.status = 'draft' and new.status = 'confirmed' then
    perform private.order_record_version(new.id, 'confirmed', null);
  end if;
  return null;
end $$;
create trigger sales_orders_confirmed_version after update of status on public.sales_orders
  for each row execute function private.order_confirmed_version();

-- ---------------------------------------------------------------------
-- 4. Fonctions de ce lot
-- ---------------------------------------------------------------------
create function public.order_set_delivery_address(p_order uuid, p_address text) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.sales_orders%rowtype; v_addr text := nullif(btrim(coalesce(p_address, '')), '');
begin
  perform private.require_perm('orders.write');
  select * into o from public.sales_orders where id = p_order and company_id = private.current_company() for update;
  if not found then raise exception 'ORDER_NOT_FOUND' using errcode = 'P0002'; end if;
  if o.status not in ('draft', 'confirmed') then raise exception 'ORDER_BAD_STATUS' using errcode = '55000'; end if;
  perform set_config('orders.rpc', 'on', true);
  update public.sales_orders set delivery_address = v_addr where id = o.id;
  perform set_config('orders.rpc', 'off', true);
  perform private.write_audit(o.company_id, 'order.address', 'order', o.id::text, o.code, jsonb_build_object('address', o.delivery_address),
    jsonb_build_object('address', v_addr), '{}'::jsonb, 'rpc');
end $$;
grant execute on function public.order_set_delivery_address(uuid, text) to authenticated, service_role;

-- Échéancier d'une ligne : en brouillon seulement, somme égale à la quantité de la ligne
create function public.order_set_schedule(p_line uuid, p_dates date[], p_qtys numeric[]) returns int
language plpgsql security definer set search_path = '' as $$
declare l public.sales_order_lines%rowtype; o public.sales_orders%rowtype; i int; v_total numeric := 0;
begin
  perform private.require_perm('orders.write');
  select * into l from public.sales_order_lines where id = p_line;
  if not found then raise exception 'ORDER_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into o from public.sales_orders where id = l.order_id and company_id = private.current_company() for update;
  if not found then raise exception 'ORDER_NOT_FOUND' using errcode = 'P0002'; end if;
  if o.status <> 'draft' then raise exception 'ORDER_LOCKED' using errcode = '55000', detail = 'échéancier figé après confirmation'; end if;
  if p_dates is null or p_qtys is null or cardinality(p_dates) = 0 or cardinality(p_dates) <> cardinality(p_qtys) then
    raise exception 'ORDER_SCHEDULE_INVALID' using errcode = '22023';
  end if;
  for i in 1..cardinality(p_qtys) loop
    if p_qtys[i] is null or p_qtys[i] <= 0 or p_dates[i] is null then raise exception 'ORDER_SCHEDULE_INVALID' using errcode = '22023'; end if;
    v_total := v_total + p_qtys[i];
  end loop;
  if v_total <> l.qty then raise exception 'ORDER_SCHEDULE_MISMATCH' using errcode = '22023', detail = 'somme ' || v_total || ' ≠ ' || l.qty; end if;
  perform set_config('orders.rpc', 'on', true);
  delete from public.sales_order_schedules where line_id = l.id;
  for i in 1..cardinality(p_qtys) loop
    insert into public.sales_order_schedules (company_id, order_id, line_id, seq, due_date, qty)
    values (o.company_id, o.id, l.id, i, p_dates[i], p_qtys[i]);
  end loop;
  perform set_config('orders.rpc', 'off', true);
  perform private.write_audit(o.company_id, 'order.schedule', 'order', o.id::text, o.code, null,
    jsonb_build_object('line', l.id, 'parts', cardinality(p_qtys)), '{}'::jsonb, 'rpc');
  return cardinality(p_qtys);
end $$;
grant execute on function public.order_set_schedule(uuid, date[], numeric[]) to authenticated, service_role;

-- Modification d'une ligne après confirmation : nouvelle version ; jamais sous ce qui est déjà livré, annulé ou facturé
create function public.order_amend_line(p_line uuid, p_qty numeric, p_due date, p_reason text) returns int
language plpgsql security definer set search_path = '' as $$
declare l public.sales_order_lines%rowtype; o public.sales_orders%rowtype; v_seq int; v_reason text := btrim(coalesce(p_reason, ''));
begin
  perform private.require_perm('orders.write');
  if length(v_reason) < 5 then raise exception 'ORDER_REASON_REQUIRED' using errcode = '22023'; end if;
  select * into l from public.sales_order_lines where id = p_line for update;
  if not found then raise exception 'ORDER_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into o from public.sales_orders where id = l.order_id and company_id = private.current_company() for update;
  if not found then raise exception 'ORDER_NOT_FOUND' using errcode = 'P0002'; end if;
  if o.status <> 'confirmed' then raise exception 'ORDER_BAD_STATUS' using errcode = '55000'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'ORDER_QTY_INVALID' using errcode = '22023'; end if;
  if p_qty < l.qty_delivered + l.qty_cancelled or p_qty < l.qty_invoiced then
    raise exception 'ORDER_QTY_BELOW_COMMITTED' using errcode = '22023';
  end if;
  if p_qty <> l.qty and exists (select 1 from public.sales_order_schedules where line_id = l.id) then
    raise exception 'ORDER_SCHEDULE_LOCKED' using errcode = '55000', detail = 'échéancier figé après confirmation';
  end if;
  perform set_config('orders.rpc', 'on', true);
  update public.sales_order_lines set qty = p_qty, due_date = coalesce(p_due, due_date) where id = l.id;
  perform set_config('orders.rpc', 'off', true);
  v_seq := private.order_record_version(o.id, 'amended', v_reason);
  perform private.write_audit(o.company_id, 'order.amend', 'order', o.id::text, o.code, jsonb_build_object('qty', l.qty, 'due', l.due_date),
    jsonb_build_object('qty', p_qty, 'due', coalesce(p_due, l.due_date), 'version', v_seq), jsonb_build_object('reason', v_reason), 'rpc');
  return v_seq;
end $$;
grant execute on function public.order_amend_line(uuid, numeric, date, text) to authenticated, service_role;

-- Reliquats : par ligne et total. Reliquat = commandé − livré − annulé.
create function public.order_remaining(p_order uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare o public.sales_orders%rowtype; v_lines jsonb; v_q numeric := 0; v_d numeric := 0; v_c numeric := 0; v_r numeric := 0; v_state text;
begin
  perform private.require_perm('orders.read');
  select * into o from public.sales_orders where id = p_order and company_id = private.current_company();
  if not found then raise exception 'ORDER_NOT_FOUND' using errcode = 'P0002'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('line_id', l.id, 'article_id', l.article_id, 'description', l.description, 'qty', l.qty,
      'delivered', l.qty_delivered, 'cancelled', l.qty_cancelled, 'remaining', l.qty - l.qty_delivered - l.qty_cancelled,
      'invoiced', l.qty_invoiced, 'due_date', l.due_date) order by l.due_date, l.id), '[]'::jsonb),
    coalesce(sum(l.qty), 0), coalesce(sum(l.qty_delivered), 0), coalesce(sum(l.qty_cancelled), 0), coalesce(sum(l.qty - l.qty_delivered - l.qty_cancelled), 0)
    into v_lines, v_q, v_d, v_c, v_r
    from public.sales_order_lines l where l.order_id = o.id;
  v_state := case
    when o.status = 'draft' then 'draft'
    when o.status = 'cancelled' then 'cancelled'
    when v_r = 0 and v_c > 0 then 'closed_with_cancellation'
    when v_r = 0 then 'delivered'
    when v_d > 0 then 'partially_delivered'
    else 'confirmed' end;
  return jsonb_build_object('order_id', o.id, 'code', o.code, 'status', o.status, 'state', v_state,
    'lines', v_lines, 'totals', jsonb_build_object('qty', v_q, 'delivered', v_d, 'cancelled', v_c, 'remaining', v_r));
end $$;
grant execute on function public.order_remaining(uuid) to authenticated, service_role;

-- Annulation motivée. Brouillon : annulation complète. Confirmée : le reliquat est annulé, mais ce qui est livré,
-- consommé en production ou facturé reste dans l'historique (jamais supprimé). Refusée si des expéditions sont en cours.
create function public.order_cancel(p_order uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o public.sales_orders%rowtype; v_reason text := btrim(coalesce(p_reason, '')); v_open int; v_delivered numeric; v_prod_orders int; v_prod_logs int;
  v_full boolean; v_seq int; v_cancelled numeric; l record;
begin
  perform private.require_perm('orders.write');
  if length(v_reason) < 5 then raise exception 'ORDER_REASON_REQUIRED' using errcode = '22023'; end if;
  select * into o from public.sales_orders where id = p_order and company_id = private.current_company() for update;
  if not found then raise exception 'ORDER_NOT_FOUND' using errcode = 'P0002'; end if;
  if o.status not in ('draft', 'confirmed') then raise exception 'ORDER_BAD_STATUS' using errcode = '55000'; end if;
  if o.status = 'draft' then
    perform set_config('orders.rpc', 'on', true);
    update public.sales_orders set status = 'cancelled' where id = o.id;
    perform set_config('orders.rpc', 'off', true);
    perform private.write_audit(o.company_id, 'order.cancel', 'order', o.id::text, o.code, jsonb_build_object('status', 'draft'),
      jsonb_build_object('status', 'cancelled'), jsonb_build_object('reason', v_reason), 'rpc');
    return jsonb_build_object('status', 'cancelled', 'full', true, 'cancelled_qty', 0, 'delivered_qty', 0);
  end if;

  select count(*)::int into v_open from public.shipments s where s.sales_order_id = o.id and s.status in ('preparing', 'picking', 'packed');
  if v_open > 0 then raise exception 'ORDER_HAS_OPEN_SHIPMENTS' using errcode = '55000'; end if;
  select coalesce(sum(qty_delivered), 0) into v_delivered from public.sales_order_lines where order_id = o.id;
  select count(*)::int into v_prod_orders from public.production_orders where sales_order_id = o.id;
  select count(*)::int into v_prod_logs from public.production_logs pl join public.production_orders po on po.id = pl.order_id where po.sales_order_id = o.id;
  v_full := v_delivered = 0 and v_prod_orders = 0 and v_prod_logs = 0;

  perform set_config('orders.rpc', 'on', true);
  v_cancelled := 0;
  for l in select * from public.sales_order_lines where order_id = o.id and qty - qty_delivered - qty_cancelled > 0 loop
    update public.sales_order_lines set qty_cancelled = qty_cancelled + (qty - qty_delivered - qty_cancelled) where id = l.id;
    v_cancelled := v_cancelled + (l.qty - l.qty_delivered - l.qty_cancelled);
  end loop;
  if v_full then update public.sales_orders set status = 'cancelled' where id = o.id; end if;
  perform set_config('orders.rpc', 'off', true);

  v_seq := private.order_record_version(o.id, 'cancelled', v_reason);
  perform private.write_audit(o.company_id, 'order.cancel', 'order', o.id::text, o.code, jsonb_build_object('status', 'confirmed'),
    jsonb_build_object('status', case when v_full then 'cancelled' else 'confirmed' end, 'cancelled_qty', v_cancelled, 'version', v_seq),
    jsonb_build_object('reason', v_reason, 'delivered_qty', v_delivered, 'production_orders_kept', v_prod_orders), 'rpc');
  return jsonb_build_object('status', case when v_full then 'cancelled' else 'confirmed' end, 'full', v_full,
    'cancelled_qty', v_cancelled, 'delivered_qty', v_delivered, 'production_orders_kept', v_prod_orders, 'version', v_seq);
end $$;
grant execute on function public.order_cancel(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 5. Fonctions existantes complétées (même comportement, plus les règles de ce lot)
-- ---------------------------------------------------------------------

-- Statut de commande : l'annulation directe n'est plus possible dès qu'il y a de l'activité (utiliser order_cancel)
create or replace function public.sales_order_set_status(p_order uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.sales_orders%rowtype;
begin
  perform private.require_perm('orders.write');
  if p_status not in ('cancelled', 'delivered') then raise exception 'ORDER_BAD_STATUS' using errcode = '22023'; end if;
  select * into o from public.sales_orders where id = p_order and company_id = private.current_company() for update;
  if not found then raise exception 'ORDER_NOT_FOUND' using errcode = 'P0002'; end if;
  if (p_status = 'cancelled' and o.status not in ('draft', 'confirmed')) or (p_status = 'delivered' and o.status <> 'confirmed') then raise exception 'ORDER_BAD_STATUS' using errcode = '55000'; end if;
  if p_status = 'cancelled' and o.status = 'confirmed' and (
       exists (select 1 from public.sales_order_lines where order_id = o.id and qty_delivered + qty_cancelled > 0)
    or exists (select 1 from public.shipments where sales_order_id = o.id and status <> 'cancelled')
    or exists (select 1 from public.production_orders where sales_order_id = o.id)) then
    raise exception 'ORDER_HAS_ACTIVITY' using errcode = '55000', detail = 'utiliser l’annulation motivée (order_cancel)';
  end if;
  perform set_config('orders.rpc', 'on', true);
  update public.sales_orders set status = p_status where id = p_order;
  perform set_config('orders.rpc', 'off', true);
  perform private.write_audit(o.company_id, case p_status when 'cancelled' then 'order.cancel' else 'order.deliver' end, 'order', o.id::text, o.code,
    jsonb_build_object('status', o.status), jsonb_build_object('status', p_status), '{}'::jsonb, 'rpc');
end $$;

-- Ajout de ligne d'expédition : rattaché à la ligne de commande la plus proche échéance qui a encore du reliquat disponible
create or replace function public.shipment_add_line(p_shipment uuid, p_variant uuid, p_qty int) returns uuid
language plpgsql security definer set search_path = '' as $$
declare s public.shipments%rowtype; v public.product_variants%rowtype; v_article uuid; v_ordered numeric; v_allocated numeric; v_id uuid := gen_random_uuid(); v_line uuid;
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
  -- Reliquat disponible par ligne : commandé − livré − annulé − déjà réservé par les expéditions non clôturées
  select l.id into v_line from public.sales_order_lines l
   where l.order_id = s.sales_order_id and l.article_id = v_article
     and l.qty - l.qty_delivered - l.qty_cancelled - coalesce((
           select sum(sl.qty_requested) from public.shipment_lines sl join public.shipments sh on sh.id = sl.shipment_id
            where sl.order_line_id = l.id and sh.status not in ('cancelled', 'delivered')), 0) >= p_qty
   order by l.due_date, l.created_at, l.id limit 1;
  if v_line is null then raise exception 'ORDER_NO_OPEN_LINE' using errcode = '22023'; end if;
  insert into public.shipment_lines (id, shipment_id, variant_id, qty_requested, unit_price, order_line_id)
  values (v_id, s.id, v.id, p_qty, coalesce(v.price, 0), v_line);
  return v_id;
end $$;

-- Livraison : le livré de chaque ligne de commande est mis à jour une seule fois (transition shipped → delivered)
create or replace function public.shipment_deliver(p_shipment uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare s public.shipments%rowtype;
begin
  perform private.require_perm('shipments.write');
  s := private.shipment_lock(p_shipment);
  if s.status <> 'shipped' then raise exception 'SHIPPING_BAD_STATUS' using errcode = '55000'; end if;
  update public.shipments set status = 'delivered', delivered_at = now() where id = s.id;
  perform set_config('orders.rpc', 'on', true);
  update public.sales_order_lines l set qty_delivered = l.qty_delivered + (
      select coalesce(sum(sl.qty_shipped), 0) from public.shipment_lines sl where sl.shipment_id = s.id and sl.order_line_id = l.id)
   where exists (select 1 from public.shipment_lines sl where sl.shipment_id = s.id and sl.order_line_id = l.id);
  perform set_config('orders.rpc', 'off', true);
  perform private.shipment_event(s.id, 'delivered', null, null);
end $$;

-- Verrouillage : écritures par fonctions uniquement
revoke all on public.sales_order_schedules, public.sales_order_versions from anon;
revoke insert, update, delete, truncate on public.sales_order_schedules, public.sales_order_versions from authenticated;
