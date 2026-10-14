-- 0073_cutting_lot_genealogy — OF coupe et généalogie des lots : OF figé au lancement (variante, quantités, nomenclature, gamme),
-- réservations rattachées à l'OF, matelas (coupe) consommant des lots matière, sortie des produits finis liée à l'OF,
-- fractionnement de lots avec quantités, traçabilité amont / aval, encours.
--
-- Existant conservé et réutilisé :
--   * OF (0019) : statuts, dates, quantités, temps standard, journal de production (qty_scrap, qty_good).
--   * Figures de nomenclature (0069) et de gamme (0070) : production_order_bom, production_order_routing (déjà figées au lancement).
--   * Lots matière (0009, 0064) : stock_lots (lot_code, expiry_date), mouvements, allocations par lot (stock_movement_allocations) ;
--     consommation FIFO et garde-fous (quarantaine 0063, entrepôt 0017, réservations) via private.stock_apply (0011).
--   * Produits finis (0055) : finished_lots (ajout seul, qty_in immuable), réception finished_lot_receive (stock de variante),
--     expéditions (shipments, shipment_lines, shipment_line_lots) : le lien lot ↔ commande passe par ces tables.
--
-- Règles :
--  * OF figé : après le lancement, quantité, article, variante, temps standard, poste et dates ne changent plus (OF_FROZEN).
--    La variante se renseigne tant que l'OF est planifié ; elle doit appartenir à la fiche produit liée à l'article de l'OF.
--  * Réservation d'OF : une réservation existante peut être rattachée à un OF (stock_reservations.production_order_id)
--    pour la matière de sa nomenclature figée ; le matelas consomme cette réservation si elle couvre la quantité.
--  * Matelas : matière présente dans la nomenclature figée de l'OF ; unité de la matière = mètre ; longueur × couches ×
--    (1 + perte) = quantité consommée ; pièces de tous les matelas de l'OF ≤ quantité de l'OF.
--  * Consommation : un seul passage (planifié → consommé). Elle passe par le mouvement de stock standard : les lots
--    consommés sont enregistrés dans stock_movement_allocations et relus par la traçabilité. Refus (et annulation complète)
--    si un lot consommé est périmé (CUT_EXPIRED_LOT), si le stock est insuffisant, bloqué ou réservé.
--  * Produits finis : la sortie d'un OF crée un lot de produit fini (finished_lot_receive, origine « receipt », référence
--    = numéro d'OF) lié à l'OF ; la quantité sortie ne dépasse pas la quantité de l'OF.
--  * Fractionnement d'un lot de produit fini : le lot d'origine enregistre une sortie (qty_out) et un lot enfant reçoit la
--    quantité (origine « split »). Le transfert est historisé (lot_splits, ajout seul). Aucun mouvement de stock de variante.
--  * Traçabilité : amont (lot matière → matelas → OF → lots produits → expéditions → commandes) et aval inverse.
--  * Encours d'un OF : pièces coupées (matelas consommés) − pièces sorties − rebuts déclarés.
-- Erreurs : OF_FROZEN, OF_VARIANT_REQUIRED, OF_VARIANT_ARTICLE_MISMATCH, PRODUCTION_BAD_STATUS, CUT_* (voir ci-dessous), PRODUCTION_OUTPUT_EXCEEDS_ORDER,
-- LOT_SPLIT_INVALID, LOT_NOT_RELEASED, RBAC_FORBIDDEN, STOCK_* et WAREHOUSE_FORBIDDEN (garde-fous existants).

-- ---------------------------------------------------------------------------
-- 1. OF : variante et geler au lancement
-- ---------------------------------------------------------------------------
alter table public.production_orders
  add column if not exists variant_id uuid references public.product_variants(id),
  add column if not exists frozen_at  timestamptz;

create function private.production_orders_freeze() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.status = 'planned' and new.status <> 'planned' then
    new.frozen_at := coalesce(new.frozen_at, now());
  end if;
  if old.status <> 'planned' and (new.qty_planned, new.article_id, new.variant_id, new.std_minutes_per_unit,
       new.work_center_id, new.planned_start, new.planned_end) is distinct from
      (old.qty_planned, old.article_id, old.variant_id, old.std_minutes_per_unit, old.work_center_id, old.planned_start, old.planned_end) then
    raise exception 'OF_FROZEN' using errcode = '55000';
  end if;
  return new;
