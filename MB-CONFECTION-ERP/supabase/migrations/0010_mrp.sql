-- =====================================================================
-- 0010_mrp — Moteur MRP
--  Sources : commandes client (socle minimal ci-dessous), prévisions, BOM validées, stock (lots, réservations,
--  stock de sécurité), réceptions planifiées.
--  Calculs : besoin brut (explosion multi-niveaux des BOM validées), besoin net (projection datée),
--  prise en compte du stock de sécurité, MOQ / multiple de commande, délai d'approvisionnement.
--  Sorties : simulations figées (mrp_runs), besoins par composant, suggestions d'achat, alertes de rupture.
--  Permissions nouvelles : mrp.read / mrp.write. Commandes : orders.read / orders.write / orders.confirm (existantes).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Permissions
-- ---------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('mrp.read',  'mrp', 'Voir le MRP', 'Simulations, besoins, suggestions d''achat, alertes de rupture, prévisions'),
  ('mrp.write', 'mrp', 'Gérer le MRP', 'Lancer des simulations, saisir prévisions, paramètres d''approvisionnement et réceptions planifiées, décider des suggestions')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on r.is_system and (
     (r.code = 'admin'      and p.code in ('mrp.read', 'mrp.write'))
  or (r.code = 'direction'  and p.code = 'mrp.read')
  or (r.code = 'commercial' and p.code = 'mrp.read')
  or (r.code = 'achat'      and p.code in ('mrp.read', 'mrp.write'))
  or (r.code = 'production' and p.code in ('mrp.read', 'mrp.write'))
  or (r.code = 'magasin'    and p.code = 'mrp.read'))
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 2. Commandes client (socle minimal : source de la demande du MRP ; le module Commandes l'enrichira)
-- ---------------------------------------------------------------------
create table public.sales_orders (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id),
  code         text not null,                                              -- CMD-0001 (généré)
  client_id    uuid not null references public.clients(id),
  client_ref   text check (client_ref is null or length(client_ref) <= 60),  -- n° de commande du client
  status       text not null default 'draft' check (status in ('draft','confirmed','delivered','cancelled')),
  order_date   date not null default current_date,
  notes        text check (notes is null or length(notes) <= 1000),
  created_at   timestamptz not null default now(),
  created_by   uuid,
  confirmed_at timestamptz,
  confirmed_by uuid,
  unique (company_id, code)
);
create index sales_orders_idx on public.sales_orders (company_id, status);

create table public.sales_order_lines (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  order_id   uuid not null references public.sales_orders(id) on delete cascade,
  article_id uuid not null references public.articles(id),
  qty        numeric(12,2) not null check (qty > 0 and qty <= 10000000),
  due_date   date not null,                                                -- date de livraison demandée
  note       text check (note is null or length(note) <= 300),
  created_at timestamptz not null default now()
);
create index sales_order_lines_idx on public.sales_order_lines (order_id);
create index sales_order_lines_art_idx on public.sales_order_lines (article_id);

create function private.sales_orders_before() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.company_id := coalesce(new.company_id, private.current_company());
    new.code := 'CMD-' || lpad(private.next_seq(new.company_id, 'sales_order')::text, 4, '0');
    perform private.ged_assert_client_open(new.client_id);
    if not exists (select 1 from public.clients where id = new.client_id and company_id = new.company_id) then raise exception 'ORDER_BAD_CLIENT' using errcode = '22023'; end if;
    new.created_by := auth.uid(); new.status := 'draft'; new.confirmed_at := null; new.confirmed_by := null;
  elsif coalesce(current_setting('orders.rpc', true), 'off') <> 'on' then
    if old.status <> 'draft' then raise exception 'ORDER_LOCKED' using errcode = '55000'; end if;
    if new.client_id is distinct from old.client_id then raise exception 'ORDER_LOCKED' using errcode = '42501'; end if;
  end if;
  new.client_ref := nullif(btrim(coalesce(new.client_ref, '')), '');
  return new;
end $$;
create trigger sales_orders_before_iu before insert or update on public.sales_orders
  for each row execute function private.sales_orders_before();

