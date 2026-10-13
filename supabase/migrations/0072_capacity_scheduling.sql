-- 0072_capacity_scheduling — Capacité et ordonnancement : charge par poste et par jour, capacité finie, calendrier de poste,
-- priorité des OF, scénarios de planification comparables, validation distincte, plan versionné.
--
-- Existant conservé (0019, 0070, 0042) :
--   * Ordres de fabrication (0019) : dates, poste, quantité, temps standard par pièce (std_minutes_per_unit), statuts.
--     Seuls les OF « planifié » sont replanifiables ; « lancé » et « en cours » sont des charges figées.
--   * Postes (0019, 0070) : heures par jour, rendement, calendrier (work_centers.calendar_id, 0070).
--   * Calendriers (0042) : jours ouvrés ISO. Sans calendrier, un poste n'a PAS de capacité : aucun calendrier n'est inventé.
--   * Tableau de bord de production (0019, production_dashboard) : conservé tel quel. Son indicateur « surchargé » (plus de
--     20 jours de charge) est une heuristique existante ; le nouveau calcul ne l'utilise pas.
--
-- Règles :
--  * Capacité d'un jour = heures par jour × 60 × rendement, si le jour est ouvré pour le calendrier du poste ; sinon 0 ;
--    sans calendrier (ou calendrier archivé) : capacité absente → statut capacity_missing, jamais une capacité supposée.
--  * Charge figée : les OF lancés ou en cours occupent leur poste sur leur fenêtre, répartis également sur les jours ouvrés.
--  * OF suspendus : hors simulation et hors charge ; leur nombre est indiqué dans le résumé (suspended_excluded), jamais omis en silence.
--  * Simulation à capacité finie : les OF planifiés sont placés un à un, par priorité (1 = la plus haute) puis date planifiée,
--    ou par échéance client si le tri demandé est « due_date ». Un OF ne prend que la capacité libre ; il commence au plus tôt
--    à la date planifiée ou à aujourd'hui. Un OF qui ne tient pas dans l'horizon est « unscheduled », jamais forcé.
--  * Pas de surcharge silencieuse : chaque jour est enregistré (production_capacity_days) avec statut ok / overload /
--    capacity_missing. Une surcharge (charges figées) est comptée dans le résumé et exige un accord explicite à la validation.
--  * Impact client : une échéance client (ligne de commande confirmée du même article) dépassée par la simulation est
--    « client_late » ; si elle ne l'était pas dans le plan de départ, elle est « new_client_late » et exige un accord explicite.
--  * Validation : le valideur ne peut pas être l'auteur du scénario (SOD_SELF_APPROVAL), droit production.approve_plan.
--    Un plan dont les OF ont changé depuis la simulation est refusé (PLAN_STALE) : il faut resimuler.
--  * Plan versionné : chaque validation crée une version numérotée avec les dates avant / après de chaque OF modifié.
--    Les scénarios, lignes, jours de capacité et versions sont immuables ; seule la décision d'un scénario change.
-- Erreurs : SCHEDULE_SORT_INVALID, SCHEDULE_RANGE_INVALID, SCHEDULE_NOT_FOUND, PLAN_BAD_STATUS, PLAN_DECISION_INVALID,
-- PLAN_CLIENT_IMPACT_NOT_ACKNOWLEDGED, PLAN_OVERLOAD_NOT_ACKNOWLEDGED, PLAN_STALE, PRODUCTION_PRIORITY_INVALID,
-- SCHEDULE_RPC_ONLY, SCHEDULE_IMMUTABLE, SOD_SELF_APPROVAL, RBAC_FORBIDDEN.

-- ---------------------------------------------------------------------------
-- 1. Droits
-- ---------------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('production.approve_plan', 'production', 'Valider un plan de production', 'Valider ou refuser un scénario de planification (distinct de son auteur)')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on r.is_system and (
     (r.code = 'admin'     and p.code = 'production.approve_plan')
  or (r.code = 'direction' and p.code = 'production.approve_plan'))
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 2. Priorité des OF (1 = la plus haute, 3 = par défaut)
-- ---------------------------------------------------------------------------
alter table public.production_orders
  add column if not exists priority smallint not null default 3 check (priority between 1 and 5);