end $$;
revoke execute on function private.production_orders_freeze() from public, anon, authenticated;
create trigger production_orders_freeze_bu before update on public.production_orders
  for each row execute function private.production_orders_freeze();

-- Variante d'un OF planifié (variante active de la société)
create function public.production_order_set_variant(p_order uuid, p_variant uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); o public.production_orders%rowtype;
begin
  perform private.require_perm('production.plan');
  select * into o from public.production_orders where id = p_order and company_id = v_co for update;
  if not found then raise exception 'PRODUCTION_ORDER_NOT_FOUND' using errcode = 'P0002'; end if;
  if o.status <> 'planned' then raise exception 'OF_FROZEN' using errcode = '55000'; end if;
  if not exists (select 1 from public.product_variants where id = p_variant and company_id = v_co and active) then
    raise exception 'VARIANT_NOT_FOUND' using errcode = 'P0002';
  end if;
  -- la variante doit appartenir à la fiche produit liée à l'article de l'OF
  if not exists (select 1 from public.product_variants v join public.product_master pm on pm.id = v.product_id
                 where v.id = p_variant and pm.article_id = o.article_id) then
    raise exception 'OF_VARIANT_ARTICLE_MISMATCH' using errcode = '22023';
  end if;
  update public.production_orders set variant_id = p_variant where id = p_order;
  perform private.write_audit(v_co, 'production.order_variant', 'production_order', o.id::text, o.number,
    jsonb_build_object('variant_id', o.variant_id), jsonb_build_object('variant_id', p_variant), '{}'::jsonb, 'rpc');
end $$;

-- ---------------------------------------------------------------------------
-- 2. Réservations rattachées à un OF
-- ---------------------------------------------------------------------------
alter table public.stock_reservations
  add column if not exists production_order_id uuid references public.production_orders(id);
create index if not exists stock_reservations_order_idx on public.stock_reservations (production_order_id) where production_order_id is not null;

-- Rattache une réservation active à un OF lancé : matière de la nomenclature figée uniquement (droit stock.write, entrepôt).
create function public.production_reservation_link(p_reservation uuid, p_order uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); r public.stock_reservations%rowtype; o public.production_orders%rowtype;
begin
  perform private.require_perm('stock.write');
  select * into r from public.stock_reservations where id = p_reservation and company_id = v_co for update;
  if not found then raise exception 'STOCK_RESERVATION_NOT_FOUND' using errcode = 'P0002'; end if;
  if r.status <> 'active' then raise exception 'MRP_RESERVATION_NOT_ACTIVE' using errcode = '55000'; end if;
  select * into o from public.production_orders where id = p_order and company_id = v_co;
  if not found then raise exception 'PRODUCTION_ORDER_NOT_FOUND' using errcode = 'P0002'; end if;
  if o.status not in ('launched', 'in_progress') then raise exception 'PRODUCTION_BAD_STATUS' using errcode = '55000'; end if;
  if not exists (select 1 from public.production_order_bom b, jsonb_array_elements(b.lines) x
                 where b.order_id = p_order and b.status = 'frozen' and (x ->> 'material_id')::uuid = r.material_id) then
    raise exception 'CUT_MATERIAL_NOT_IN_BOM' using errcode = '22023';
  end if;
  update public.stock_reservations set production_order_id = p_order where id = p_reservation;
  perform private.write_audit(v_co, 'production.reservation_link', 'production_order', o.id::text, o.number, null,
    jsonb_build_object('reservation_id', p_reservation, 'material_id', r.material_id, 'qty', r.qty), '{}'::jsonb, 'rpc');
end $$;

-- ---------------------------------------------------------------------------
-- 3. Produits finis : origine OF et fractionnement
-- ---------------------------------------------------------------------------
alter table public.finished_lots
  add column if not exists production_order_id uuid references public.production_orders(id);
alter table public.finished_lots drop constraint if exists finished_lots_origin_check;
alter table public.finished_lots add constraint finished_lots_origin_check check (origin in ('receipt', 'return', 'split'));

