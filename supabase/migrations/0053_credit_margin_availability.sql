-- 0053 — Crédit, marge et disponibilité promise
-- Additive. Une fonction remplacée : sales_order_confirm (0010) — même comportement, plus les contrôles crédit et marge.
-- Aucun seuil n'est inventé : sans plafond client, sans coût saisi ou sans minimum de marge paramétré, le contrôle correspondant ne s'applique pas
-- et le résultat le dit (controls.margin.policy = null).
-- Réutilise : dérogations datées et contrôlées (0033, kind « credit_limit » et « price »), encours factures (0012),
-- taux de change validés (0040, private.fx_or_null), stock par variante (0015), reliquats (0052), production (0019).

-- ---------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------

-- Périmètre d'une dérogation de crédit : plafond total de l'encours autorisé (limite client + max_amount)
create table public.credit_derogation_scopes (
  derogation_id uuid primary key references public.derogations(id),
  company_id    uuid not null references public.companies(id),
  client_id     uuid not null references public.clients(id),
  max_amount    numeric(15,2) not null check (max_amount > 0),
  created_at    timestamptz not null default now()
);
create trigger credit_derogation_scopes_no_change before update or delete on public.credit_derogation_scopes
  for each row execute function private.append_only_guard();
alter table public.credit_derogation_scopes enable row level security;
create policy credit_derogation_scopes_select on public.credit_derogation_scopes for select to authenticated
  using (company_id = private.current_company() and (private.has_perm('invoices.read') or private.has_perm('derogations.approve') or private.has_perm('derogations.control')));
grant select on public.credit_derogation_scopes to authenticated;

-- Coût unitaire d'une variante : saisi, daté, ajout seul (aucun coût inventé)
create table public.variant_costs (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null default private.current_company() references public.companies(id),
  variant_id  uuid not null references public.product_variants(id),
  unit_cost   numeric(14,4) not null check (unit_cost >= 0),
  currency    char(3) not null check (currency ~ '^[A-Z]{3}$'),
  set_by      uuid default auth.uid(),
  set_at      timestamptz not null default now()
);
create index variant_costs_latest_idx on public.variant_costs (variant_id, set_at desc);
create trigger variant_costs_no_change before update or delete on public.variant_costs
  for each row execute function private.append_only_guard();
alter table public.variant_costs enable row level security;
create policy variant_costs_select on public.variant_costs for select to authenticated
  using (company_id = private.current_company() and private.has_perm('costs.read'));
grant select on public.variant_costs to authenticated;

-- Politique de marge : minimum paramétré par la société (vide = aucun contrôle de marge)
create table public.margin_policy (
  company_id     uuid primary key default private.current_company() references public.companies(id),
  min_margin_pct numeric(5,2) check (min_margin_pct is null or min_margin_pct between 0 and 99.99),
  updated_by     uuid default auth.uid(),
  updated_at     timestamptz not null default now()
);
alter table public.margin_policy enable row level security;
create policy margin_policy_select on public.margin_policy for select to authenticated
  using (company_id = private.current_company() and private.has_perm('costs.read'));
grant select on public.margin_policy to authenticated;

-- Stock bloqué (quarantaine, non conforme) : n'est jamais promis. Bloqué par la qualité, libéré par une autre personne.
create table public.variant_stock_blocks (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null default private.current_company() references public.companies(id),
  variant_id      uuid not null references public.product_variants(id),
  warehouse_id    uuid not null references public.warehouses(id),
  qty             int not null check (qty > 0),
  reason          text not null check (length(btrim(reason)) between 10 and 300),
  status          text not null default 'active' check (status in ('active', 'released')),
  blocked_by      uuid not null default auth.uid(),
  blocked_at      timestamptz not null default now(),
  released_by     uuid,
  released_at     timestamptz,
  release_reason  text check (release_reason is null or length(btrim(release_reason)) between 10 and 300),
  check (released_by is distinct from blocked_by),
  check ((status = 'active' and released_by is null and released_at is null and release_reason is null)
      or (status = 'released' and released_by is not null and released_at is not null and release_reason is not null))
);
create function private.stock_block_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'APPEND_ONLY' using errcode = '55000'; end if;
  if old.status = 'active' and new.status = 'released'
     and (new.company_id, new.variant_id, new.warehouse_id, new.qty, new.reason, new.blocked_by, new.blocked_at)
       is not distinct from (old.company_id, old.variant_id, old.warehouse_id, old.qty, old.reason, old.blocked_by, old.blocked_at) then
    return new;
  end if;
  raise exception 'APPEND_ONLY' using errcode = '55000';