-- ---------------------------------------------------------------------------
-- 3. Capacité d'un poste pour un jour (null = calendrier absent : rien n'est supposé)
-- ---------------------------------------------------------------------------
create function private.wc_day_capacity(p_wc uuid, p_day date) returns numeric
language sql stable security definer set search_path = '' as $$
  select case
           when c.id is null then null
           when extract(isodow from p_day)::smallint = any (c.working_days) then w.hours_per_day * 60 * w.efficiency_pct / 100
           else 0
         end
  from public.work_centers w
  left join public.calendars c on c.id = w.calendar_id and c.archived_at is null
  where w.id = p_wc
$$;
revoke execute on function private.wc_day_capacity(uuid, date) from public, anon, authenticated;

-- Répartition égale d'une charge (minutes) sur les jours ouvrés d'une fenêtre. Aucune ligne si la fenêtre n'a pas de jour ouvré.
create function private.production_spread(p_wc uuid, p_start date, p_end date, p_minutes numeric)
returns table (day date, minutes numeric)
language sql stable security definer set search_path = '' as $$
  with d as (
    select g::date as day
    from generate_series(p_start::timestamp, p_end::timestamp, interval '1 day') g
    where coalesce(private.wc_day_capacity(p_wc, g::date), 0) > 0
  )
  select d.day, p_minutes / (select count(*) from d) from d
$$;
revoke execute on function private.production_spread(uuid, date, date, numeric) from public, anon, authenticated;

-- Échéance client d'un OF : plus petite date due d'une ligne de commande confirmée du même article
create function private.order_due(p_sales_order uuid, p_article uuid) returns date
language sql stable security definer set search_path = '' as $$
  select min(l.due_date)
  from public.sales_order_lines l join public.sales_orders so on so.id = l.order_id
  where l.order_id = p_sales_order and l.article_id = p_article and so.status = 'confirmed'
$$;
revoke execute on function private.order_due(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Tables : scénarios, lignes, jours de capacité, versions du plan
-- ---------------------------------------------------------------------------
create table public.production_schedule_scenarios (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id) on delete cascade,
  code            text not null,
  name            text not null check (length(btrim(name)) between 2 and 160),
  status          text not null default 'simulated' check (status in ('simulated', 'validated', 'rejected')),
  params          jsonb not null default '{}'::jsonb,
  summary         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  created_by      uuid,
  decided_at      timestamptz,
  decided_by      uuid,
  decision_note   text check (decision_note is null or length(decision_note) <= 500),
  client_impact_ack boolean not null default false,
  overload_ack      boolean not null default false,
  unique (company_id, code)
);

create table public.production_schedule_lines (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references public.companies(id) on delete cascade,
  scenario_id         uuid not null references public.production_schedule_scenarios(id) on delete cascade,
  order_id            uuid not null references public.production_orders(id) on delete cascade,
  number              text not null,
  work_center_id      uuid references public.work_centers(id),
  status              text not null check (status in ('fixed', 'scheduled', 'unscheduled', 'capacity_missing', 'no_work_center')),
  qty                 numeric(12,2) not null,
  std_minutes_per_unit numeric(10,2) not null,
  priority            smallint not null,
  base_status         text not null,
  base_work_center_id uuid,
  base_start          date not null,
  base_end            date not null,
  sim_start           date,
  sim_end             date,
  delta_days          int,
  client_due          date,
  client_late         boolean not null default false,
  new_client_late     boolean not null default false,
  late_vs_baseline    boolean not null default false,
  rank                int not null,
  unique (scenario_id, order_id)
);
create index production_schedule_lines_scn_idx on public.production_schedule_lines (scenario_id, rank);

create table public.production_capacity_days (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id) on delete cascade,
  scenario_id      uuid not null references public.production_schedule_scenarios(id) on delete cascade,
  work_center_id   uuid not null references public.work_centers(id),
  day              date not null,
  capacity_minutes numeric(12,2),
  load_minutes     numeric(12,2) not null,
  status           text not null check (status in ('ok', 'overload', 'capacity_missing')),
  unique (scenario_id, work_center_id, day)
);