create table public.lot_splits (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id) on delete cascade,
  parent_lot_id   uuid not null references public.finished_lots(id),
  child_lot_id    uuid not null unique references public.finished_lots(id),
  qty             int not null check (qty > 0),
  reason          text check (reason is null or length(reason) <= 300),
  created_at      timestamptz not null default now(),
  created_by      uuid default auth.uid(),
  check (parent_lot_id <> child_lot_id)
);

-- Sortie d'un OF : lot de produit fini lié à l'OF (quantité ≤ quantité de l'OF)
create function public.production_finished_lot_receive(p_order uuid, p_lot_code text, p_warehouse uuid, p_qty int) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); o public.production_orders%rowtype; v_out int; v_lot uuid;
begin
  perform private.require_perm('production.write');
  perform private.require_perm('stock.write');
  select * into o from public.production_orders where id = p_order and company_id = v_co for update;
  if not found then raise exception 'PRODUCTION_ORDER_NOT_FOUND' using errcode = 'P0002'; end if;
  if o.status not in ('launched', 'in_progress') then raise exception 'PRODUCTION_BAD_STATUS' using errcode = '55000'; end if;
  if o.variant_id is null then raise exception 'OF_VARIANT_REQUIRED' using errcode = '55000'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'LOT_QTY_INVALID' using errcode = '22023'; end if;
  select coalesce(sum(qty_in), 0) into v_out from public.finished_lots where production_order_id = p_order and origin = 'receipt';
  if v_out + p_qty > o.qty_planned then raise exception 'PRODUCTION_OUTPUT_EXCEEDS_ORDER' using errcode = '22023'; end if;
  -- réception standard (stock de variante, journal) puis rattachement à l'OF
  v_lot := public.finished_lot_receive(o.variant_id, p_warehouse, p_lot_code, p_qty, o.number);
  update public.finished_lots set production_order_id = p_order where id = v_lot;
  perform private.write_audit(v_co, 'production.output_lot', 'production_order', o.id::text, o.number, null,
    jsonb_build_object('lot_code', p_lot_code, 'qty', p_qty, 'lot_id', v_lot), '{}'::jsonb, 'rpc');
  return v_lot;
end $$;

-- Fractionnement : une quantité du lot d'origine passe dans un lot enfant (transfert historisé, sans mouvement de stock de variante)
create function public.finished_lot_split(p_lot uuid, p_qty int, p_new_code text, p_reason text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); l public.finished_lots%rowtype; v_child uuid := gen_random_uuid(); v_code text := btrim(coalesce(p_new_code, ''));
begin
  perform private.require_perm('production.write');
  perform private.require_perm('stock.write');
  select * into l from public.finished_lots where id = p_lot and company_id = v_co for update;
  if not found then raise exception 'LOT_NOT_FOUND' using errcode = 'P0002'; end if;
  if l.status <> 'released' then raise exception 'LOT_NOT_RELEASED' using errcode = '55000'; end if;
  if p_qty is null or p_qty <= 0 or p_qty > l.qty_in - l.qty_out then raise exception 'LOT_SPLIT_INVALID' using errcode = '22023'; end if;
  if length(v_code) < 2 or length(v_code) > 60 then raise exception 'LOT_CODE_INVALID' using errcode = '22023'; end if;
  update public.finished_lots set qty_out = qty_out + p_qty where id = l.id;
  insert into public.finished_lots (id, company_id, lot_code, variant_id, warehouse_id, qty_in, origin, origin_ref, production_order_id)
    values (v_child, v_co, v_code, l.variant_id, l.warehouse_id, p_qty, 'split', l.lot_code, l.production_order_id);
  insert into public.lot_splits (company_id, parent_lot_id, child_lot_id, qty, reason)
    values (v_co, l.id, v_child, p_qty, nullif(btrim(coalesce(p_reason, '')), ''));
  perform private.write_audit(v_co, 'lot.split', 'finished_lot', l.id::text, l.lot_code, jsonb_build_object('qty_out', l.qty_out),
    jsonb_build_object('qty_out', l.qty_out + p_qty, 'child_lot', v_code, 'child_qty', p_qty), '{}'::jsonb, 'rpc');
  return v_child;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Matelas (coupe)