create function private.sales_order_lines_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare o public.sales_orders%rowtype; a public.articles%rowtype; v_order uuid := coalesce(new.order_id, old.order_id);
begin
  select * into o from public.sales_orders where id = v_order;
  if coalesce(current_setting('orders.rpc', true), 'off') <> 'on' and found and o.status <> 'draft' then raise exception 'ORDER_LOCKED' using errcode = '55000'; end if;
  if tg_op = 'DELETE' then return old; end if;
  if tg_op = 'INSERT' then
    if not found then raise exception 'ORDER_NOT_FOUND' using errcode = 'P0002'; end if;
    new.company_id := o.company_id;
    select * into a from public.articles where id = new.article_id;
    if not found or a.client_id <> o.client_id then raise exception 'ORDER_BAD_ARTICLE' using errcode = '22023'; end if;   -- l'article doit appartenir au client de la commande
    if a.status = 'discontinued' then raise exception 'ORDER_BAD_ARTICLE' using errcode = '22023'; end if;
  end if;
  new.note := nullif(btrim(coalesce(new.note, '')), '');
  return new;
end $$;
create trigger sales_order_lines_before_iud before insert or update or delete on public.sales_order_lines
  for each row execute function private.sales_order_lines_before();

create function public.sales_order_confirm(p_order uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.sales_orders%rowtype;
begin
  perform private.require_perm('orders.confirm');
  select * into o from public.sales_orders where id = p_order and company_id = private.current_company() for update;
  if not found then raise exception 'ORDER_NOT_FOUND' using errcode = 'P0002'; end if;
  if o.status <> 'draft' then raise exception 'ORDER_BAD_STATUS' using errcode = '55000'; end if;
  if not exists (select 1 from public.sales_order_lines where order_id = p_order) then raise exception 'ORDER_EMPTY' using errcode = '55000'; end if;
  perform set_config('orders.rpc', 'on', true);
  update public.sales_orders set status = 'confirmed', confirmed_at = now(), confirmed_by = auth.uid() where id = p_order;
  perform set_config('orders.rpc', 'off', true);
  perform private.write_audit(o.company_id, 'order.confirm', 'order', o.id::text, o.code, null, null, '{}'::jsonb, 'rpc');
end $$;

create function public.sales_order_set_status(p_order uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.sales_orders%rowtype;
begin
  perform private.require_perm('orders.write');
  if p_status not in ('cancelled', 'delivered') then raise exception 'ORDER_BAD_STATUS' using errcode = '22023'; end if;
  select * into o from public.sales_orders where id = p_order and company_id = private.current_company() for update;
  if not found then raise exception 'ORDER_NOT_FOUND' using errcode = 'P0002'; end if;
  if (p_status = 'cancelled' and o.status not in ('draft', 'confirmed')) or (p_status = 'delivered' and o.status <> 'confirmed') then raise exception 'ORDER_BAD_STATUS' using errcode = '55000'; end if;
  perform set_config('orders.rpc', 'on', true);
  update public.sales_orders set status = p_status where id = p_order;
  perform set_config('orders.rpc', 'off', true);
  perform private.write_audit(o.company_id, case p_status when 'cancelled' then 'order.cancel' else 'order.deliver' end, 'order', o.id::text, o.code, jsonb_build_object('status', o.status), jsonb_build_object('status', p_status), '{}'::jsonb, 'rpc');
end $$;

create function private.audit_sales_orders() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.write_audit(new.company_id, 'order.create', 'order', new.id::text, new.code, null,
    jsonb_build_object('code', new.code, 'client', (select name from public.clients where id = new.client_id), 'client_ref', new.client_ref));
  return new;
end $$;
create trigger audit_sales_orders_i after insert on public.sales_orders for each row execute function private.audit_sales_orders();

-- ---------------------------------------------------------------------
-- 3. Prévisions, paramètres d'approvisionnement, réceptions planifiées
-- ---------------------------------------------------------------------
create table public.mrp_forecasts (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id),
  article_id    uuid not null references public.articles(id),
  forecast_date date not null,
  qty           numeric(12,2) not null check (qty > 0 and qty <= 10000000),
  note          text check (note is null or length(note) <= 300),
  created_at    timestamptz not null default now(),
  created_by    uuid
);
create index mrp_forecasts_idx on public.mrp_forecasts (company_id, forecast_date);

create table public.mrp_params (
  material_id     uuid primary key references public.bom_materials(id) on delete cascade,
  company_id      uuid not null references public.companies(id),
  lead_time_days  int check (lead_time_days is null or lead_time_days between 0 and 365),   -- null = délai du fournisseur
  moq             numeric(14,4) not null default 0 check (moq >= 0),                          -- quantité minimale de commande
  order_multiple  numeric(14,4) not null default 0 check (order_multiple >= 0),               -- 0 = pas de multiple
  updated_at      timestamptz not null default now(),
  updated_by      uuid
);

create table public.mrp_scheduled_receipts (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id),
  material_id uuid not null references public.bom_materials(id) on delete cascade,
  qty         numeric(14,4) not null check (qty > 0),
  due_date    date not null,
  reference   text check (reference is null or length(reference) <= 120),                      -- ex. n° de commande d'achat
  created_at  timestamptz not null default now(),
  created_by  uuid
);
create index mrp_receipts_idx on public.mrp_scheduled_receipts (material_id, due_date);