create table public.production_plan_versions (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  version_no  int  not null check (version_no >= 1),
  scenario_id uuid not null unique references public.production_schedule_scenarios(id),
  applied_at  timestamptz not null default now(),
  applied_by  uuid,
  note        text check (note is null or length(note) <= 500),
  changes     jsonb not null default '[]'::jsonb,
  unique (company_id, version_no)
);

-- ---------------------------------------------------------------------------
-- 5. Garde-fous : écritures par fonctions seulement ; lignes, jours et versions immuables
-- ---------------------------------------------------------------------------
create function private.schedule_rpc_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(current_setting('schedule.rpc', true), '') <> 'on' then
    raise exception 'SCHEDULE_RPC_ONLY' using errcode = '42501';
  end if;
  return new;
end $$;

create function private.schedule_immutable() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'SCHEDULE_IMMUTABLE' using errcode = '55000';
end $$;

create trigger production_schedule_scenarios_guard_i before insert or update on public.production_schedule_scenarios
  for each row execute function private.schedule_rpc_guard();
create trigger production_schedule_scenarios_immutable_d before delete on public.production_schedule_scenarios
  for each row execute function private.schedule_immutable();
create trigger production_schedule_lines_guard_i before insert on public.production_schedule_lines
  for each row execute function private.schedule_rpc_guard();
create trigger production_schedule_lines_immutable_ud before update or delete on public.production_schedule_lines
  for each row execute function private.schedule_immutable();
create trigger production_capacity_days_guard_i before insert on public.production_capacity_days
  for each row execute function private.schedule_rpc_guard();
create trigger production_capacity_days_immutable_ud before update or delete on public.production_capacity_days
  for each row execute function private.schedule_immutable();
create trigger production_plan_versions_guard_i before insert on public.production_plan_versions
  for each row execute function private.schedule_rpc_guard();
create trigger production_plan_versions_immutable_ud before update or delete on public.production_plan_versions
  for each row execute function private.schedule_immutable();

-- ---------------------------------------------------------------------------
-- 6. Sécurité des lignes et privilèges
-- ---------------------------------------------------------------------------
alter table public.production_schedule_scenarios enable row level security;
alter table public.production_schedule_lines      enable row level security;
alter table public.production_capacity_days       enable row level security;
alter table public.production_plan_versions       enable row level security;

create policy production_schedule_scenarios_select on public.production_schedule_scenarios for select to authenticated
  using (company_id = private.current_company() and private.has_perm('production.read'));
create policy production_schedule_lines_select on public.production_schedule_lines for select to authenticated
  using (company_id = private.current_company() and private.has_perm('production.read'));
create policy production_capacity_days_select on public.production_capacity_days for select to authenticated
  using (company_id = private.current_company() and private.has_perm('production.read'));
create policy production_plan_versions_select on public.production_plan_versions for select to authenticated
  using (company_id = private.current_company() and private.has_perm('production.read'));

revoke all on public.production_schedule_scenarios, public.production_schedule_lines,
             public.production_capacity_days, public.production_plan_versions from anon, authenticated;
grant select on public.production_schedule_scenarios, public.production_schedule_lines,
                public.production_capacity_days, public.production_plan_versions to authenticated;
grant all on public.production_schedule_scenarios, public.production_schedule_lines,
             public.production_capacity_days, public.production_plan_versions to service_role;