-- ---------------------------------------------------------------------------
create sequence if not exists public.cut_plan_seq;
create table public.production_cut_plans (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete cascade,
  code              text not null,
  production_order_id uuid not null references public.production_orders(id),
  material_id       uuid not null references public.bom_materials(id),
  warehouse_id      uuid not null references public.warehouses(id),
  marker_length     numeric(10,3) not null check (marker_length > 0 and marker_length <= 500),
  layers            int not null check (layers between 1 and 500),
  pieces_per_layer  int not null check (pieces_per_layer between 1 and 10000),
  waste_pct         numeric(5,2) not null default 0 check (waste_pct >= 0 and waste_pct <= 30),
  required_qty      numeric(14,4) generated always as (marker_length * layers * (1 + waste_pct / 100)) stored,
  status            text not null default 'planned' check (status in ('planned', 'consumed', 'cancelled')),
  movement_id       uuid,
  consumed_qty      numeric(14,4),
  consumed_at       timestamptz,
  consumed_by       uuid,
  cancel_reason     text check (cancel_reason is null or length(cancel_reason) <= 300),
  note              text check (note is null or length(note) <= 300),
  created_at        timestamptz not null default now(),
  created_by        uuid default auth.uid(),
  unique (company_id, code),
  check ((status = 'consumed') = (movement_id is not null))
);
create index production_cut_plans_order_idx on public.production_cut_plans (production_order_id, status);
create index production_cut_plans_movement_idx on public.production_cut_plans (movement_id) where movement_id is not null;

create function private.cut_plan_immutable() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'CUT_APPEND_ONLY' using errcode = '55000'; end if;
  if old.status = 'consumed' or (new.company_id, new.code, new.production_order_id, new.material_id, new.warehouse_id,
      new.marker_length, new.layers, new.pieces_per_layer, new.waste_pct) is distinct from
     (old.company_id, old.code, old.production_order_id, old.material_id, old.warehouse_id,
      old.marker_length, old.layers, old.pieces_per_layer, old.waste_pct) then
    raise exception 'CUT_APPEND_ONLY' using errcode = '55000';
  end if;
  return new;
end $$;
create trigger production_cut_plans_immutable_bud before update or delete on public.production_cut_plans
  for each row execute function private.cut_plan_immutable();

-- Création d'un matelas planifié
create function public.production_cut_plan_create(p_order uuid, p_material uuid, p_warehouse uuid, p_marker_length numeric,
  p_layers int, p_pieces_per_layer int, p_waste_pct numeric default 0, p_note text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); o public.production_orders%rowtype; m public.bom_materials%rowtype; v_id uuid := gen_random_uuid(); v_code text; v_pieces int;
begin
  perform private.require_perm('production.write');
  select * into o from public.production_orders where id = p_order and company_id = v_co for update;
  if not found then raise exception 'PRODUCTION_ORDER_NOT_FOUND' using errcode = 'P0002'; end if;
  if o.status not in ('launched', 'in_progress') then raise exception 'PRODUCTION_BAD_STATUS' using errcode = '55000'; end if;
  select * into m from public.bom_materials where id = p_material and company_id = v_co;
  if not found then raise exception 'STOCK_MATERIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  if lower(btrim(m.unit)) <> 'm' then raise exception 'CUT_UNIT_MISMATCH' using errcode = '22023'; end if;
  if not exists (select 1 from public.production_order_bom b, jsonb_array_elements(b.lines) x
                 where b.order_id = p_order and b.status = 'frozen' and (x ->> 'material_id')::uuid = p_material) then
    raise exception 'CUT_MATERIAL_NOT_IN_BOM' using errcode = '22023';
  end if;
  if not exists (select 1 from public.warehouses where id = p_warehouse and company_id = v_co and archived_at is null) then
    raise exception 'STOCK_WAREHOUSE_NOT_FOUND' using errcode = 'P0002';
  end if;
  select coalesce(sum(layers * pieces_per_layer), 0) into v_pieces from public.production_cut_plans
    where production_order_id = p_order and status <> 'cancelled';
  if v_pieces + p_layers * p_pieces_per_layer > o.qty_planned then raise exception 'CUT_PIECES_EXCEED_ORDER' using errcode = '22023'; end if;
  v_code := 'MAT-' || lpad(nextval('public.cut_plan_seq')::text, 4, '0');
  insert into public.production_cut_plans (id, company_id, code, production_order_id, material_id, warehouse_id, marker_length, layers,
    pieces_per_layer, waste_pct, note)
  values (v_id, v_co, v_code, p_order, p_material, p_warehouse, p_marker_length, p_layers, p_pieces_per_layer, coalesce(p_waste_pct, 0),
    nullif(btrim(coalesce(p_note, '')), ''));
  perform private.write_audit(v_co, 'production.cut_plan_create', 'production_order', o.id::text, o.number, null,
    jsonb_build_object('code', v_code, 'material_id', p_material, 'required_qty', p_marker_length * p_layers * (1 + coalesce(p_waste_pct, 0) / 100)),
    '{}'::jsonb, 'rpc');
  return v_id;