end $$;
create trigger variant_stock_blocks_guard before update or delete on public.variant_stock_blocks
  for each row execute function private.stock_block_guard();
alter table public.variant_stock_blocks enable row level security;
create policy variant_stock_blocks_select on public.variant_stock_blocks for select to authenticated
  using (company_id = private.current_company() and private.has_perm('stock.read'));
grant select on public.variant_stock_blocks to authenticated;

-- ---------------------------------------------------------------------
-- 2. Stock : blocage et libération
-- ---------------------------------------------------------------------
create function public.stock_block(p_variant uuid, p_warehouse uuid, p_qty int, p_reason text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid; v_free int; v_blocked int;
begin
  perform private.require_perm('quality.write');
  if not exists (select 1 from public.product_variants where id = p_variant and company_id = v_co) then raise exception 'VARIANT_NOT_FOUND' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.warehouses where id = p_warehouse and company_id = v_co) then raise exception 'WAREHOUSE_NOT_FOUND' using errcode = 'P0002'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'STOCK_BLOCK_QTY' using errcode = '22023'; end if;
  select coalesce(qty_on_hand - qty_reserved, 0) into v_free from public.variant_stock where variant_id = p_variant and warehouse_id = p_warehouse;
  select coalesce(sum(qty), 0) into v_blocked from public.variant_stock_blocks where variant_id = p_variant and warehouse_id = p_warehouse and status = 'active';
  -- On ne bloque que du stock libre : le stock réservé à une expédition ne se bloque pas
  if p_qty + v_blocked > coalesce(v_free, 0) then raise exception 'STOCK_BLOCK_EXCEEDS_FREE' using errcode = '22023'; end if;
  insert into public.variant_stock_blocks (company_id, variant_id, warehouse_id, qty, reason)
  values (v_co, p_variant, p_warehouse, p_qty, btrim(p_reason)) returning id into v_id;
  perform private.write_audit(v_co, 'stock.block', 'variant', p_variant::text, btrim(p_reason), null,
    jsonb_build_object('warehouse', p_warehouse, 'qty', p_qty), '{}'::jsonb, 'rpc');
  return v_id;
end $$;
grant execute on function public.stock_block(uuid, uuid, int, text) to authenticated, service_role;

create function public.stock_block_release(p_block uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); b public.variant_stock_blocks%rowtype;
begin
  perform private.require_perm('quality.approve');
  select * into b from public.variant_stock_blocks where id = p_block and company_id = v_co for update;
  if not found then raise exception 'STOCK_BLOCK_NOT_FOUND' using errcode = 'P0002'; end if;
  if b.status <> 'active' then raise exception 'STOCK_BLOCK_BAD_STATUS' using errcode = '55000'; end if;
  if b.blocked_by = auth.uid() then raise exception 'SOD_SELF_APPROVAL' using errcode = '42501', detail = 'stock_block'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 10 then raise exception 'STOCK_BLOCK_REASON_REQUIRED' using errcode = '22023'; end if;
  update public.variant_stock_blocks set status = 'released', released_by = auth.uid(), released_at = now(), release_reason = btrim(p_reason) where id = b.id;
  perform private.write_audit(v_co, 'stock.release', 'variant', b.variant_id::text, b.reason, jsonb_build_object('status', 'active'),
    jsonb_build_object('status', 'released', 'qty', b.qty), jsonb_build_object('reason', btrim(p_reason)), 'rpc');