-- ---------------------------------------------------------------------------
-- 7. Priorité d'un OF
-- ---------------------------------------------------------------------------
create function public.production_order_set_priority(p_order uuid, p_priority int) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); o public.production_orders%rowtype;
begin
  perform private.require_perm('production.plan');
  if p_priority is null or p_priority not between 1 and 5 then raise exception 'PRODUCTION_PRIORITY_INVALID' using errcode = '22023'; end if;
  select * into o from public.production_orders where id = p_order and company_id = v_co for update;
  if not found then raise exception 'PRODUCTION_ORDER_NOT_FOUND' using errcode = 'P0002'; end if;
  if o.status = 'done' then raise exception 'PRODUCTION_BAD_STATUS' using errcode = '55000'; end if;
  update public.production_orders set priority = p_priority where id = p_order;
  perform private.write_audit(v_co, 'production.order_priority', 'production_order', o.id::text, o.number,
    jsonb_build_object('priority', o.priority), jsonb_build_object('priority', p_priority), '{}'::jsonb, 'rpc');
end $$;

-- ---------------------------------------------------------------------------
-- 8. Charge atelier par poste et par jour (charges figées + OF planifiés à leurs dates actuelles)
-- ---------------------------------------------------------------------------
create function public.production_load(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_rows jsonb; v_no_wc int; v_no_window int;
begin
  perform private.require_perm('production.read');
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 120 then
    raise exception 'SCHEDULE_RANGE_INVALID' using errcode = '22023';
  end if;
  with fixed as (
    select p.work_center_id as wc, s.day, sum(s.minutes) as minutes
    from public.production_orders p
    cross join lateral private.production_spread(p.work_center_id, p.planned_start, p.planned_end, p.qty_planned * p.std_minutes_per_unit) s
    where p.company_id = v_co and p.status in ('launched', 'in_progress') and p.work_center_id is not null
    group by p.work_center_id, s.day
  ),
  planned as (
    select p.work_center_id as wc, s.day, sum(s.minutes) as minutes
    from public.production_orders p
    cross join lateral private.production_spread(p.work_center_id, p.planned_start, p.planned_end, p.qty_planned * p.std_minutes_per_unit) s
    where p.company_id = v_co and p.status = 'planned' and p.work_center_id is not null
    group by p.work_center_id, s.day
  ),
  grid as (
    select w.id as wc, w.code, g::date as day
    from public.work_centers w
    cross join generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g
    where w.company_id = v_co and w.active
  ),
  rows_ as (
    select x.code, x.day, x.wc, x.cap, x.committed, x.planned_min
    from (
      select g.wc, g.code, g.day, private.wc_day_capacity(g.wc, g.day) as cap,
             coalesce(f.minutes, 0) as committed, coalesce(pl.minutes, 0) as planned_min
      from grid g
      left join fixed f on f.wc = g.wc and f.day = g.day
      left join planned pl on pl.wc = g.wc and pl.day = g.day
    ) x
    where x.cap is null or x.cap > 0 or x.committed > 0 or x.planned_min > 0
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'work_center_id', r.wc, 'work_center', r.code, 'day', r.day,
      'capacity_minutes', r.cap, 'committed_minutes', r.committed, 'planned_minutes', r.planned_min,
      'load_pct', case when r.cap is null or r.cap = 0 then null else round(100 * (r.committed + r.planned_min) / r.cap, 1) end,
      'status', case when r.cap is null then 'capacity_missing'
                     when r.committed + r.planned_min > r.cap + 0.01 then 'overload' else 'ok' end)
    order by r.code, r.day), '[]'::jsonb)
  into v_rows
  from rows_ r;

  select count(*) into v_no_wc from public.production_orders
    where company_id = v_co and status in ('planned', 'launched', 'in_progress') and work_center_id is null;
  select count(*) into v_no_window from public.production_orders p
    where p.company_id = v_co and p.status in ('planned', 'launched', 'in_progress') and p.work_center_id is not null
      and not exists (select 1 from private.production_spread(p.work_center_id, p.planned_start, p.planned_end, 1));

  return jsonb_build_object('from', p_from, 'to', p_to, 'unit', 'min', 'rows', v_rows,
    'overload_days', (select count(*) from jsonb_array_elements(v_rows) x where x ->> 'status' = 'overload'),
    'capacity_missing_days', (select count(*) from jsonb_array_elements(v_rows) x where x ->> 'status' = 'capacity_missing'),
    'orders_without_work_center', v_no_wc, 'orders_without_capacity_window', v_no_window);
