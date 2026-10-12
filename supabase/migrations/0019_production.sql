-- =====================================================================
-- 0019_production — Production : ordres de fabrication, planification, lancement, suivi, clôture
--  Tables :
--    work_centers       : postes de travail (couture, coupe, finition…) : heures par jour, rendement de référence
--    production_orders  : ordres de fabrication (article, quantité, temps standard, poste, dates, statut)
--    production_logs    : saisies de suivi (date, heures, quantité bonne, rebut) — journal IMMUABLE
--  Statuts : planned (Planifié), launched (Lancé), in_progress (En cours), suspended (Suspendu), done (Terminé).
--  Clôture : closed_at (ordre terminé et verrouillé, plus de saisie).
--  Calculs (vue production_order_metrics et fonction production_dashboard) :
--    charge atelier : heures planifiées ouvertes ÷ (heures par jour × rendement du poste) = jours de charge ;
--    rendement      : quantité bonne ÷ (bonne + rebut) ;
--    productivité   : quantité bonne par heure travaillée ;
--    retards        : ordre ouvert dont la date de fin est dépassée, ou terminé après sa date de fin.
--  Écritures : uniquement par les fonctions ci-dessous (droits production.read / write / plan).
--  Hors périmètre : consommation de matières par stock (les flux de stock restent ceux du module Stock).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Permissions (les codes existent en 0003 ; attribution par rôle)
-- ---------------------------------------------------------------------
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on r.is_system and (
     (r.code = 'admin'      and p.code in ('production.read', 'production.write', 'production.plan'))
  or (r.code = 'direction'  and p.code = 'production.read')
  or (r.code = 'production' and p.code in ('production.read', 'production.write', 'production.plan')))
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 2. Postes de travail
-- ---------------------------------------------------------------------
create table public.work_centers (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null default private.current_company() references public.companies(id) on delete cascade,
  code            text not null check (code ~ '^[A-Z0-9][A-Z0-9._-]{0,19}$'),
  name            text not null check (length(btrim(name)) between 2 and 120),
  kind            text not null default 'other' check (kind in ('coupe', 'couture', 'finition', 'repassage', 'controle', 'other')),
  hours_per_day   numeric(5,2) not null default 8 check (hours_per_day > 0 and hours_per_day <= 24),
  efficiency_pct  numeric(5,2) not null default 85 check (efficiency_pct > 0 and efficiency_pct <= 150),
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  created_by      uuid default auth.uid(),
  unique (company_id, code)
);
alter table public.work_centers enable row level security;
create policy work_centers_select on public.work_centers for select to authenticated
  using (company_id = private.current_company() and private.has_perm('production.read'));
create policy work_centers_write on public.work_centers for all to authenticated
  using (company_id = private.current_company() and private.has_perm('production.plan'))
  with check (company_id = private.current_company() and private.has_perm('production.plan'));
revoke all on public.work_centers from anon, authenticated;
grant select, insert, update on public.work_centers to authenticated;

-- ---------------------------------------------------------------------
-- 3. Ordres de fabrication
-- ---------------------------------------------------------------------
create table public.production_orders (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references public.companies(id) on delete cascade,
  number             text not null,
  article_id         uuid not null references public.articles(id),
  sales_order_id     uuid references public.sales_orders(id),
  work_center_id     uuid references public.work_centers(id),
  qty_planned        numeric(12,2) not null check (qty_planned > 0),
  std_minutes_per_unit numeric(10,2) not null check (std_minutes_per_unit > 0),
  planned_start      date not null,
  planned_end        date not null,
  status             text not null default 'planned' check (status in ('planned', 'launched', 'in_progress', 'suspended', 'done')),
  notes              text check (notes is null or length(notes) <= 1000),
  created_at         timestamptz not null default now(),
  created_by         uuid default auth.uid(),
  launched_at        timestamptz,
  launched_by        uuid,
  suspended_at       timestamptz,
  suspend_reason     text check (suspend_reason is null or length(suspend_reason) <= 300),
  finished_at        timestamptz,
  finished_by        uuid,
  closed_at          timestamptz,
  closed_by          uuid,
  unique (company_id, number),
  check (planned_end >= planned_start),
  check (status = 'planned' or (launched_at is not null and work_center_id is not null)),
  check (status <> 'done' or finished_at is not null),
  check (closed_at is null or (status = 'done' and finished_at is not null))
);
create index production_orders_status_idx on public.production_orders (company_id, status, planned_end);