create function private.mrp_inputs_before() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.company_id := coalesce(new.company_id, private.current_company());
    if tg_argv[0] = 'article' then
      if not exists (select 1 from public.articles where id = new.article_id and company_id = new.company_id) then raise exception 'MRP_BAD_ARTICLE' using errcode = '22023'; end if;
    else
      if not exists (select 1 from public.bom_materials where id = new.material_id and company_id = new.company_id) then raise exception 'MRP_BAD_MATERIAL' using errcode = '22023'; end if;
    end if;
    if tg_table_name <> 'mrp_params' then new.created_by := auth.uid(); end if;
  end if;
  if tg_table_name = 'mrp_params' then new.updated_at := now(); new.updated_by := auth.uid(); end if;
  return new;
end $$;
create trigger mrp_forecasts_before_i before insert on public.mrp_forecasts for each row execute function private.mrp_inputs_before('article');
create trigger mrp_receipts_before_i before insert on public.mrp_scheduled_receipts for each row execute function private.mrp_inputs_before('material');
create trigger mrp_params_before_iu before insert or update on public.mrp_params for each row execute function private.mrp_inputs_before('material');

-- ---------------------------------------------------------------------
-- 4. Résultats des simulations (figés)
-- ---------------------------------------------------------------------
create table public.mrp_runs (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  code       text not null,                                               -- MRP-0001
  name       text not null check (length(btrim(name)) between 2 and 160),
  as_of      date not null,
  params     jsonb not null default '{}'::jsonb,
  summary    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  created_by uuid,
  unique (company_id, code)
);

create table public.mrp_run_materials (
  run_id          uuid not null references public.mrp_runs(id) on delete cascade,
  material_id     uuid not null references public.bom_materials(id) on delete cascade,
  company_id      uuid not null references public.companies(id),
  gross           numeric(16,4) not null default 0,       -- besoin brut total sur l'horizon
  on_hand         numeric(16,4) not null default 0,
  reserved        numeric(16,4) not null default 0,
  safety          numeric(16,4) not null default 0,
  receipts        numeric(16,4) not null default 0,       -- réceptions planifiées
  net             numeric(16,4) not null default 0,       -- besoin net (avant arrondi MOQ / multiple)
  suggested       numeric(16,4) not null default 0,       -- quantité à commander (après arrondi)
  lead_time_days  int not null default 0,
  moq             numeric(14,4) not null default 0,
  order_multiple  numeric(14,4) not null default 0,
  supplier_id     uuid references public.suppliers(id) on delete set null,
  first_need_date date,
  shortage_date   date,                                   -- premier jour où le stock projeté (sans achat) devient négatif
  alert           text check (alert in ('critical', 'high', 'low')),
  timeline        jsonb not null default '[]'::jsonb,
  primary key (run_id, material_id)
);
create index mrp_run_materials_alert_idx on public.mrp_run_materials (run_id, alert);