end $$;

-- Consommation d'un matelas : sortie FIFO standard (lots enregistrés), réservation de l'OF utilisée si elle existe
create function public.production_cut_plan_consume(p_plan uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); c public.production_cut_plans%rowtype; o public.production_orders%rowtype;
  v_res uuid; v_mov uuid; v_expired int; v_lots jsonb; v_ref text;
begin
  perform private.require_perm('production.write');
  perform private.require_perm('stock.write');
  select * into c from public.production_cut_plans where id = p_plan and company_id = v_co for update;
  if not found then raise exception 'CUT_NOT_FOUND' using errcode = 'P0002'; end if;
  if c.status <> 'planned' then raise exception 'CUT_BAD_STATUS' using errcode = '55000'; end if;
  select * into o from public.production_orders where id = c.production_order_id;
  if o.status not in ('launched', 'in_progress') then raise exception 'PRODUCTION_BAD_STATUS' using errcode = '55000'; end if;
  select r.id into v_res from public.stock_reservations r
    where r.production_order_id = c.production_order_id and r.material_id = c.material_id and r.warehouse_id = c.warehouse_id
      and r.status = 'active' and r.qty - r.qty_consumed >= c.required_qty
    order by r.created_at limit 1;
  v_ref := 'OF ' || o.number || ' ' || c.code;
  v_mov := private.stock_apply('out', 'out', c.material_id, c.required_qty, c.warehouse_id, null, null, v_ref,
    'Coupe matelas ' || c.code, null, v_res, null);
  -- Un lot périmé ne peut pas être consommé : refus et annulation complète de la sortie
  select count(*) into v_expired from public.stock_movement_allocations a join public.stock_lots l on l.id = a.lot_id
    where a.movement_id = v_mov and l.expiry_date is not null and l.expiry_date < current_date;
  if v_expired > 0 then raise exception 'CUT_EXPIRED_LOT' using errcode = '55000'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('lot_id', l.id, 'lot_code', l.lot_code, 'qty', a.qty, 'expiry_date', l.expiry_date)
           order by l.received_at, l.id), '[]'::jsonb)
  into v_lots
  from public.stock_movement_allocations a join public.stock_lots l on l.id = a.lot_id where a.movement_id = v_mov;
  update public.production_cut_plans set status = 'consumed', movement_id = v_mov, consumed_qty = c.required_qty,
    consumed_at = now(), consumed_by = auth.uid() where id = c.id;
  perform private.write_audit(v_co, 'production.cut_consume', 'production_order', o.id::text, o.number, null,
    jsonb_build_object('code', c.code, 'movement_id', v_mov, 'qty', c.required_qty, 'lots', v_lots), '{}'::jsonb, 'rpc');
  return jsonb_build_object('plan', c.code, 'movement_id', v_mov, 'qty', c.required_qty, 'lots', v_lots);
end $$;

create function public.production_cut_plan_cancel(p_plan uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); c public.production_cut_plans%rowtype;
begin
  perform private.require_perm('production.write');
  if length(btrim(coalesce(p_reason, ''))) < 5 then raise exception 'CUT_REASON_REQUIRED' using errcode = '22023'; end if;
  select * into c from public.production_cut_plans where id = p_plan and company_id = v_co for update;
  if not found then raise exception 'CUT_NOT_FOUND' using errcode = 'P0002'; end if;
  if c.status <> 'planned' then raise exception 'CUT_BAD_STATUS' using errcode = '55000'; end if;
  update public.production_cut_plans set status = 'cancelled', cancel_reason = btrim(p_reason) where id = c.id;
  perform private.write_audit(v_co, 'production.cut_cancel', 'production_order', c.production_order_id::text, c.code, null,
    jsonb_build_object('reason', p_reason), '{}'::jsonb, 'rpc');