end $$;

-- ---------------------------------------------------------------------------
-- 9. Simulation à capacité finie (crée un scénario ; ne modifie aucun OF)
-- ---------------------------------------------------------------------------
create function public.production_schedule_simulate(p_name text, p_params jsonb default '{}'::jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_co uuid := private.current_company(); v_id uuid := gen_random_uuid(); v_asof date := current_date;
  v_h int := least(greatest(coalesce((p_params ->> 'horizon_days')::int, 120), 1), 365);
  v_sort text := coalesce(nullif(p_params ->> 'sort', ''), 'priority');
  v_end date; v_code text; v_name text; o record; f record;
  v_rel date; v_rem numeric; v_day date; v_cap numeric; v_avail numeric; v_take numeric;
  v_sim_s date; v_sim_e date; v_status text; v_rank int := 0; v_sum jsonb; v_n int;
begin
  perform private.require_perm('production.plan');
  if v_sort not in ('priority', 'due_date') then raise exception 'SCHEDULE_SORT_INVALID' using errcode = '22023'; end if;
  v_end := v_asof + v_h;
  v_name := coalesce(nullif(btrim(coalesce(p_name, '')), ''), 'Simulation du ' || to_char(now(), 'DD/MM/YYYY HH24:MI'));
  if length(v_name) > 160 then v_name := left(v_name, 160); end if;
  v_code := 'PLN-' || lpad(private.next_seq(v_co, 'production_schedule')::text, 4, '0');
  perform set_config('schedule.rpc', 'on', true);

  drop table if exists _sch_used; drop table if exists _sch_try;
  create temp table _sch_used (wc uuid, day date, used numeric, primary key (wc, day)) on commit drop;
  create temp table _sch_try (day date, take numeric) on commit drop;

  insert into public.production_schedule_scenarios (id, company_id, code, name, status, params, created_by)
    values (v_id, v_co, v_code, v_name, 'simulated',
      jsonb_build_object('horizon_days', v_h, 'sort', v_sort, 'asof', v_asof), auth.uid());

  -- 1. Charges figées : OF lancés ou en cours, à leurs dates actuelles
  for f in
    select p.id, p.number, p.status, p.work_center_id, p.qty_planned, p.std_minutes_per_unit, p.planned_start, p.planned_end, p.priority,
           private.order_due(p.sales_order_id, p.article_id) as due
    from public.production_orders p
    where p.company_id = v_co and p.status in ('launched', 'in_progress')
    order by p.planned_start, p.number
  loop
    v_rank := v_rank + 1; v_sim_s := null; v_sim_e := null;
    if f.work_center_id is null then
      v_status := 'no_work_center';
    else
      select count(*) into v_n from private.production_spread(f.work_center_id, f.planned_start, f.planned_end, f.qty_planned * f.std_minutes_per_unit);
      if v_n = 0 then
        v_status := 'capacity_missing';
      else
        v_status := 'fixed';
        insert into _sch_used (wc, day, used)
          select f.work_center_id, s.day, s.minutes from private.production_spread(f.work_center_id, f.planned_start, f.planned_end, f.qty_planned * f.std_minutes_per_unit) s
        on conflict (wc, day) do update set used = _sch_used.used + excluded.used;
        v_sim_s := f.planned_start; v_sim_e := f.planned_end;
      end if;
    end if;
    insert into public.production_schedule_lines (company_id, scenario_id, order_id, number, work_center_id, status, qty, std_minutes_per_unit, priority,
      base_status, base_work_center_id, base_start, base_end, sim_start, sim_end, delta_days, client_due, client_late, new_client_late, late_vs_baseline, rank)
    values (v_co, v_id, f.id, f.number, f.work_center_id, v_status, f.qty_planned, f.std_minutes_per_unit, f.priority,
      f.status, f.work_center_id, f.planned_start, f.planned_end, v_sim_s, v_sim_e,
      case when v_sim_e is null then null else v_sim_e - f.planned_end end, f.due,
      coalesce(v_sim_e > f.due, false), coalesce(v_sim_e > f.due and f.planned_end <= f.due, false), coalesce(v_sim_e > f.planned_end, false), v_rank);
  end loop;

  -- 2. OF planifiés : placés par priorité (ou échéance), dans la capacité libre seulement
  for o in
    select p.id, p.number, p.status, p.work_center_id, p.qty_planned, p.std_minutes_per_unit, p.planned_start, p.planned_end, p.priority,
           private.order_due(p.sales_order_id, p.article_id) as due
    from public.production_orders p
    where p.company_id = v_co and p.status = 'planned'
    order by case when v_sort = 'due_date' then private.order_due(p.sales_order_id, p.article_id) end nulls last,
             p.priority, p.planned_end, p.number
  loop
    v_rank := v_rank + 1; v_sim_s := null; v_sim_e := null; v_status := 'scheduled';
    if o.work_center_id is null then
      v_status := 'no_work_center';
    elsif private.wc_day_capacity(o.work_center_id, v_asof) is null then
      v_status := 'capacity_missing';
    else
      v_rem := o.qty_planned * o.std_minutes_per_unit;
      delete from _sch_try;
      v_day := greatest(v_asof, o.planned_start);
      while v_rem > 0.0001 and v_day <= v_end loop
        v_cap := coalesce(private.wc_day_capacity(o.work_center_id, v_day), 0);
        v_avail := v_cap - coalesce((select u.used from _sch_used u where u.wc = o.work_center_id and u.day = v_day), 0);
        if v_avail > 0 then
          v_take := least(v_avail, v_rem);
          insert into _sch_try values (v_day, v_take);
          v_rem := v_rem - v_take;
          if v_sim_s is null then v_sim_s := v_day; end if;
          v_sim_e := v_day;
        end if;
        v_day := v_day + 1;
      end loop;
      if v_rem > 0.0001 then
        v_status := 'unscheduled'; v_sim_s := null; v_sim_e := null;
      else
        insert into _sch_used (wc, day, used) select o.work_center_id, t.day, t.take from _sch_try t
        on conflict (wc, day) do update set used = _sch_used.used + excluded.used;
      end if;
    end if;
    insert into public.production_schedule_lines (company_id, scenario_id, order_id, number, work_center_id, status, qty, std_minutes_per_unit, priority,
      base_status, base_work_center_id, base_start, base_end, sim_start, sim_end, delta_days, client_due, client_late, new_client_late, late_vs_baseline, rank)
    values (v_co, v_id, o.id, o.number, o.work_center_id, v_status, o.qty_planned, o.std_minutes_per_unit, o.priority,
      o.status, o.work_center_id, o.planned_start, o.planned_end, v_sim_s, v_sim_e,
      case when v_sim_e is null then null else v_sim_e - o.planned_end end, o.due,
      coalesce(v_sim_e > o.due, false), coalesce(v_sim_e > o.due and o.planned_end <= o.due, false), coalesce(v_sim_e > o.planned_end, false), v_rank);
  end loop;

  -- 3. Jours de capacité : charge, capacité, statut (aucune surcharge silencieuse)
  insert into public.production_capacity_days (company_id, scenario_id, work_center_id, day, capacity_minutes, load_minutes, status)
  select v_co, v_id, u.wc, u.day, private.wc_day_capacity(u.wc, u.day), u.used,
    case when private.wc_day_capacity(u.wc, u.day) is null then 'capacity_missing'
         when u.used > private.wc_day_capacity(u.wc, u.day) + 0.01 then 'overload'
         else 'ok' end
  from _sch_used u;

  -- 4. Résumé
  select jsonb_build_object(
      'horizon_days', v_h, 'sort', v_sort, 'orders', count(*),
      'fixed', count(*) filter (where status = 'fixed'),
      'scheduled', count(*) filter (where status = 'scheduled'),
      'unscheduled', count(*) filter (where status = 'unscheduled'),
      'capacity_missing', count(*) filter (where status = 'capacity_missing'),
      'no_work_center', count(*) filter (where status = 'no_work_center'),
      'late_vs_baseline', count(*) filter (where late_vs_baseline),
      'client_late', count(*) filter (where client_late),
      'client_new_late', count(*) filter (where new_client_late),
      'overload_days', (select count(*) from public.production_capacity_days d where d.scenario_id = v_id and d.status = 'overload'),
      'capacity_missing_days', (select count(*) from public.production_capacity_days d where d.scenario_id = v_id and d.status = 'capacity_missing'),
      'suspended_excluded', (select count(*) from public.production_orders x where x.company_id = v_co and x.status = 'suspended'),
      'max_end', max(sim_end))
  into v_sum
  from public.production_schedule_lines where scenario_id = v_id;
  -- scénario mis à jour via la garde (drapeau schedule.rpc déjà posé)
  update public.production_schedule_scenarios set summary = v_sum where id = v_id;

  perform private.write_audit(v_co, 'production.schedule_simulate', 'production_schedule', v_id::text, v_code, null,
    v_sum, jsonb_build_object('sort', v_sort, 'horizon_days', v_h), 'rpc');
  perform set_config('schedule.rpc', 'off', true);
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- 10. Comparaison de deux scénarios
-- ---------------------------------------------------------------------------
create function public.production_schedule_compare(p_a uuid, p_b uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_a jsonb; v_b jsonb; v_orders jsonb;
begin
  perform private.require_perm('production.read');
  select jsonb_build_object('code', code, 'name', name, 'summary', summary) into v_a
    from public.production_schedule_scenarios where id = p_a and company_id = v_co;
  select jsonb_build_object('code', code, 'name', name, 'summary', summary) into v_b
    from public.production_schedule_scenarios where id = p_b and company_id = v_co;
  if v_a is null or v_b is null then raise exception 'SCHEDULE_NOT_FOUND' using errcode = 'P0002'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'number', la.number, 'status_a', la.status, 'status_b', lb.status,
      'baseline_end', la.base_end, 'end_a', la.sim_end, 'end_b', lb.sim_end,
      'delta_b_minus_a', case when la.sim_end is null or lb.sim_end is null then null else lb.sim_end - la.sim_end end,
      'client_due', la.client_due, 'client_late_a', la.client_late, 'client_late_b', lb.client_late)
    order by la.rank), '[]'::jsonb)
  into v_orders
  from public.production_schedule_lines la
  join public.production_schedule_lines lb on lb.order_id = la.order_id and lb.scenario_id = p_b
  where la.scenario_id = p_a;
  return jsonb_build_object('a', v_a, 'b', v_b, 'orders', v_orders);