create table public.mrp_run_pegging (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid not null references public.mrp_runs(id) on delete cascade,
  company_id  uuid not null references public.companies(id),
  material_id uuid not null references public.bom_materials(id) on delete cascade,
  need_date   date not null,
  source_type text not null check (source_type in ('order', 'forecast')),
  source_id   uuid not null,
  article_id  uuid not null references public.articles(id) on delete cascade,
  demand_qty  numeric(14,2) not null,
  qty         numeric(16,4) not null
);
create index mrp_run_pegging_idx on public.mrp_run_pegging (run_id, material_id, need_date);

create table public.mrp_run_suggestions (
  id           uuid primary key default gen_random_uuid(),
  run_id       uuid not null references public.mrp_runs(id) on delete cascade,
  company_id   uuid not null references public.companies(id),
  material_id  uuid not null references public.bom_materials(id) on delete cascade,
  supplier_id  uuid references public.suppliers(id) on delete set null,
  qty          numeric(16,4) not null check (qty > 0),
  need_date    date not null,
  release_date date not null,                              -- date limite de commande = besoin − délai
  late         boolean not null default false,             -- date de commande déjà dépassée : la livraison arrivera trop tard
  status       text not null default 'proposed' check (status in ('proposed', 'accepted', 'rejected')),
  note         text check (note is null or length(note) <= 300),
  decided_by   uuid,
  decided_at   timestamptz
);
create index mrp_run_suggestions_idx on public.mrp_run_suggestions (run_id, supplier_id, release_date);

-- ---------------------------------------------------------------------
-- 5. Explosion des BOM validées (multi-niveaux) : besoin en composants pour UNE pièce d'un article
-- ---------------------------------------------------------------------
create function private.mrp_unit_requirements(p_article uuid)
returns table (material_id uuid, qty numeric)
language sql stable security definer set search_path = '' as $$
  with recursive t(version_id, mult, depth) as (
    select b.active_version_id, 1::numeric, 0
    from public.boms b where b.article_id = p_article and b.archived_at is null and b.active_version_id is not null
    union all
    select cb.active_version_id, t.mult * l.quantity, t.depth + 1
    from t
    join public.bom_lines l on l.version_id = t.version_id and l.line_type = 'bom'
    join public.boms cb on cb.id = l.child_bom_id and cb.archived_at is null and cb.active_version_id is not null
    where t.depth < 8
  )
  select l.material_id, sum(t.mult * l.quantity * (1 + l.waste_pct / 100))
  from t join public.bom_lines l on l.version_id = t.version_id and l.line_type = 'material'
  group by l.material_id
$$;
revoke execute on function private.mrp_unit_requirements(uuid) from public, anon, authenticated;

-- Problème de nomenclature d'un article : 'no_bom' (aucune BOM validée) ou 'incomplete' (sous-ensemble non validé / archivé)
create function private.mrp_article_issue(p_article uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.boms b where b.article_id = p_article and b.archived_at is null and b.active_version_id is not null) then return 'no_bom'; end if;
  if exists (
    with recursive t(version_id, depth) as (
      select b.active_version_id, 0 from public.boms b where b.article_id = p_article and b.archived_at is null and b.active_version_id is not null
      union all
      select cb.active_version_id, t.depth + 1 from t
      join public.bom_lines l on l.version_id = t.version_id and l.line_type = 'bom'
      join public.boms cb on cb.id = l.child_bom_id and cb.archived_at is null and cb.active_version_id is not null where t.depth < 8)
    select 1 from t join public.bom_lines l on l.version_id = t.version_id and l.line_type = 'bom'
    join public.boms cb on cb.id = l.child_bom_id where cb.archived_at is not null or cb.active_version_id is null
  ) then return 'incomplete'; end if;
  return null;