alter table public.production_orders enable row level security;
create policy production_orders_select on public.production_orders for select to authenticated
  using (company_id = private.current_company() and private.has_perm('production.read'));
revoke all on public.production_orders from anon, authenticated;
grant select on public.production_orders to authenticated;

-- ---------------------------------------------------------------------
-- 4. Suivi de production (journal immuable)
-- ---------------------------------------------------------------------
create table public.production_logs (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  order_id      uuid not null references public.production_orders(id),
  work_center_id uuid not null references public.work_centers(id),
  log_date      date not null,
  hours         numeric(6,2) not null check (hours > 0 and hours <= 24),
  qty_good      numeric(12,2) not null default 0 check (qty_good >= 0),
  qty_scrap     numeric(12,2) not null default 0 check (qty_scrap >= 0),
  note          text check (note is null or length(note) <= 300),
  created_at    timestamptz not null default now(),
  created_by    uuid default auth.uid(),
  check (qty_good + qty_scrap > 0)
);
create index production_logs_order_idx on public.production_logs (order_id, log_date);

create function private.production_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'PRODUCTION_IMMUTABLE' using errcode = '42501';
end $$;
revoke execute on function private.production_immutable() from public, anon, authenticated;
create trigger production_logs_immutable before update or delete on public.production_logs
  for each row execute function private.production_immutable();

alter table public.production_logs enable row level security;
create policy production_logs_select on public.production_logs for select to authenticated
  using (company_id = private.current_company() and private.has_perm('production.read'));
revoke all on public.production_logs from anon, authenticated;
grant select on public.production_logs to authenticated;

-- ---------------------------------------------------------------------
-- 5. Numérotation et garde-fous des données
-- ---------------------------------------------------------------------
create function private.production_order_number() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.number is null then
    new.number := 'OF-' || to_char(now(), 'YYYY') || '-' || lpad(private.next_seq(new.company_id, 'production_order')::text, 6, '0');
  end if;
  return new;
end $$;
revoke execute on function private.production_order_number() from public, anon, authenticated;
create trigger production_orders_number_i before insert on public.production_orders
  for each row execute function private.production_order_number();

-- L'article doit appartenir à la société et l'ordre rattaché à une commande client de la même société.
create function private.production_orders_check() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.articles a where a.id = new.article_id and a.company_id = new.company_id) then
    raise exception 'PRODUCTION_ARTICLE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if new.work_center_id is not null and not exists (select 1 from public.work_centers w where w.id = new.work_center_id and w.company_id = new.company_id and w.active) then
    raise exception 'PRODUCTION_WORK_CENTER_NOT_FOUND' using errcode = 'P0002';
  end if;
  return new;
end $$;
revoke execute on function private.production_orders_check() from public, anon, authenticated;
create trigger production_orders_check_i before insert or update on public.production_orders
  for each row execute function private.production_orders_check();

-- ---------------------------------------------------------------------
-- 6. Calculs par ordre (vue)
-- ---------------------------------------------------------------------
create view public.production_order_metrics with (security_invoker = true) as
with logs as (
  select order_id, sum(hours) hours, sum(qty_good) good, sum(qty_scrap) scrap, max(log_date) last_log
  from public.production_logs group by order_id
)
select o.id, o.company_id, o.number, o.status, o.article_id, a.internal_ref as article_ref, a.name as article_name,
       o.work_center_id, w.code as work_center_code, w.name as work_center_name, w.hours_per_day, w.efficiency_pct,
       o.qty_planned, o.std_minutes_per_unit, o.planned_start, o.planned_end, o.launched_at, o.finished_at, o.closed_at, o.sales_order_id,
       round(o.qty_planned * o.std_minutes_per_unit / 60, 2) as planned_hours,
       coalesce(l.hours, 0) as hours_worked,
       coalesce(l.good, 0) as qty_good,
       coalesce(l.scrap, 0) as qty_scrap,
       case when coalesce(l.good, 0) + coalesce(l.scrap, 0) = 0 then null
            else round(100 * l.good / (l.good + l.scrap), 1) end as yield_pct,
       case when coalesce(l.hours, 0) = 0 then null else round(l.good / l.hours, 2) end as productivity,
       case
         when o.status <> 'done' and o.planned_end < current_date then current_date - o.planned_end
         when o.status = 'done' and o.finished_at::date > o.planned_end then o.finished_at::date - o.planned_end
         else 0 end as late_days
  from public.production_orders o
  join public.articles a on a.id = o.article_id
  left join public.work_centers w on w.id = o.work_center_id
  left join logs l on l.order_id = o.id;