end $$;

-- ---------------------------------------------------------------------------
-- 11. Validation ou refus d'un scénario (distinct de son auteur) ; validation = nouvelle version du plan
-- ---------------------------------------------------------------------------
create function public.production_schedule_validate(p_scenario uuid, p_decision text, p_note text default null,
  p_client_ack boolean default false, p_overload_ack boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_co uuid := private.current_company(); s public.production_schedule_scenarios%rowtype; v_stale int; v_ver int;
  l record; v_changes jsonb := '[]'::jsonb; v_changed int := 0; v_vid uuid := gen_random_uuid();
begin
  perform private.require_perm('production.approve_plan');
  select * into s from public.production_schedule_scenarios where id = p_scenario and company_id = v_co for update;
  if not found then raise exception 'SCHEDULE_NOT_FOUND' using errcode = 'P0002'; end if;
  if s.status <> 'simulated' then raise exception 'PLAN_BAD_STATUS' using errcode = '55000'; end if;
  if s.created_by is not distinct from auth.uid() then raise exception 'SOD_SELF_APPROVAL' using errcode = '42501'; end if;
  if p_decision not in ('validate', 'reject') then raise exception 'PLAN_DECISION_INVALID' using errcode = '22023'; end if;
  perform set_config('schedule.rpc', 'on', true);

  if p_decision = 'reject' then
    update public.production_schedule_scenarios set status = 'rejected', decided_at = now(), decided_by = auth.uid(),
      decision_note = nullif(btrim(coalesce(p_note, '')), '') where id = p_scenario;
    perform private.write_audit(v_co, 'production.plan_reject', 'production_schedule', p_scenario::text, s.code, null,
      jsonb_build_object('status', 'rejected'), jsonb_build_object('note', p_note), 'rpc');
    perform set_config('schedule.rpc', 'off', true);
    return jsonb_build_object('status', 'rejected');
  end if;

  if coalesce((s.summary ->> 'client_new_late')::int, 0) > 0 and not p_client_ack then
    raise exception 'PLAN_CLIENT_IMPACT_NOT_ACKNOWLEDGED' using errcode = '55000';
  end if;
  if coalesce((s.summary ->> 'overload_days')::int, 0) > 0 and not p_overload_ack then
    raise exception 'PLAN_OVERLOAD_NOT_ACKNOWLEDGED' using errcode = '55000';
  end if;

  -- Un OF modifié depuis la simulation (statut, poste ou dates) : le scénario n'est plus valable
  select count(*) into v_stale
  from public.production_schedule_lines sl join public.production_orders p on p.id = sl.order_id
  where sl.scenario_id = p_scenario
    and (p.status is distinct from sl.base_status or p.work_center_id is distinct from sl.base_work_center_id
         or p.planned_start is distinct from sl.base_start or p.planned_end is distinct from sl.base_end);
  if v_stale > 0 then raise exception 'PLAN_STALE' using errcode = '55000'; end if;

  -- Application : seuls les OF planifiés et ordonnancés changent de dates
  for l in
    select sl.* from public.production_schedule_lines sl
    where sl.scenario_id = p_scenario and sl.status = 'scheduled'
      and (sl.sim_start is distinct from sl.base_start or sl.sim_end is distinct from sl.base_end)
    order by sl.rank
  loop
    update public.production_orders set planned_start = l.sim_start, planned_end = l.sim_end where id = l.order_id;
    v_changes := v_changes || jsonb_build_object('order_id', l.order_id, 'number', l.number,
      'before', jsonb_build_object('start', l.base_start, 'end', l.base_end),
      'after', jsonb_build_object('start', l.sim_start, 'end', l.sim_end));
    v_changed := v_changed + 1;
  end loop;

  select coalesce(max(version_no), 0) + 1 into v_ver from public.production_plan_versions where company_id = v_co;
  insert into public.production_plan_versions (id, company_id, version_no, scenario_id, applied_by, note, changes)
    values (v_vid, v_co, v_ver, p_scenario, auth.uid(), nullif(btrim(coalesce(p_note, '')), ''), v_changes);

  update public.production_schedule_scenarios set status = 'validated', decided_at = now(), decided_by = auth.uid(),
    decision_note = nullif(btrim(coalesce(p_note, '')), ''), client_impact_ack = p_client_ack, overload_ack = p_overload_ack
    where id = p_scenario;
  perform private.write_audit(v_co, 'production.plan_validate', 'production_schedule', p_scenario::text, s.code, null,
    jsonb_build_object('status', 'validated', 'version_no', v_ver), jsonb_build_object('changed', v_changed, 'note', p_note), 'rpc');
  perform set_config('schedule.rpc', 'off', true);
  return jsonb_build_object('status', 'validated', 'version_no', v_ver, 'changed', v_changed,
    'unscheduled', coalesce((s.summary ->> 'unscheduled')::int, 0));
end $$;

-- ---------------------------------------------------------------------------
-- 12. Privilèges d'exécution
-- ---------------------------------------------------------------------------
revoke execute on function public.production_order_set_priority(uuid, int), public.production_load(date, date),
  public.production_schedule_simulate(text, jsonb), public.production_schedule_compare(uuid, uuid),
  public.production_schedule_validate(uuid, text, text, boolean, boolean) from public, anon;
grant execute on function public.production_order_set_priority(uuid, int), public.production_load(date, date),
  public.production_schedule_simulate(text, jsonb), public.production_schedule_compare(uuid, uuid),
  public.production_schedule_validate(uuid, text, text, boolean, boolean) to authenticated, service_role;