end $$;
revoke execute on function private.mrp_article_issue(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 6. Le moteur : simulation MRP
--    p_params : horizon_days (90), offset_days (7 : délai de production avant la livraison), include_forecasts (true),
--               include_draft_orders (false), use_safety (true), default_lead_days (14)
-- ---------------------------------------------------------------------
create function public.mrp_run(p_name text default null, p_params jsonb default '{}'::jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_co uuid := private.current_company(); v_run uuid := gen_random_uuid();
  v_horizon int := least(greatest(coalesce((p_params ->> 'horizon_days')::int, 90), 7), 365);
  v_offset int := least(greatest(coalesce((p_params ->> 'offset_days')::int, 7), 0), 120);
  v_fc boolean := coalesce((p_params ->> 'include_forecasts')::boolean, true);
  v_draft boolean := coalesce((p_params ->> 'include_draft_orders')::boolean, false);
  v_safety boolean := coalesce((p_params ->> 'use_safety')::boolean, true);
  v_deflead int := least(greatest(coalesce((p_params ->> 'default_lead_days')::int, 14), 0), 365);
  v_asof date := current_date; v_end date; v_code text; v_name text;
  m record; ev record; prm public.mrp_params%rowtype;
  v_onhand numeric; v_res numeric; v_safe numeric; v_lead int; v_moq numeric; v_mult numeric; v_sup uuid;
  v_gross numeric; v_rec numeric; v_net numeric; v_sugg numeric; v_first date; v_short date;
  v_proj numeric; v_raw numeric; v_g numeric; v_r numeric; v_plan numeric; v_need numeric; v_tl jsonb; v_alert text; v_late int := 0; v_nsug int := 0;
  v_crit int := 0; v_high int := 0; v_low int := 0; v_warn jsonb; v_n_orders int; v_n_fc int;
begin
  perform private.require_perm('mrp.write');
  v_end := v_asof + v_horizon;
  v_name := coalesce(nullif(btrim(coalesce(p_name, '')), ''), 'Simulation du ' || to_char(now(), 'DD/MM/YYYY HH24:MI'));
  if length(v_name) > 160 then v_name := left(v_name, 160); end if;
  v_code := 'MRP-' || lpad(private.next_seq(v_co, 'mrp_run')::text, 4, '0');

  drop table if exists _mrp_d; drop table if exists _mrp_u;
  create temp table _mrp_d (source_type text, source_id uuid, article_id uuid, qty numeric, need date) on commit drop;
  -- demande : commandes client confirmées (+ brouillons si demandé) puis prévisions
  insert into _mrp_d
  select 'order', l.id, l.article_id, l.qty, greatest(l.due_date - v_offset, v_asof)
  from public.sales_order_lines l join public.sales_orders o on o.id = l.order_id
  where o.company_id = v_co and (o.status = 'confirmed' or (v_draft and o.status = 'draft')) and l.due_date - v_offset <= v_end;
  get diagnostics v_n_orders = row_count;
  if v_fc then
    insert into _mrp_d select 'forecast', f.id, f.article_id, f.qty, greatest(f.forecast_date - v_offset, v_asof)
    from public.mrp_forecasts f where f.company_id = v_co and f.forecast_date - v_offset <= v_end;
    get diagnostics v_n_fc = row_count;
  else v_n_fc := 0; end if;

  create temp table _mrp_u (article_id uuid, material_id uuid, qty numeric) on commit drop;
  insert into _mrp_u select a.article_id, u.material_id, u.qty from (select distinct article_id from _mrp_d) a, lateral private.mrp_unit_requirements(a.article_id) u;

  -- articles de la demande sans nomenclature exploitable
  select coalesce(jsonb_agg(jsonb_build_object('article_id', x.article_id, 'ref', a.internal_ref, 'name', a.name, 'issue', x.issue, 'qty', x.qty) order by a.internal_ref), '[]'::jsonb) into v_warn
  from (select article_id, private.mrp_article_issue(article_id) issue, sum(qty) qty from _mrp_d group by article_id) x
  join public.articles a on a.id = x.article_id where x.issue is not null;

  insert into public.mrp_runs (id, company_id, code, name, as_of, params, created_by)
  values (v_run, v_co, v_code, v_name, v_asof, jsonb_build_object('horizon_days', v_horizon, 'offset_days', v_offset, 'include_forecasts', v_fc,
         'include_draft_orders', v_draft, 'use_safety', v_safety, 'default_lead_days', v_deflead), auth.uid());

  insert into public.mrp_run_pegging (run_id, company_id, material_id, need_date, source_type, source_id, article_id, demand_qty, qty)
  select v_run, v_co, u.material_id, d.need, d.source_type, d.source_id, d.article_id, d.qty, d.qty * u.qty
  from _mrp_d d join _mrp_u u on u.article_id = d.article_id;

  for m in
    select material_id from public.mrp_run_pegging where run_id = v_run
    union select t.material_id from public.stock_thresholds t where v_safety and t.company_id = v_co and t.safety_qty > 0
  loop
    select coalesce(sum(qty_remaining), 0) into v_onhand from public.stock_lots where material_id = m.material_id and company_id = v_co;
    select coalesce(sum(qty - qty_consumed), 0) into v_res from public.stock_reservations where material_id = m.material_id and company_id = v_co and status = 'active';
    select case when v_safety then coalesce(sum(safety_qty), 0) else 0 end into v_safe from public.stock_thresholds where material_id = m.material_id and company_id = v_co;
    select * into prm from public.mrp_params where material_id = m.material_id;
    select supplier_id into v_sup from public.bom_materials where id = m.material_id;
    v_lead := coalesce(prm.lead_time_days, (select lead_time_days from public.suppliers where id = v_sup), v_deflead);
    v_moq := coalesce(prm.moq, 0); v_mult := coalesce(prm.order_multiple, 0);

    v_gross := 0; v_rec := 0; v_net := 0; v_sugg := 0; v_first := null; v_short := null; v_tl := '[]'::jsonb;
    v_proj := v_onhand - v_res; v_raw := v_proj;

    for ev in
      select dt from (
        select v_asof dt
        union select need_date from public.mrp_run_pegging where run_id = v_run and material_id = m.material_id and need_date <= v_end
        union select greatest(due_date, v_asof) from public.mrp_scheduled_receipts where material_id = m.material_id and company_id = v_co and greatest(due_date, v_asof) <= v_end
      ) x order by dt
    loop
      select coalesce(sum(qty), 0) into v_g from public.mrp_run_pegging where run_id = v_run and material_id = m.material_id and need_date = ev.dt;
      select coalesce(sum(qty), 0) into v_r from public.mrp_scheduled_receipts where material_id = m.material_id and company_id = v_co and greatest(due_date, v_asof) = ev.dt;
      v_gross := v_gross + v_g; v_rec := v_rec + v_r;
      if v_g > 0 and v_first is null then v_first := ev.dt; end if;
      v_proj := v_proj + v_r - v_g; v_raw := v_raw + v_r - v_g;
      if v_raw < 0 and v_short is null then v_short := ev.dt; end if;
      v_plan := 0;
      if v_proj < v_safe then
        v_need := v_safe - v_proj; v_net := v_net + v_need; v_plan := v_need;
        if v_moq > 0 then v_plan := greatest(v_plan, v_moq); end if;
        if v_mult > 0 then v_plan := ceil(v_plan / v_mult) * v_mult; end if;
        v_proj := v_proj + v_plan; v_sugg := v_sugg + v_plan;
        insert into public.mrp_run_suggestions (run_id, company_id, material_id, supplier_id, qty, need_date, release_date, late)
        values (v_run, v_co, m.material_id, v_sup, v_plan, ev.dt, ev.dt - v_lead, ev.dt - v_lead < v_asof);
        v_nsug := v_nsug + 1; if ev.dt - v_lead < v_asof then v_late := v_late + 1; end if;
      end if;
      v_tl := v_tl || jsonb_build_object('date', ev.dt, 'gross', v_g, 'receipts', v_r, 'planned', v_plan, 'projected', v_proj);
    end loop;

    v_alert := case when v_short is not null and v_short - v_lead < v_asof then 'critical' when v_short is not null then 'high' when v_sugg > 0 then 'low' end;
    if v_alert = 'critical' then v_crit := v_crit + 1; elsif v_alert = 'high' then v_high := v_high + 1; elsif v_alert = 'low' then v_low := v_low + 1; end if;
    insert into public.mrp_run_materials (run_id, material_id, company_id, gross, on_hand, reserved, safety, receipts, net, suggested, lead_time_days, moq, order_multiple,
                                          supplier_id, first_need_date, shortage_date, alert, timeline)
    values (v_run, m.material_id, v_co, v_gross, v_onhand, v_res, v_safe, v_rec, v_net, v_sugg, v_lead, v_moq, v_mult, v_sup, v_first, v_short, v_alert, v_tl);
  end loop;

  update public.mrp_runs set summary = jsonb_build_object(
      'materials', (select count(*) from public.mrp_run_materials where run_id = v_run),
      'critical', v_crit, 'high', v_high, 'low', v_low, 'suggestions', v_nsug, 'late_suggestions', v_late,
      'orders_lines', v_n_orders, 'forecast_lines', v_n_fc, 'warnings', v_warn)
  where id = v_run;
  perform private.write_audit(v_co, 'mrp.run', 'mrp', v_run::text, v_code, null, null,
    jsonb_build_object('name', v_name, 'critical', v_crit, 'high', v_high, 'suggestions', v_nsug), 'rpc');
  return v_run;
end $$;

create function public.mrp_suggestion_decide(p_suggestion uuid, p_status text, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare s public.mrp_run_suggestions%rowtype; v_code text;
begin
  perform private.require_perm('mrp.write');
  if p_status not in ('proposed', 'accepted', 'rejected') then raise exception 'MRP_BAD_STATUS' using errcode = '22023'; end if;
  select * into s from public.mrp_run_suggestions where id = p_suggestion and company_id = private.current_company() for update;
  if not found then raise exception 'MRP_NOT_FOUND' using errcode = 'P0002'; end if;
  update public.mrp_run_suggestions set status = p_status, note = nullif(btrim(coalesce(p_note, '')), ''),
         decided_by = case when p_status = 'proposed' then null else auth.uid() end, decided_at = case when p_status = 'proposed' then null else now() end
  where id = p_suggestion;
  select code into v_code from public.mrp_runs where id = s.run_id;
  perform private.write_audit(s.company_id, 'mrp.decide', 'mrp', s.run_id::text, v_code, jsonb_build_object('status', s.status), jsonb_build_object('status', p_status),
    jsonb_build_object('material_id', s.material_id, 'qty', s.qty, 'note', p_note), 'rpc');
end $$;

create function public.mrp_run_delete(p_run uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.mrp_runs%rowtype;
begin
  perform private.require_perm('mrp.write');
  select * into r from public.mrp_runs where id = p_run and company_id = private.current_company() for update;
  if not found then raise exception 'MRP_NOT_FOUND' using errcode = 'P0002'; end if;
  delete from public.mrp_runs where id = p_run;
  perform private.write_audit(r.company_id, 'mrp.delete', 'mrp', r.id::text, r.code, null, null, jsonb_build_object('name', r.name), 'rpc');
end $$;

-- ---------------------------------------------------------------------
-- 7. Historique, RLS, privilèges
-- ---------------------------------------------------------------------
create policy audit_logs_select_mrp on public.audit_logs for select to authenticated
  using (((entity_type = 'mrp' and private.has_perm('mrp.read')) or (entity_type = 'order' and private.has_perm('orders.read'))) and company_id = private.current_company());

alter table public.sales_orders enable row level security;
alter table public.sales_order_lines enable row level security;
alter table public.mrp_forecasts enable row level security;
alter table public.mrp_params enable row level security;
alter table public.mrp_scheduled_receipts enable row level security;
alter table public.mrp_runs enable row level security;
alter table public.mrp_run_materials enable row level security;
alter table public.mrp_run_pegging enable row level security;
alter table public.mrp_run_suggestions enable row level security;

revoke all on public.sales_orders, public.sales_order_lines, public.mrp_forecasts, public.mrp_params, public.mrp_scheduled_receipts,
              public.mrp_runs, public.mrp_run_materials, public.mrp_run_pegging, public.mrp_run_suggestions from anon, authenticated;
grant all on public.sales_orders, public.sales_order_lines, public.mrp_forecasts, public.mrp_params, public.mrp_scheduled_receipts,
             public.mrp_runs, public.mrp_run_materials, public.mrp_run_pegging, public.mrp_run_suggestions to service_role;
grant select on public.sales_orders, public.sales_order_lines, public.mrp_forecasts, public.mrp_params, public.mrp_scheduled_receipts,
                public.mrp_runs, public.mrp_run_materials, public.mrp_run_pegging, public.mrp_run_suggestions to authenticated;

grant insert (client_id, client_ref, order_date, notes) on public.sales_orders to authenticated;
grant update (client_ref, order_date, notes) on public.sales_orders to authenticated;
grant insert (order_id, article_id, qty, due_date, note) on public.sales_order_lines to authenticated;
grant update (qty, due_date, note) on public.sales_order_lines to authenticated;
grant delete on public.sales_order_lines to authenticated;
grant insert (article_id, forecast_date, qty, note) on public.mrp_forecasts to authenticated;
grant update (forecast_date, qty, note) on public.mrp_forecasts to authenticated;
grant delete on public.mrp_forecasts to authenticated;
grant insert (material_id, lead_time_days, moq, order_multiple) on public.mrp_params to authenticated;
grant update (lead_time_days, moq, order_multiple) on public.mrp_params to authenticated;
grant insert (material_id, qty, due_date, reference) on public.mrp_scheduled_receipts to authenticated;
grant update (qty, due_date, reference) on public.mrp_scheduled_receipts to authenticated;
grant delete on public.mrp_scheduled_receipts to authenticated;

create policy sales_orders_select on public.sales_orders for select to authenticated using (company_id = private.current_company() and private.has_perm('orders.read'));
create policy sales_orders_insert on public.sales_orders for insert to authenticated with check (company_id = private.current_company() and private.has_perm('orders.write'));
create policy sales_orders_update on public.sales_orders for update to authenticated using (company_id = private.current_company() and private.has_perm('orders.write')) with check (company_id = private.current_company() and private.has_perm('orders.write'));
create policy sales_order_lines_select on public.sales_order_lines for select to authenticated using (company_id = private.current_company() and private.has_perm('orders.read'));
create policy sales_order_lines_insert on public.sales_order_lines for insert to authenticated with check (company_id = private.current_company() and private.has_perm('orders.write'));
create policy sales_order_lines_update on public.sales_order_lines for update to authenticated using (company_id = private.current_company() and private.has_perm('orders.write')) with check (company_id = private.current_company() and private.has_perm('orders.write'));
create policy sales_order_lines_delete on public.sales_order_lines for delete to authenticated using (company_id = private.current_company() and private.has_perm('orders.write'));

do $$
declare t text;
begin
  foreach t in array array['mrp_forecasts', 'mrp_params', 'mrp_scheduled_receipts', 'mrp_runs', 'mrp_run_materials', 'mrp_run_pegging', 'mrp_run_suggestions'] loop
    execute format($f$create policy %I on public.%I for select to authenticated using (company_id = private.current_company() and private.has_perm('mrp.read'))$f$, t || '_select', t);
  end loop;
  foreach t in array array['mrp_forecasts', 'mrp_params', 'mrp_scheduled_receipts'] loop
    execute format($f$create policy %I on public.%I for insert to authenticated with check (company_id = private.current_company() and private.has_perm('mrp.write'))$f$, t || '_insert', t);
    execute format($f$create policy %I on public.%I for update to authenticated using (company_id = private.current_company() and private.has_perm('mrp.write')) with check (company_id = private.current_company() and private.has_perm('mrp.write'))$f$, t || '_update', t);
  end loop;
  foreach t in array array['mrp_forecasts', 'mrp_scheduled_receipts'] loop
    execute format($f$create policy %I on public.%I for delete to authenticated using (company_id = private.current_company() and private.has_perm('mrp.write'))$f$, t || '_delete', t);
  end loop;
end $$;

do $$
declare f text;
begin
  foreach f in array array['sales_order_confirm(uuid)', 'sales_order_set_status(uuid,text)', 'mrp_run(text,jsonb)', 'mrp_suggestion_decide(uuid,text,text)', 'mrp_run_delete(uuid)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