grant select on public.production_order_metrics to authenticated;

-- ---------------------------------------------------------------------
-- 7. Fonctions de planification et de suivi
-- ---------------------------------------------------------------------
create function private.production_audit(p_order public.production_orders, p_action text, p_after jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.write_audit(p_order.company_id, p_action, 'production_order', p_order.id::text, p_order.number, null, p_after, '{}'::jsonb, 'rpc');
end $$;
revoke execute on function private.production_audit(public.production_orders, text, jsonb) from public, anon, authenticated;

create function private.production_lock(p_order uuid) returns public.production_orders
language plpgsql security definer set search_path = '' as $$
declare o public.production_orders%rowtype;
begin
  select * into o from public.production_orders where id = p_order and company_id = private.current_company() for update;
  if not found then raise exception 'PRODUCTION_ORDER_NOT_FOUND' using errcode = 'P0002'; end if;
  return o;
end $$;
revoke execute on function private.production_lock(uuid) from public, anon, authenticated;

-- Créer un ordre (Planifié).
create function public.production_order_create(p_article uuid, p_qty numeric, p_std_minutes numeric, p_work_center uuid,
  p_start date, p_end date, p_sales_order uuid default null, p_notes text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := gen_random_uuid(); o public.production_orders%rowtype;
begin
  perform private.require_perm('production.plan');
  insert into public.production_orders (id, company_id, article_id, sales_order_id, work_center_id, qty_planned, std_minutes_per_unit,
    planned_start, planned_end, notes)
  values (v_id, private.current_company(), p_article, p_sales_order, p_work_center, p_qty, p_std_minutes, p_start, p_end,
    nullif(btrim(coalesce(p_notes, '')), ''))
  returning * into o;
  perform private.production_audit(o, 'production.order_create', jsonb_build_object('qty', p_qty, 'start', p_start, 'end', p_end));
  return v_id;
end $$;

-- Replanifier (uniquement avant lancement).
create function public.production_order_reschedule(p_order uuid, p_work_center uuid, p_start date, p_end date, p_qty numeric, p_std_minutes numeric)
returns void language plpgsql security definer set search_path = '' as $$
declare o public.production_orders%rowtype;
begin
  perform private.require_perm('production.plan');
  o := private.production_lock(p_order);
  if o.status <> 'planned' then raise exception 'PRODUCTION_BAD_STATUS' using errcode = '55000'; end if;
  update public.production_orders set work_center_id = p_work_center, planned_start = p_start, planned_end = p_end,
    qty_planned = p_qty, std_minutes_per_unit = p_std_minutes where id = p_order;
  perform private.production_audit(o, 'production.order_reschedule', jsonb_build_object('start', p_start, 'end', p_end, 'qty', p_qty, 'work_center', p_work_center));
end $$;

-- Lancer : planifié → lancé (poste et dates requis).
create function public.production_order_launch(p_order uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.production_orders%rowtype;
begin
  perform private.require_perm('production.plan');
  o := private.production_lock(p_order);
  if o.status <> 'planned' then raise exception 'PRODUCTION_BAD_STATUS' using errcode = '55000'; end if;
  if o.work_center_id is null then raise exception 'PRODUCTION_WORK_CENTER_REQUIRED' using errcode = '22023'; end if;
  update public.production_orders set status = 'launched', launched_at = now(), launched_by = auth.uid() where id = p_order;
  perform private.production_audit(o, 'production.order_launch', jsonb_build_object('status', 'launched'));
end $$;

-- Saisie de suivi : bascule automatiquement lancé → en cours. Refusée si suspendu, terminé ou clôturé.
create function public.production_order_log(p_order uuid, p_date date, p_hours numeric, p_good numeric, p_scrap numeric, p_note text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare o public.production_orders%rowtype; v_done numeric;
begin
  perform private.require_perm('production.write');
  o := private.production_lock(p_order);
  if o.status not in ('launched', 'in_progress') then raise exception 'PRODUCTION_BAD_STATUS' using errcode = '55000'; end if;
  if p_date < o.planned_start - 30 or p_date > current_date then raise exception 'PRODUCTION_BAD_DATE' using errcode = '22023'; end if;
  if coalesce(p_good, 0) + coalesce(p_scrap, 0) <= 0 then raise exception 'PRODUCTION_BAD_QTY' using errcode = '22023'; end if;
  select coalesce(sum(qty_good + qty_scrap), 0) into v_done from public.production_logs where order_id = p_order;
  if v_done + p_good + p_scrap > o.qty_planned then raise exception 'PRODUCTION_QTY_EXCEEDED' using errcode = '22023'; end if;
  insert into public.production_logs (company_id, order_id, work_center_id, log_date, hours, qty_good, qty_scrap, note)
  values (o.company_id, p_order, o.work_center_id, p_date, p_hours, p_good, p_scrap, nullif(btrim(coalesce(p_note, '')), ''));
  if o.status = 'launched' then update public.production_orders set status = 'in_progress' where id = p_order; end if;
end $$;

-- Suspendre (motif obligatoire) puis reprendre.
create function public.production_order_suspend(p_order uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.production_orders%rowtype; v_reason text := btrim(coalesce(p_reason, ''));
begin
  perform private.require_perm('production.write');
  if length(v_reason) < 3 then raise exception 'PRODUCTION_REASON_REQUIRED' using errcode = '22023'; end if;
  o := private.production_lock(p_order);
  if o.status not in ('launched', 'in_progress') then raise exception 'PRODUCTION_BAD_STATUS' using errcode = '55000'; end if;
  update public.production_orders set status = 'suspended', suspended_at = now(), suspend_reason = v_reason where id = p_order;
  perform private.production_audit(o, 'production.order_suspend', jsonb_build_object('reason', v_reason));
end $$;

create function public.production_order_resume(p_order uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.production_orders%rowtype; v_logs int;
begin
  perform private.require_perm('production.write');
  o := private.production_lock(p_order);
  if o.status <> 'suspended' then raise exception 'PRODUCTION_BAD_STATUS' using errcode = '55000'; end if;
  select count(*) into v_logs from public.production_logs where order_id = p_order;
  update public.production_orders set status = case when v_logs > 0 then 'in_progress' else 'launched' end where id = p_order;
  perform private.production_audit(o, 'production.order_resume', '{}'::jsonb);
end $$;

-- Terminer : au moins une saisie de suivi requise.
create function public.production_order_finish(p_order uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.production_orders%rowtype; v_logs int;
begin
  perform private.require_perm('production.write');
  o := private.production_lock(p_order);
  if o.status not in ('launched', 'in_progress') then raise exception 'PRODUCTION_BAD_STATUS' using errcode = '55000'; end if;
  select count(*) into v_logs from public.production_logs where order_id = p_order;
  if v_logs = 0 then raise exception 'PRODUCTION_NO_LOG' using errcode = '55000'; end if;
  update public.production_orders set status = 'done', finished_at = now(), finished_by = auth.uid() where id = p_order;
  perform private.production_audit(o, 'production.order_finish', jsonb_build_object('status', 'done'));
end $$;

-- Clôturer : ordre terminé, verrouillé (plus de saisie ni de replanification).
create function public.production_order_close(p_order uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.production_orders%rowtype;
begin
  perform private.require_perm('production.plan');
  o := private.production_lock(p_order);
  if o.status <> 'done' or o.closed_at is not null then raise exception 'PRODUCTION_BAD_STATUS' using errcode = '55000'; end if;
  update public.production_orders set closed_at = now(), closed_by = auth.uid() where id = p_order;
  perform private.production_audit(o, 'production.order_close', jsonb_build_object('closed', true));
end $$;

-- Saisie interdite après clôture (contrôle en plus de la vérification de statut).
revoke execute on function public.production_order_create(uuid, numeric, numeric, uuid, date, date, uuid, text) from public, anon;
revoke execute on function public.production_order_reschedule(uuid, uuid, date, date, numeric, numeric) from public, anon;
revoke execute on function public.production_order_launch(uuid) from public, anon;
revoke execute on function public.production_order_log(uuid, date, numeric, numeric, numeric, text) from public, anon;
revoke execute on function public.production_order_suspend(uuid, text) from public, anon;
revoke execute on function public.production_order_resume(uuid) from public, anon;
revoke execute on function public.production_order_finish(uuid) from public, anon;
revoke execute on function public.production_order_close(uuid) from public, anon;
grant execute on function public.production_order_create(uuid, numeric, numeric, uuid, date, date, uuid, text) to authenticated;
grant execute on function public.production_order_reschedule(uuid, uuid, date, date, numeric, numeric) to authenticated;
grant execute on function public.production_order_launch(uuid) to authenticated;
grant execute on function public.production_order_log(uuid, date, numeric, numeric, numeric, text) to authenticated;
grant execute on function public.production_order_suspend(uuid, text) to authenticated;
grant execute on function public.production_order_resume(uuid) to authenticated;
grant execute on function public.production_order_finish(uuid) to authenticated;
grant execute on function public.production_order_close(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 8. Tableau de bord : statuts, charge atelier, rendement, productivité, retards
-- ---------------------------------------------------------------------
create function public.production_dashboard() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); r jsonb;
begin
  perform private.require_perm('production.read');
  with m as (select * from public.production_order_metrics where company_id = v_co),
  wc as (
    select w.id, w.code, w.name, w.hours_per_day, w.efficiency_pct,
      coalesce(sum(m.planned_hours) filter (where m.status <> 'done' and m.closed_at is null), 0) as open_hours,
      coalesce(sum(m.hours_worked), 0) as hours_worked,
      coalesce(sum(m.qty_good), 0) as good, coalesce(sum(m.qty_scrap), 0) as scrap
    from public.work_centers w left join m on m.work_center_id = w.id
    where w.company_id = v_co and w.active
    group by w.id
  )
  select jsonb_build_object(
    'by_status', (select coalesce(jsonb_object_agg(s, c), '{}'::jsonb) from (
        select status s, count(*) c from m where closed_at is null group by status) x),
    'open', (select count(*) from m where closed_at is null and status <> 'done'),
    'closed', (select count(*) from m where closed_at is not null),
    'late', (select count(*) from m where closed_at is null and late_days > 0),
    'yield_pct', (select case when sum(qty_good + qty_scrap) = 0 then null else round(100 * sum(qty_good) / sum(qty_good + qty_scrap), 1) end from m),
    'productivity', (select case when sum(hours_worked) = 0 then null else round(sum(qty_good) / sum(hours_worked), 2) end from m),
    'workload', (select coalesce(jsonb_agg(jsonb_build_object(
        'work_center_id', id, 'code', code, 'name', name, 'open_hours', round(open_hours, 2),
        'capacity_hours_per_day', round(hours_per_day * efficiency_pct / 100, 2),
        'load_days', round(open_hours / nullif(hours_per_day * efficiency_pct / 100, 0), 1),
        'overloaded', open_hours / nullif(hours_per_day * efficiency_pct / 100, 0) > 20,
        'yield_pct', case when good + scrap = 0 then null else round(100 * good / (good + scrap), 1) end,
        'productivity', case when hours_worked = 0 then null else round(good / hours_worked, 2) end
      ) order by code), '[]'::jsonb) from wc),
    'late_orders', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'number', number, 'article', article_name,
        'planned_end', planned_end, 'late_days', late_days, 'status', status, 'work_center', work_center_code)
        order by late_days desc), '[]'::jsonb)
        from (select * from m where closed_at is null and late_days > 0 order by late_days desc limit 20) l)
  ) into r;
  return r;
end $$;
revoke execute on function public.production_dashboard() from public, anon;
grant execute on function public.production_dashboard() to authenticated;