end $$;

-- ---------------------------------------------------------------------------
-- 5. Encours d'un OF
-- ---------------------------------------------------------------------------
create function public.production_order_wip(p_order uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); o public.production_orders%rowtype; v_cut int; v_plan int; v_out int; v_scrap numeric;
begin
  perform private.require_perm('production.read');
  select * into o from public.production_orders where id = p_order and company_id = v_co;
  if not found then raise exception 'PRODUCTION_ORDER_NOT_FOUND' using errcode = 'P0002'; end if;
  select coalesce(sum(layers * pieces_per_layer) filter (where status = 'consumed'), 0),
         coalesce(sum(layers * pieces_per_layer) filter (where status = 'planned'), 0)
    into v_cut, v_plan from public.production_cut_plans where production_order_id = p_order;
  select coalesce(sum(qty_in), 0) into v_out from public.finished_lots where production_order_id = p_order and origin = 'receipt';
  select coalesce(sum(qty_scrap), 0) into v_scrap from public.production_logs where order_id = p_order;
  return jsonb_build_object('order', o.number, 'qty_planned', o.qty_planned, 'cut_pieces', v_cut, 'cut_pending_pieces', v_plan,
    'output_pieces', v_out, 'scrap', v_scrap, 'wip_pieces', v_cut - v_out - v_scrap,
    'not_cut_pieces', o.qty_planned - v_cut);
end $$;