end $$;
grant execute on function public.stock_block_release(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 3. Positions de stock : utilisable, réservé, bloqué, engagé non prélevé, attendu
--    utilisable = stock − bloqué − réservé − engagé non prélevé ; l'engagé n'est compté qu'une fois
--    (le réservé est déjà dans l'engagé). Ce qui est expédié et non livré a quitté le stock : il n'est plus engagé.
-- ---------------------------------------------------------------------
create function public.stock_position(p_variant uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_on numeric; v_res numeric; v_blk numeric; v_open numeric; v_shipped numeric;
  v_committed numeric; v_raw numeric; v_usable numeric;
begin
  perform private.require_perm('stock.read');
  if not exists (select 1 from public.product_variants where id = p_variant and company_id = v_co) then raise exception 'VARIANT_NOT_FOUND' using errcode = 'P0002'; end if;
  select coalesce(sum(qty_on_hand), 0), coalesce(sum(qty_reserved), 0) into v_on, v_res from public.variant_stock where variant_id = p_variant and company_id = v_co;
  select coalesce(sum(qty), 0) into v_blk from public.variant_stock_blocks where variant_id = p_variant and company_id = v_co and status = 'active';
  select coalesce(sum(l.qty - l.qty_delivered - l.qty_cancelled), 0) into v_open
    from public.sales_order_lines l join public.sales_orders o on o.id = l.order_id
   where l.variant_id = p_variant and o.company_id = v_co and o.status = 'confirmed';
  select coalesce(sum(sl.qty_shipped), 0) into v_shipped
    from public.shipment_lines sl join public.shipments s on s.id = sl.shipment_id
   where sl.variant_id = p_variant and s.company_id = v_co and s.status = 'shipped';
  v_committed := greatest(0, v_open - v_shipped - v_res);
  v_raw := v_on - v_blk - v_res - v_committed;
  v_usable := greatest(0, v_raw);
  return jsonb_build_object('variant_id', p_variant,
    'on_hand', v_on, 'blocked', v_blk, 'reserved', v_res, 'committed_not_picked', v_committed,
    'usable', v_usable, 'over_committed', v_raw < 0,
    'open_order_demand', v_open, 'shipped_not_delivered', v_shipped);
end $$;
grant execute on function public.stock_position(uuid) to authenticated, service_role;

-- Promesse : seul le stock utilisable est promis. Les quantités attendues (production lancée) sont informatives,
-- non ventilées par variante, et ne fondent jamais la promesse.
create function public.promise_check(p_variant uuid, p_qty numeric, p_date date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_pos jsonb; v_article uuid; v_conf numeric; v_plan numeric; v_usable numeric;
begin
  perform private.require_perm('stock.read');
  if p_qty is null or p_qty <= 0 or p_date is null then raise exception 'PROMISE_INVALID' using errcode = '22023'; end if;
  v_pos := public.stock_position(p_variant);
  v_usable := (v_pos->>'usable')::numeric;
  select pm.article_id into v_article from public.product_variants v join public.product_master pm on pm.id = v.product_id where v.id = p_variant;
  select coalesce(sum(greatest(0, po.qty_planned - coalesce(g.good, 0))), 0) into v_conf
    from public.production_orders po
    left join lateral (select sum(qty_good) good from public.production_logs pl where pl.order_id = po.id) g on true
   where po.company_id = v_co and po.article_id = v_article and po.status in ('launched', 'in_progress') and po.planned_end <= p_date;
  select coalesce(sum(greatest(0, po.qty_planned - coalesce(g.good, 0))), 0) into v_plan
    from public.production_orders po
    left join lateral (select sum(qty_good) good from public.production_logs pl where pl.order_id = po.id) g on true
   where po.company_id = v_co and po.article_id = v_article and po.status = 'planned' and po.planned_end <= p_date;
  return jsonb_build_object('variant_id', p_variant, 'requested', p_qty, 'date', p_date,
    'usable_now', v_usable, 'promisable', v_usable >= p_qty, 'shortage', greatest(0, p_qty - v_usable),
    'blocked_excluded', (v_pos->>'blocked')::numeric,
    'expected_confirmed_by_date', v_conf, 'expected_planned_by_date', v_plan,
    'hypotheses', jsonb_build_array(
      'Seul le stock utilisable à ce jour est promis (stock − bloqué − réservé − engagé non prélevé).',
      'Les quantités attendues sont au niveau article (production) : elles sont indiquées, jamais promises.',
      'Une production « planifiée » n’est pas une date confirmée ; seule une production lancée l’est.'));
end $$;
grant execute on function public.promise_check(uuid, numeric, date) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 4. Encours client (factures ouvertes + commandes confirmées non encore facturées), en devise de base
-- ---------------------------------------------------------------------
create function private.client_encours(p_company uuid, p_client uuid, p_on date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_base char(3) := private.base_currency(); r record; v_inv numeric := 0; v_ord numeric := 0; v_no_rate int := 0; v_fx numeric; v_amt numeric;
begin
  for r in select i.total, i.credited_amount, i.paid_amount, i.currency, i.issue_date from public.invoices i
            where i.company_id = p_company and i.client_id = p_client and i.status in ('issued', 'partially_paid') loop
    v_amt := greatest(0, r.total - r.credited_amount - r.paid_amount);
    if v_amt = 0 then continue; end if;
    v_fx := private.fx_or_null(r.currency, coalesce(r.issue_date, p_on), v_base);
    if v_fx is null then v_no_rate := v_no_rate + 1; continue; end if;
    v_inv := v_inv + round(v_amt * v_fx, 2);
  end loop;
  -- Commandes confirmées : seul ce qui n'est pas encore facturé (ni annulé) compte, pour ne pas compter deux fois une facture
  for r in select o.id, o.currency, o.order_date,
             coalesce(sum(greatest(0, l.qty - l.qty_cancelled - l.qty_invoiced) * l.unit_price * (1 - l.discount_pct / 100)), 0) as value
           from public.sales_orders o join public.sales_order_lines l on l.order_id = o.id
           where o.company_id = p_company and o.client_id = p_client and o.status = 'confirmed'
           group by o.id, o.currency, o.order_date loop
    if r.value = 0 then continue; end if;
    v_fx := private.fx_or_null(r.currency, coalesce(r.order_date, p_on), v_base);
    if v_fx is null then v_no_rate := v_no_rate + 1; continue; end if;
    v_ord := v_ord + round(r.value * v_fx, 2);
  end loop;
  return jsonb_build_object('invoices_open', v_inv, 'orders_open', v_ord, 'total', v_inv + v_ord,
    'base_currency', v_base, 'excluded_no_rate', v_no_rate);
end $$;

create function public.client_credit_status(p_client uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_limit numeric; v jsonb;
begin
  if not (private.has_perm('invoices.read') or private.has_perm('orders.read')) then raise exception 'RBAC_FORBIDDEN' using errcode = '42501'; end if;
  select credit_limit into v_limit from public.clients where id = p_client and company_id = v_co;
  if not found then raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0002'; end if;
  v := private.client_encours(v_co, p_client, current_date);
  return v || jsonb_build_object('client_id', p_client, 'credit_limit', v_limit,
    'headroom', case when v_limit is null then null else v_limit - (v->>'total')::numeric end);
end $$;
grant execute on function public.client_credit_status(uuid) to authenticated, service_role;

-- Dérogation de crédit : demande datée (derogation_request, kind credit_limit) + plafond total autorisé
create function public.credit_derogation_request(p_client uuid, p_max_amount numeric, p_motive text, p_valid_until date) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); r jsonb;
begin
  if not exists (select 1 from public.clients where id = p_client and company_id = v_co) then raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0002'; end if;
  if p_max_amount is null or p_max_amount <= 0 then raise exception 'CREDIT_DEROGATION_AMOUNT' using errcode = '22023'; end if;
  r := public.derogation_request('credit_limit', 'client', p_client, p_motive, p_valid_until);
  insert into public.credit_derogation_scopes (derogation_id, company_id, client_id, max_amount)
  values ((r->>'id')::uuid, v_co, p_client, p_max_amount);
  perform private.write_audit(v_co, 'credit.derogation_request', 'client', p_client::text, r->>'number', null,
    jsonb_build_object('max_amount', p_max_amount, 'valid_until', p_valid_until), '{}'::jsonb, 'rpc');
  return r || jsonb_build_object('max_amount', p_max_amount);
end $$;
grant execute on function public.credit_derogation_request(uuid, numeric, text, date) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 5. Contrôles à la confirmation : crédit bloquant, prix sous coût, marge minimale, coût absent
--    Une dérogation effective et tracée lève le blocage (crédit : plafond total élargi ; prix : par commande).
--    Les coûts ne sont jamais renvoyés au demandeur : seul le code du contrôle l'est.
-- ---------------------------------------------------------------------
create function private.order_commitment_check(p_order uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o public.sales_orders%rowtype; v_base char(3) := private.base_currency(); v_limit numeric; v_enc jsonb; v_value numeric := 0; v_fx numeric;
  v_total_after numeric; v_scope record; v_der jsonb := '[]'::jsonb; v_min numeric; v_issues text[] := '{}'; v_pos int; r record; v_cost record;
  v_net numeric; v_price_der uuid; v_margin numeric; v_cost_val numeric; v_credit jsonb := jsonb_build_object('checked', false);
begin
  select * into o from public.sales_orders where id = p_order;
  select coalesce(sum(l.qty * l.unit_price * (1 - l.discount_pct / 100)), 0) into v_value from public.sales_order_lines l where l.order_id = o.id;

  -- Crédit
  select credit_limit into v_limit from public.clients where id = o.client_id;
  if v_limit is not null then
    v_fx := private.fx_or_null(o.currency, o.order_date, v_base);
    if v_fx is null then raise exception 'CREDIT_NO_RATE' using errcode = '55000'; end if;
    v_enc := private.client_encours(o.company_id, o.client_id, o.order_date);
    v_total_after := (v_enc->>'total')::numeric + round(v_value * v_fx, 2);
    if v_total_after > v_limit then
      select s.max_amount, s.derogation_id into v_scope from public.credit_derogation_scopes s
        join public.derogations d on d.id = s.derogation_id
       where s.client_id = o.client_id and s.company_id = o.company_id and d.status = 'controlled' and d.valid_until >= current_date
         and v_total_after <= v_limit + s.max_amount
       order by s.max_amount desc limit 1;
      if not found then raise exception 'CREDIT_BLOCKED' using errcode = '55000'; end if;
      v_der := v_der || jsonb_build_array(jsonb_build_object('control', 'credit', 'derogation', v_scope.derogation_id));
    end if;
    v_credit := jsonb_build_object('checked', true, 'limit', v_limit, 'total_after', v_total_after, 'base_currency', v_base);
  end if;

  -- Prix et marge
  select min_margin_pct into v_min from public.margin_policy where company_id = o.company_id;
  for r in select l.id, l.variant_id, l.unit_price, l.discount_pct, row_number() over (order by l.due_date, l.created_at, l.id) pos
           from public.sales_order_lines l where l.order_id = o.id and l.variant_id is not null loop
    select vc.unit_cost into v_cost_val from public.variant_costs vc where vc.variant_id = r.variant_id order by vc.set_at desc limit 1;
    v_net := r.unit_price * (1 - r.discount_pct / 100);
    if v_cost_val is null then
      if v_min is not null then v_issues := v_issues || ('MARGIN_COST_MISSING:' || r.pos); end if;
    elsif v_net < v_cost_val then
      v_issues := v_issues || ('PRICE_BELOW_COST:' || r.pos);
    elsif v_min is not null and v_net > 0 then
      v_margin := (v_net - v_cost_val) / v_net * 100;
      if v_margin < v_min then v_issues := v_issues || ('MARGIN_BELOW_MIN:' || r.pos); end if;
    end if;
  end loop;
  if cardinality(v_issues) > 0 then
    select d.id into v_price_der from public.derogations d
     where d.company_id = o.company_id and d.kind = 'price' and d.object_type = 'order' and d.object_id = o.id
       and d.status = 'controlled' and d.valid_until >= current_date order by d.requested_at desc limit 1;
    if v_price_der is null then
      raise exception '%', split_part(v_issues[1], ':', 1) using errcode = '55000', detail = array_to_string(v_issues, ', ');
    end if;
    v_der := v_der || jsonb_build_array(jsonb_build_object('control', 'price', 'derogation', v_price_der, 'issues', to_jsonb(v_issues)));
  end if;

  return jsonb_build_object('credit', v_credit, 'margin_policy', v_min, 'price_issues', to_jsonb(v_issues), 'derogations', v_der);
end $$;

-- Confirmation : même comportement qu'avant (0010) + contrôles crédit et marge, tracés dans l'audit
create or replace function public.sales_order_confirm(p_order uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.sales_orders%rowtype; v_controls jsonb;
begin
  perform private.require_perm('orders.confirm');
  select * into o from public.sales_orders where id = p_order and company_id = private.current_company() for update;
  if not found then raise exception 'ORDER_NOT_FOUND' using errcode = 'P0002'; end if;
  if o.status <> 'draft' then raise exception 'ORDER_BAD_STATUS' using errcode = '55000'; end if;
  if not exists (select 1 from public.sales_order_lines where order_id = p_order) then raise exception 'ORDER_EMPTY' using errcode = '55000'; end if;
  v_controls := private.order_commitment_check(p_order);
  perform set_config('orders.rpc', 'on', true);
  update public.sales_orders set status = 'confirmed', confirmed_at = now(), confirmed_by = auth.uid() where id = p_order;
  perform set_config('orders.rpc', 'off', true);
  perform private.write_audit(o.company_id, 'order.confirm', 'order', o.id::text, o.code, null, null, jsonb_build_object('controls', v_controls), 'rpc');
end $$;

-- ---------------------------------------------------------------------
-- 6. Prix, marge : paramétrage (finance)
-- ---------------------------------------------------------------------
create function public.margin_policy_set(p_min_margin_pct numeric) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_old numeric;
begin
  perform private.require_perm('finance.write');
  select min_margin_pct into v_old from public.margin_policy where company_id = v_co;
  insert into public.margin_policy (company_id, min_margin_pct, updated_by, updated_at)
  values (v_co, p_min_margin_pct, auth.uid(), now())
  on conflict (company_id) do update set min_margin_pct = excluded.min_margin_pct, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  perform private.write_audit(v_co, 'margin.policy_set', 'company', v_co::text, 'minimum de marge', jsonb_build_object('min_margin_pct', v_old),
    jsonb_build_object('min_margin_pct', p_min_margin_pct), '{}'::jsonb, 'rpc');
end $$;
grant execute on function public.margin_policy_set(numeric) to authenticated, service_role;

create function public.variant_cost_set(p_variant uuid, p_unit_cost numeric, p_currency char(3)) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid;
begin
  perform private.require_perm('costs.read');
  if not exists (select 1 from public.product_variants where id = p_variant and company_id = v_co) then raise exception 'VARIANT_NOT_FOUND' using errcode = 'P0002'; end if;
  insert into public.variant_costs (company_id, variant_id, unit_cost, currency) values (v_co, p_variant, p_unit_cost, p_currency) returning id into v_id;
  perform private.write_audit(v_co, 'variant.cost_set', 'variant', p_variant::text, p_currency::text, null,
    jsonb_build_object('unit_cost', p_unit_cost), '{}'::jsonb, 'rpc');
  return v_id;
end $$;
grant execute on function public.variant_cost_set(uuid, numeric, char) to authenticated, service_role;

-- Verrouillage : écritures par fonctions uniquement
revoke all on public.credit_derogation_scopes, public.variant_costs, public.margin_policy, public.variant_stock_blocks from anon;
revoke insert, update, delete, truncate on public.credit_derogation_scopes, public.variant_costs, public.margin_policy, public.variant_stock_blocks from authenticated;