-- ---------------------------------------------------------------------------
-- 6. Traçabilité
-- ---------------------------------------------------------------------------
-- Amont → aval : d'un lot matière vers les matelas, les OF, les lots produits, les expéditions et les commandes
create function public.lot_trace_material(p_lot uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); l public.stock_lots%rowtype; v_cons jsonb; v_other int; v_fin jsonb; v_ship jsonb;
begin
  perform private.require_perm('production.read');
  select * into l from public.stock_lots where id = p_lot and company_id = v_co;
  if not found then raise exception 'LOT_NOT_FOUND' using errcode = 'P0002'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('plan', c.code, 'movement_id', a.movement_id, 'qty', a.qty,
           'order', o.number, 'order_id', o.id, 'consumed_at', c.consumed_at) order by c.consumed_at), '[]'::jsonb)
  into v_cons
  from public.stock_movement_allocations a
  join public.production_cut_plans c on c.movement_id = a.movement_id
  join public.production_orders o on o.id = c.production_order_id
  where a.lot_id = p_lot;
  -- sorties du lot hors matelas (la réception initiale n'est pas une sortie)
  select count(*) into v_other from public.stock_movement_allocations a
    join public.stock_movements m on m.id = a.movement_id
    where a.lot_id = p_lot and m.direction = 'out' and not exists (select 1 from public.production_cut_plans c where c.movement_id = a.movement_id);
  select coalesce(jsonb_agg(jsonb_build_object('lot_id', f.id, 'lot_code', f.lot_code, 'qty_in', f.qty_in, 'origin', f.origin,
           'order', o.number)), '[]'::jsonb)
  into v_fin
  from public.finished_lots f
  join public.production_orders o on o.id = f.production_order_id
  where f.production_order_id in (select c.production_order_id from public.production_cut_plans c where c.movement_id in
           (select a.movement_id from public.stock_movement_allocations a where a.lot_id = p_lot));
  select coalesce(jsonb_agg(jsonb_build_object('lot_code', f.lot_code, 'shipment', s.number, 'sales_order_id', s.sales_order_id,
           'qty', sll.qty) order by s.number), '[]'::jsonb)
  into v_ship
  from public.shipment_line_lots sll
  join public.finished_lots f on f.id = sll.lot_id
  join public.shipment_lines sl on sl.id = sll.shipment_line_id
  join public.shipments s on s.id = sl.shipment_id
  where f.production_order_id in (select c.production_order_id from public.production_cut_plans c where c.movement_id in
           (select a.movement_id from public.stock_movement_allocations a where a.lot_id = p_lot));
  return jsonb_build_object('material_lot', l.lot_code, 'expiry_date', l.expiry_date, 'remaining', l.qty_remaining,
    'consumptions', v_cons, 'other_movements', v_other, 'finished_lots', v_fin, 'shipments', v_ship);
end $$;

-- Aval → amont : d'un lot produit vers son OF, ses matelas, ses lots matière et ses lots parents (fractionnements)
create function public.lot_trace_finished(p_lot uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); f public.finished_lots%rowtype; v_order text; v_mat jsonb; v_parents jsonb; v_ship jsonb;
begin
  perform private.require_perm('production.read');
  select * into f from public.finished_lots where id = p_lot and company_id = v_co;
  if not found then raise exception 'LOT_NOT_FOUND' using errcode = 'P0002'; end if;
  select o.number into v_order from public.production_orders o where o.id = f.production_order_id;
  select coalesce(jsonb_agg(jsonb_build_object('plan', c.code, 'movement_id', c.movement_id, 'qty', c.consumed_qty,
           'lots', (select coalesce(jsonb_agg(jsonb_build_object('lot_code', sl.lot_code, 'qty', a.qty, 'expiry_date', sl.expiry_date)
                       order by sl.received_at, sl.id), '[]'::jsonb)
                    from public.stock_movement_allocations a join public.stock_lots sl on sl.id = a.lot_id
                    where a.movement_id = c.movement_id))
           order by c.consumed_at), '[]'::jsonb)
  into v_mat
  from public.production_cut_plans c where c.production_order_id = f.production_order_id and c.status = 'consumed';
  select coalesce(jsonb_agg(jsonb_build_object('lot_code', p.lot_code, 'qty', ls.qty)), '[]'::jsonb)
  into v_parents
  from public.lot_splits ls join public.finished_lots p on p.id = ls.parent_lot_id where ls.child_lot_id = p_lot;
  select coalesce(jsonb_agg(jsonb_build_object('shipment', s.number, 'sales_order_id', s.sales_order_id, 'qty', sll.qty)
           order by s.number), '[]'::jsonb)
  into v_ship
  from public.shipment_line_lots sll join public.shipment_lines sl on sl.id = sll.shipment_line_id
  join public.shipments s on s.id = sl.shipment_id where sll.lot_id = p_lot;
  return jsonb_build_object('finished_lot', f.lot_code, 'origin', f.origin, 'qty_in', f.qty_in, 'qty_out', f.qty_out,
    'order', v_order, 'material_consumptions', v_mat, 'split_from', v_parents, 'shipments', v_ship);
end $$;

-- ---------------------------------------------------------------------------
-- 7. Garde-fous des nouvelles tables et privilèges
-- ---------------------------------------------------------------------------
alter table public.lot_splits enable row level security;
alter table public.production_cut_plans enable row level security;
create policy lot_splits_select on public.lot_splits for select to authenticated
  using (company_id = private.current_company() and private.has_perm('production.read'));
create policy production_cut_plans_select on public.production_cut_plans for select to authenticated
  using (company_id = private.current_company() and private.has_perm('production.read'));
revoke all on public.lot_splits, public.production_cut_plans from anon, authenticated;
grant select on public.lot_splits, public.production_cut_plans to authenticated;
grant all on public.lot_splits, public.production_cut_plans to service_role;

revoke execute on function public.production_order_set_variant(uuid, uuid), public.production_reservation_link(uuid, uuid),
  public.production_finished_lot_receive(uuid, text, uuid, int), public.finished_lot_split(uuid, int, text, text),
  public.production_cut_plan_create(uuid, uuid, uuid, numeric, int, int, numeric, text), public.production_cut_plan_consume(uuid),
  public.production_cut_plan_cancel(uuid, text), public.production_order_wip(uuid), public.lot_trace_material(uuid),
  public.lot_trace_finished(uuid) from public, anon;
grant execute on function public.production_order_set_variant(uuid, uuid), public.production_reservation_link(uuid, uuid),
  public.production_finished_lot_receive(uuid, text, uuid, int), public.finished_lot_split(uuid, int, text, text),
  public.production_cut_plan_create(uuid, uuid, uuid, numeric, int, int, numeric, text), public.production_cut_plan_consume(uuid),
  public.production_cut_plan_cancel(uuid, text), public.production_order_wip(uuid), public.lot_trace_material(uuid),
  public.lot_trace_finished(uuid) to authenticated, service_role;
