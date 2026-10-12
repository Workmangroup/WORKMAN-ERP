-- =====================================================================
-- 0020_quality — Qualité : contrôles réception / production / final, défauts, non-conformités,
--                  actions correctives, plans d'actions, indicateurs et historique des défauts
--  Tables :
--    quality_defect_codes        : référentiel des défauts (code, libellé, famille, gravité par défaut)
--    quality_inspections         : contrôles (réception, production, final) : échantillon, décision, quantités
--    quality_defects             : défauts constatés par contrôle — IMMUABLE (historique)
--    quality_nonconformities     : non-conformités (ouvertes automatiquement sur un contrôle rejeté, ou à la main)
--    quality_action_plans        : plans d'actions regroupant des actions correctives
--    quality_corrective_actions  : actions correctives et préventives, avec vérification d'efficacité
--  Règles de décision (quality_inspection_decide) :
--    - un défaut critique impose le rejet ;
--    - un défaut majeur interdit l'acceptation pleine (acceptation conditionnelle ou rejet) ;
--    - rejet : toute la quantité échantillonnée est rebutée, et une non-conformité est ouverte ;
--    - acceptation conditionnelle : rebut estimé = nombre de défauts, plafonné à l'échantillon.
--  Clôture d'une non-conformité : contenue, toutes ses actions vérifiées efficaces (ou annulées),
--    et au moins une action vérifiée, sinon une justification écrite de 10 caractères minimum.
--  Droits : quality.read (voir), quality.write (saisir, ouvrir, constater, proposer), quality.approve (décider, clôturer, vérifier).
--  Hors périmètre : blocage automatique des lots de stock et des réceptions (le module Stock reste inchangé).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Permissions (codes existants en 0003)
-- ---------------------------------------------------------------------
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on r.is_system and (
     (r.code = 'admin'     and p.code in ('quality.read', 'quality.write', 'quality.approve'))
  or (r.code = 'qualite'   and p.code in ('quality.read', 'quality.write', 'quality.approve'))
  or (r.code = 'direction' and p.code = 'quality.read'))
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 2. Référentiel des défauts
-- ---------------------------------------------------------------------
create table public.quality_defect_codes (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null default private.current_company() references public.companies(id) on delete cascade,
  code             text not null check (code ~ '^[A-Z0-9][A-Z0-9._-]{0,19}$'),
  label            text not null check (length(btrim(label)) between 2 and 120),
  category         text not null default 'autre' check (category in ('matiere', 'coupe', 'couture', 'finition', 'dimension', 'etiquetage', 'autre')),
  default_severity text not null default 'minor' check (default_severity in ('minor', 'major', 'critical')),
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  unique (company_id, code)
);
alter table public.quality_defect_codes enable row level security;
create policy quality_defect_codes_select on public.quality_defect_codes for select to authenticated
  using (company_id = private.current_company() and private.has_perm('quality.read'));
revoke all on public.quality_defect_codes from anon, authenticated;
grant select on public.quality_defect_codes to authenticated;

-- ---------------------------------------------------------------------
-- 3. Contrôles
-- ---------------------------------------------------------------------
create table public.quality_inspections (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null default private.current_company() references public.companies(id) on delete cascade,
  number              text not null,
  kind                text not null check (kind in ('reception', 'production', 'final')),
  status              text not null default 'open' check (status in ('open', 'closed')),
  decision            text check (decision is null or decision in ('accepted', 'conditional', 'rejected')),
  material_id         uuid references public.bom_materials(id),
  article_id          uuid references public.articles(id),
  production_order_id uuid references public.production_orders(id),
  purchase_receipt_id uuid references public.purchase_receipts(id),
  receipt_ref         text check (receipt_ref is null or length(receipt_ref) <= 60),
  sample_size         numeric(12,2) not null check (sample_size > 0),
  qty_accepted        numeric(12,2) not null default 0 check (qty_accepted >= 0),
  qty_rejected        numeric(12,2) not null default 0 check (qty_rejected >= 0),
  note                text check (note is null or length(note) <= 500),
  opened_at           timestamptz not null default now(),
  opened_by           uuid default auth.uid(),
  closed_at           timestamptz,
  closed_by           uuid,
  unique (company_id, number),
  check (kind <> 'reception' or material_id is not null),
  check (kind <> 'production' or production_order_id is not null),
  check (kind <> 'final' or article_id is not null or production_order_id is not null),
  check ((status = 'open' and decision is null and closed_at is null)
      or (status = 'closed' and decision is not null and closed_at is not null)),
  check (qty_accepted + qty_rejected <= sample_size)
);
create index quality_inspections_status_idx on public.quality_inspections (company_id, status, opened_at desc);

-- Les sources référencées doivent appartenir à la même société.
create function private.quality_inspections_check() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.material_id is not null and not exists (select 1 from public.bom_materials m where m.id = new.material_id and m.company_id = new.company_id) then
    raise exception 'QUALITY_SOURCE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if new.article_id is not null and not exists (select 1 from public.articles a where a.id = new.article_id and a.company_id = new.company_id) then
    raise exception 'QUALITY_SOURCE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if new.production_order_id is not null and not exists (select 1 from public.production_orders o where o.id = new.production_order_id and o.company_id = new.company_id) then
    raise exception 'QUALITY_SOURCE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if new.purchase_receipt_id is not null and not exists (select 1 from public.purchase_receipts r where r.id = new.purchase_receipt_id and r.company_id = new.company_id) then
    raise exception 'QUALITY_SOURCE_NOT_FOUND' using errcode = 'P0002';
  end if;
  return new;
end $$;
revoke execute on function private.quality_inspections_check() from public, anon, authenticated;
create trigger quality_inspections_check_iu before insert or update on public.quality_inspections
  for each row execute function private.quality_inspections_check();

alter table public.quality_inspections enable row level security;
create policy quality_inspections_select on public.quality_inspections for select to authenticated
  using (company_id = private.current_company() and private.has_perm('quality.read'));
revoke all on public.quality_inspections from anon, authenticated;
grant select on public.quality_inspections to authenticated;

-- ---------------------------------------------------------------------
-- 4. Défauts constatés (historique immuable)
-- ---------------------------------------------------------------------
create table public.quality_defects (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null default private.current_company() references public.companies(id) on delete cascade,
  inspection_id uuid not null references public.quality_inspections(id),
  defect_code   text not null,
  category      text not null,
  severity      text not null check (severity in ('minor', 'major', 'critical')),
  qty           numeric(12,2) not null check (qty > 0),
  note          text check (note is null or length(note) <= 300),
  created_at    timestamptz not null default now(),
  created_by    uuid default auth.uid()
);
create index quality_defects_inspection_idx on public.quality_defects (inspection_id);
create index quality_defects_code_idx on public.quality_defects (company_id, defect_code);

create function private.quality_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'QUALITY_IMMUTABLE' using errcode = '42501';
end $$;
revoke execute on function private.quality_immutable() from public, anon, authenticated;
create trigger quality_defects_immutable before update or delete on public.quality_defects
  for each row execute function private.quality_immutable();

alter table public.quality_defects enable row level security;
create policy quality_defects_select on public.quality_defects for select to authenticated
  using (company_id = private.current_company() and private.has_perm('quality.read'));
revoke all on public.quality_defects from anon, authenticated;
grant select on public.quality_defects to authenticated;

-- ---------------------------------------------------------------------
-- 5. Plans d'actions, non-conformités, actions correctives
-- ---------------------------------------------------------------------
create table public.quality_action_plans (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null default private.current_company() references public.companies(id) on delete cascade,
  number      text not null,
  title       text not null check (length(btrim(title)) between 3 and 160),
  objective   text check (objective is null or length(objective) <= 500),
  owner_id    uuid,
  start_date  date not null,
  target_date date not null,
  status      text not null default 'draft' check (status in ('draft', 'active', 'closed')),
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid(),
  closed_at   timestamptz,
  unique (company_id, number),
  check (target_date >= start_date),
  check ((status = 'closed') = (closed_at is not null))
);
alter table public.quality_action_plans enable row level security;
create policy quality_action_plans_select on public.quality_action_plans for select to authenticated
  using (company_id = private.current_company() and private.has_perm('quality.read'));
revoke all on public.quality_action_plans from anon, authenticated;
grant select on public.quality_action_plans to authenticated;

create table public.quality_nonconformities (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null default private.current_company() references public.companies(id) on delete cascade,
  number        text not null,
  title         text not null check (length(btrim(title)) between 3 and 160),
  description   text check (description is null or length(description) <= 1000),
  severity      text not null check (severity in ('minor', 'major', 'critical')),
  status        text not null default 'open' check (status in ('open', 'contained', 'closed')),
  inspection_id uuid references public.quality_inspections(id),
  containment   text check (containment is null or length(containment) <= 500),
  root_cause    text check (root_cause is null or length(root_cause) <= 500),
  owner_id      uuid,
  due_date      date,
  created_at    timestamptz not null default now(),
  created_by    uuid default auth.uid(),
  closed_at     timestamptz,
  closed_by     uuid,
  close_note    text check (close_note is null or length(close_note) <= 500),
  unique (company_id, number),
  check ((status = 'closed') = (closed_at is not null)),
  check (status = 'open' or containment is not null)
);
create index quality_nc_status_idx on public.quality_nonconformities (company_id, status);
alter table public.quality_nonconformities enable row level security;
create policy quality_nonconformities_select on public.quality_nonconformities for select to authenticated
  using (company_id = private.current_company() and private.has_perm('quality.read'));
revoke all on public.quality_nonconformities from anon, authenticated;
grant select on public.quality_nonconformities to authenticated;

create table public.quality_corrective_actions (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null default private.current_company() references public.companies(id) on delete cascade,
  number        text not null,
  nc_id         uuid not null references public.quality_nonconformities(id),
  plan_id       uuid references public.quality_action_plans(id),
  kind          text not null default 'corrective' check (kind in ('corrective', 'preventive')),
  action        text not null check (length(btrim(action)) between 3 and 500),
  owner_id      uuid,
  due_date      date not null,
  status        text not null default 'todo' check (status in ('todo', 'in_progress', 'done', 'verified', 'cancelled')),
  done_at       timestamptz,
  verified_at   timestamptz,
  verified_by   uuid,
  effective     boolean,
  cancel_reason text check (cancel_reason is null or length(cancel_reason) <= 300),
  created_at    timestamptz not null default now(),
  created_by    uuid default auth.uid(),
  unique (company_id, number),
  check (status <> 'done' or done_at is not null),
  check (status <> 'verified' or (effective is not null and verified_at is not null)),
  check (status <> 'cancelled' or cancel_reason is not null)
);
create index quality_ca_nc_idx on public.quality_corrective_actions (nc_id);
alter table public.quality_corrective_actions enable row level security;
create policy quality_corrective_actions_select on public.quality_corrective_actions for select to authenticated
  using (company_id = private.current_company() and private.has_perm('quality.read'));
revoke all on public.quality_corrective_actions from anon, authenticated;
grant select on public.quality_corrective_actions to authenticated;

-- Numérotation par société (préfixe et clé de séquence passés en argument du déclencheur).
create function private.quality_number() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.number is null then
    new.number := TG_ARGV[0] || to_char(now(), 'YYYY') || '-' || lpad(private.next_seq(new.company_id, TG_ARGV[1])::text, 6, '0');
  end if;
  return new;
end $$;
revoke execute on function private.quality_number() from public, anon, authenticated;
create trigger quality_inspections_number_i before insert on public.quality_inspections for each row execute function private.quality_number('QC-', 'quality_inspection');
create trigger quality_nc_number_i before insert on public.quality_nonconformities for each row execute function private.quality_number('NC-', 'quality_nc');
create trigger quality_plans_number_i before insert on public.quality_action_plans for each row execute function private.quality_number('PA-', 'quality_plan');
create trigger quality_ca_number_i before insert on public.quality_corrective_actions for each row execute function private.quality_number('CA-', 'quality_ca');

-- ---------------------------------------------------------------------
-- 6. Historique des défauts (vue)
-- ---------------------------------------------------------------------
create view public.quality_defect_history with (security_invoker = true) as
select d.id, d.created_at as occurred_at, d.company_id, i.number as inspection_number, i.kind, i.decision,
       d.defect_code, c.label as defect_label, d.category, d.severity, d.qty, d.note,
       i.id as inspection_id, i.material_id, i.article_id, i.production_order_id, d.created_by
  from public.quality_defects d
  join public.quality_inspections i on i.id = d.inspection_id
  left join public.quality_defect_codes c on c.company_id = d.company_id and c.code = d.defect_code;
grant select on public.quality_defect_history to authenticated;

-- ---------------------------------------------------------------------
-- 7. Fonctions : référentiel, contrôles, décision
-- ---------------------------------------------------------------------
create function private.quality_lock_inspection(p_id uuid) returns public.quality_inspections
language plpgsql security definer set search_path = '' as $$
declare i public.quality_inspections%rowtype;
begin
  select * into i from public.quality_inspections where id = p_id and company_id = private.current_company() for update;
  if not found then raise exception 'QUALITY_NOT_FOUND' using errcode = 'P0002'; end if;
  return i;
end $$;
revoke execute on function private.quality_lock_inspection(uuid) from public, anon, authenticated;

create function public.quality_defect_code_save(p_code text, p_label text, p_category text, p_severity text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform private.require_perm('quality.write');
  insert into public.quality_defect_codes (code, label, category, default_severity)
  values (upper(btrim(p_code)), btrim(p_label), p_category, p_severity)
  on conflict (company_id, code) do update set label = excluded.label, category = excluded.category,
    default_severity = excluded.default_severity, active = true
  returning id into v_id;
  perform private.write_audit(private.current_company(), 'quality.defect_code_save', 'quality_defect_code', v_id::text, upper(btrim(p_code)), null,
    jsonb_build_object('label', p_label, 'category', p_category, 'severity', p_severity), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

-- Ouvrir un contrôle (réception, production ou final).
create function public.quality_inspection_open(p_kind text, p_material uuid, p_article uuid, p_production_order uuid, p_purchase_receipt uuid,
  p_receipt_ref text, p_sample numeric, p_note text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := gen_random_uuid(); v_number text;
begin
  perform private.require_perm('quality.write');
  insert into public.quality_inspections (id, kind, material_id, article_id, production_order_id, purchase_receipt_id, receipt_ref, sample_size, note)
  values (v_id, p_kind, p_material, p_article, p_production_order, p_purchase_receipt, nullif(btrim(coalesce(p_receipt_ref, '')), ''), p_sample,
    nullif(btrim(coalesce(p_note, '')), ''))
  returning number into v_number;
  perform private.write_audit(private.current_company(), 'quality.inspection_open', 'quality_inspection', v_id::text, v_number, null,
    jsonb_build_object('kind', p_kind, 'sample', p_sample), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

-- Constater un défaut sur un contrôle ouvert. La gravité par défaut vient du référentiel.
create function public.quality_defect_add(p_inspection uuid, p_code text, p_qty numeric, p_severity text default null, p_note text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare i public.quality_inspections%rowtype; c public.quality_defect_codes%rowtype; v_id uuid := gen_random_uuid(); v_sev text;
begin
  perform private.require_perm('quality.write');
  i := private.quality_lock_inspection(p_inspection);
  if i.status <> 'open' then raise exception 'QUALITY_BAD_STATUS' using errcode = '55000'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'QUALITY_BAD_QTY' using errcode = '22023'; end if;
  select * into c from public.quality_defect_codes where company_id = i.company_id and code = upper(btrim(p_code)) and active;
  if not found then raise exception 'QUALITY_DEFECT_CODE_NOT_FOUND' using errcode = 'P0002'; end if;
  v_sev := coalesce(p_severity, c.default_severity);
  if v_sev not in ('minor', 'major', 'critical') then raise exception 'QUALITY_BAD_SEVERITY' using errcode = '22023'; end if;
  insert into public.quality_defects (id, inspection_id, defect_code, category, severity, qty, note)
  values (v_id, i.id, c.code, c.category, v_sev, p_qty, nullif(btrim(coalesce(p_note, '')), ''));
  return v_id;
end $$;

-- Décision sur un contrôle. Un rejet ouvre automatiquement une non-conformité.
create function public.quality_inspection_decide(p_inspection uuid, p_decision text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare i public.quality_inspections%rowtype; v_total numeric; v_crit int; v_major int; v_worst text; v_rej numeric; v_nc uuid; v_nc_number text;
begin
  perform private.require_perm('quality.approve');
  i := private.quality_lock_inspection(p_inspection);
  if i.status <> 'open' then raise exception 'QUALITY_BAD_STATUS' using errcode = '55000'; end if;
  if p_decision not in ('accepted', 'conditional', 'rejected') then raise exception 'QUALITY_BAD_DECISION' using errcode = '22023'; end if;
  select coalesce(sum(qty), 0), count(*) filter (where severity = 'critical'), count(*) filter (where severity = 'major'),
         (array_agg(severity order by case severity when 'critical' then 1 when 'major' then 2 else 3 end))[1]
    into v_total, v_crit, v_major, v_worst
    from public.quality_defects where inspection_id = i.id;
  if v_crit > 0 and p_decision <> 'rejected' then raise exception 'QUALITY_CRITICAL_DEFECT' using errcode = '22023'; end if;
  if v_major > 0 and p_decision = 'accepted' then raise exception 'QUALITY_DECISION_NOT_ALLOWED' using errcode = '22023'; end if;

  v_rej := case p_decision when 'rejected' then i.sample_size when 'conditional' then least(i.sample_size, v_total) else 0 end;
  update public.quality_inspections set status = 'closed', decision = p_decision, qty_rejected = v_rej, qty_accepted = i.sample_size - v_rej,
    note = coalesce(nullif(btrim(coalesce(p_note, '')), ''), note), closed_at = now(), closed_by = auth.uid()
    where id = i.id;

  if p_decision = 'rejected' then
    v_nc := gen_random_uuid();
    insert into public.quality_nonconformities (id, number, title, description, severity, inspection_id)
    values (v_nc, null, 'Non-conformité ' || i.number, 'Contrôle rejeté : voir les défauts constatés sur le contrôle ' || i.number,
      coalesce(v_worst, 'major'), i.id)
    returning number into v_nc_number;
    perform private.write_audit(i.company_id, 'quality.nc_open', 'quality_nonconformity', v_nc::text, v_nc_number, null,
      jsonb_build_object('inspection', i.number, 'severity', v_worst), '{}'::jsonb, 'rpc');
  end if;
  perform private.write_audit(i.company_id, 'quality.inspection_decide', 'quality_inspection', i.id::text, i.number, null,
    jsonb_build_object('decision', p_decision, 'defects', v_total, 'rejected', v_rej), '{}'::jsonb, 'rpc');
  return jsonb_build_object('decision', p_decision, 'qty_rejected', v_rej, 'nc_id', v_nc, 'nc_number', v_nc_number);
end $$;

-- ---------------------------------------------------------------------
-- 8. Non-conformités et actions
-- ---------------------------------------------------------------------
create function public.quality_nc_open(p_title text, p_description text, p_severity text, p_due date default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := gen_random_uuid(); v_number text;
begin
  perform private.require_perm('quality.write');
  insert into public.quality_nonconformities (id, number, title, description, severity, due_date)
  values (v_id, null, btrim(p_title), nullif(btrim(coalesce(p_description, '')), ''), p_severity, p_due)
  returning number into v_number;
  perform private.write_audit(private.current_company(), 'quality.nc_open', 'quality_nonconformity', v_id::text, v_number, null,
    jsonb_build_object('severity', p_severity), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

create function private.quality_lock_nc(p_id uuid) returns public.quality_nonconformities
language plpgsql security definer set search_path = '' as $$
declare n public.quality_nonconformities%rowtype;
begin
  select * into n from public.quality_nonconformities where id = p_id and company_id = private.current_company() for update;
  if not found then raise exception 'QUALITY_NOT_FOUND' using errcode = 'P0002'; end if;
  return n;
end $$;
revoke execute on function private.quality_lock_nc(uuid) from public, anon, authenticated;

-- Contenir : action immédiate et cause probable.
create function public.quality_nc_contain(p_nc uuid, p_containment text, p_root_cause text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare n public.quality_nonconformities%rowtype; v_c text := btrim(coalesce(p_containment, ''));
begin
  perform private.require_perm('quality.write');
  if length(v_c) < 5 then raise exception 'QUALITY_REASON_REQUIRED' using errcode = '22023'; end if;
  n := private.quality_lock_nc(p_nc);
  if n.status <> 'open' then raise exception 'QUALITY_BAD_STATUS' using errcode = '55000'; end if;
  update public.quality_nonconformities set status = 'contained', containment = v_c,
    root_cause = coalesce(nullif(btrim(coalesce(p_root_cause, '')), ''), root_cause) where id = p_nc;
  perform private.write_audit(n.company_id, 'quality.nc_contain', 'quality_nonconformity', n.id::text, n.number, null,
    jsonb_build_object('containment', v_c), '{}'::jsonb, 'rpc');
end $$;

-- Plans d'actions
create function public.quality_plan_create(p_title text, p_objective text, p_owner uuid, p_start date, p_target date) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := gen_random_uuid(); v_number text;
begin
  perform private.require_perm('quality.write');
  insert into public.quality_action_plans (id, number, title, objective, owner_id, start_date, target_date)
  values (v_id, null, btrim(p_title), nullif(btrim(coalesce(p_objective, '')), ''), p_owner, p_start, p_target)
  returning number into v_number;
  perform private.write_audit(private.current_company(), 'quality.plan_create', 'quality_action_plan', v_id::text, v_number, null, '{}'::jsonb, '{}'::jsonb, 'rpc');
  return v_id;
end $$;

create function public.quality_plan_activate(p_plan uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_status text;
begin
  perform private.require_perm('quality.write');
  select status into v_status from public.quality_action_plans where id = p_plan and company_id = v_co for update;
  if not found then raise exception 'QUALITY_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_status <> 'draft' then raise exception 'QUALITY_BAD_STATUS' using errcode = '55000'; end if;
  update public.quality_action_plans set status = 'active' where id = p_plan;
  perform private.write_audit(v_co, 'quality.plan_activate', 'quality_action_plan', p_plan::text, null, null, '{"status":"active"}'::jsonb, '{}'::jsonb, 'rpc');
end $$;

-- Clôture d'un plan : toutes ses actions vérifiées ou annulées.
create function public.quality_plan_close(p_plan uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_status text; v_open int;
begin
  perform private.require_perm('quality.approve');
  select status into v_status from public.quality_action_plans where id = p_plan and company_id = v_co for update;
  if not found then raise exception 'QUALITY_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_status <> 'active' then raise exception 'QUALITY_BAD_STATUS' using errcode = '55000'; end if;
  select count(*) into v_open from public.quality_corrective_actions where plan_id = p_plan and status not in ('verified', 'cancelled');
  if v_open > 0 then raise exception 'QUALITY_ACTIONS_OPEN' using errcode = '55000'; end if;
  update public.quality_action_plans set status = 'closed', closed_at = now() where id = p_plan;
  perform private.write_audit(v_co, 'quality.plan_close', 'quality_action_plan', p_plan::text, null, null, '{"status":"closed"}'::jsonb, '{}'::jsonb, 'rpc');
end $$;

-- Action corrective ou préventive sur une non-conformité ouverte.
create function public.quality_ca_add(p_nc uuid, p_kind text, p_action text, p_owner uuid, p_due date, p_plan uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare n public.quality_nonconformities%rowtype; v_id uuid := gen_random_uuid(); v_number text;
begin
  perform private.require_perm('quality.write');
  n := private.quality_lock_nc(p_nc);
  if n.status = 'closed' then raise exception 'QUALITY_BAD_STATUS' using errcode = '55000'; end if;
  if p_plan is not null and not exists (select 1 from public.quality_action_plans where id = p_plan and company_id = n.company_id and status = 'active') then
    raise exception 'QUALITY_PLAN_NOT_ACTIVE' using errcode = '55000';
  end if;
  insert into public.quality_corrective_actions (id, number, nc_id, plan_id, kind, action, owner_id, due_date)
  values (v_id, null, n.id, p_plan, p_kind, btrim(p_action), p_owner, p_due)
  returning number into v_number;
  perform private.write_audit(n.company_id, 'quality.ca_add', 'quality_corrective_action', v_id::text, v_number, null,
    jsonb_build_object('nc', n.number, 'kind', p_kind), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

create function private.quality_lock_ca(p_id uuid) returns public.quality_corrective_actions
language plpgsql security definer set search_path = '' as $$
declare a public.quality_corrective_actions%rowtype;
begin
  select * into a from public.quality_corrective_actions where id = p_id and company_id = private.current_company() for update;
  if not found then raise exception 'QUALITY_NOT_FOUND' using errcode = 'P0002'; end if;
  return a;
end $$;
revoke execute on function private.quality_lock_ca(uuid) from public, anon, authenticated;

-- Avancement : à faire → en cours → fait (les étapes peuvent être sautées vers « fait »).
create function public.quality_ca_progress(p_ca uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
declare a public.quality_corrective_actions%rowtype;
begin
  perform private.require_perm('quality.write');
  a := private.quality_lock_ca(p_ca);
  if p_status = 'in_progress' and a.status = 'todo' then
    update public.quality_corrective_actions set status = 'in_progress' where id = p_ca;
  elsif p_status = 'done' and a.status in ('todo', 'in_progress') then
    update public.quality_corrective_actions set status = 'done', done_at = now() where id = p_ca;
  else
    raise exception 'QUALITY_BAD_STATUS' using errcode = '55000';
  end if;
  perform private.write_audit(a.company_id, 'quality.ca_progress', 'quality_corrective_action', a.id::text, a.number, null,
    jsonb_build_object('status', p_status), '{}'::jsonb, 'rpc');
end $$;

-- Vérification d'efficacité par un responsable qualité (action faite → vérifiée).
create function public.quality_ca_verify(p_ca uuid, p_effective boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare a public.quality_corrective_actions%rowtype;
begin
  perform private.require_perm('quality.approve');
  a := private.quality_lock_ca(p_ca);
  if a.status <> 'done' then raise exception 'QUALITY_BAD_STATUS' using errcode = '55000'; end if;
  update public.quality_corrective_actions set status = 'verified', verified_at = now(), verified_by = auth.uid(), effective = p_effective
    where id = p_ca;
  perform private.write_audit(a.company_id, 'quality.ca_verify', 'quality_corrective_action', a.id::text, a.number, null,
    jsonb_build_object('effective', p_effective), '{}'::jsonb, 'rpc');
end $$;

create function public.quality_ca_cancel(p_ca uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare a public.quality_corrective_actions%rowtype; v_reason text := btrim(coalesce(p_reason, ''));
begin
  perform private.require_perm('quality.approve');
  if length(v_reason) < 5 then raise exception 'QUALITY_REASON_REQUIRED' using errcode = '22023'; end if;
  a := private.quality_lock_ca(p_ca);
  if a.status in ('verified', 'cancelled') then raise exception 'QUALITY_BAD_STATUS' using errcode = '55000'; end if;
  update public.quality_corrective_actions set status = 'cancelled', cancel_reason = v_reason where id = p_ca;
  perform private.write_audit(a.company_id, 'quality.ca_cancel', 'quality_corrective_action', a.id::text, a.number, null,
    jsonb_build_object('reason', v_reason), '{}'::jsonb, 'rpc');
end $$;

-- Clôture d'une non-conformité : contenue ; actions vérifiées efficaces ; sinon justification écrite.
create function public.quality_nc_close(p_nc uuid, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare n public.quality_nonconformities%rowtype; v_open int; v_verified int; v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  perform private.require_perm('quality.approve');
  n := private.quality_lock_nc(p_nc);
  if n.status <> 'contained' then raise exception 'QUALITY_BAD_STATUS' using errcode = '55000'; end if;
  select count(*) filter (where status not in ('verified', 'cancelled') or (status = 'verified' and effective is not true)),
         count(*) filter (where status = 'verified' and effective)
    into v_open, v_verified
    from public.quality_corrective_actions where nc_id = n.id;
  if v_open > 0 then raise exception 'QUALITY_ACTIONS_OPEN' using errcode = '55000'; end if;
  if v_verified = 0 and (v_note is null or length(v_note) < 10) then raise exception 'QUALITY_JUSTIFICATION_REQUIRED' using errcode = '22023'; end if;
  update public.quality_nonconformities set status = 'closed', closed_at = now(), closed_by = auth.uid(), close_note = v_note where id = n.id;
  perform private.write_audit(n.company_id, 'quality.nc_close', 'quality_nonconformity', n.id::text, n.number, null,
    jsonb_build_object('verified_actions', v_verified), '{}'::jsonb, 'rpc');
end $$;

-- ---------------------------------------------------------------------
-- 9. Indicateurs qualité
-- ---------------------------------------------------------------------
create function public.quality_dashboard() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); r jsonb;
begin
  perform private.require_perm('quality.read');
  select jsonb_build_object(
    'controls', (select coalesce(jsonb_agg(jsonb_build_object('kind', k.kind, 'closed', k.closed_n, 'accepted', k.accepted_n,
        'conditional', k.conditional_n, 'rejected', k.rejected_n,
        'first_pass_pct', case when k.closed_n = 0 then null else round(100.0 * k.accepted_n / k.closed_n, 1) end,
        'defects_per_unit', case when k.sampled = 0 then null else round(k.defects / k.sampled, 2) end) order by k.kind), '[]'::jsonb)
      from (select i.kind, count(*) filter (where i.status = 'closed') closed_n,
              count(*) filter (where i.decision = 'accepted') accepted_n, count(*) filter (where i.decision = 'conditional') conditional_n,
              count(*) filter (where i.decision = 'rejected') rejected_n,
              coalesce(sum(i.sample_size) filter (where i.status = 'closed'), 0) sampled,
              coalesce((select sum(d.qty) from public.quality_defects d join public.quality_inspections j on j.id = d.inspection_id
                        where j.company_id = v_co and j.kind = i.kind and j.status = 'closed'), 0) defects
            from public.quality_inspections i where i.company_id = v_co group by i.kind) k),
    'pareto', (select coalesce(jsonb_agg(jsonb_build_object('code', p.defect_code, 'label', p.label, 'category', p.category, 'qty', p.qty) order by p.qty desc), '[]'::jsonb)
      from (select d.defect_code, c.label, d.category, sum(d.qty) qty from public.quality_defects d
              left join public.quality_defect_codes c on c.company_id = d.company_id and c.code = d.defect_code
             where d.company_id = v_co group by d.defect_code, c.label, d.category order by sum(d.qty) desc limit 10) p),
    'open_inspections', (select count(*) from public.quality_inspections where company_id = v_co and status = 'open'),
    'nc_open', (select count(*) from public.quality_nonconformities where company_id = v_co and status <> 'closed'),
    'nc_by_severity', (select coalesce(jsonb_object_agg(s.severity, s.c), '{}'::jsonb) from (
        select severity, count(*) c from public.quality_nonconformities where company_id = v_co and status <> 'closed' group by severity) s),
    'actions_overdue', (select count(*) from public.quality_corrective_actions where company_id = v_co
        and status in ('todo', 'in_progress', 'done') and due_date < current_date),
    'action_effectiveness_pct', (select case when count(*) filter (where status = 'verified') = 0 then null
        else round(100.0 * count(*) filter (where status = 'verified' and effective) / count(*) filter (where status = 'verified'), 1) end
        from public.quality_corrective_actions where company_id = v_co),
    'plans', (select coalesce(jsonb_object_agg(s.status, s.c), '{}'::jsonb) from (
        select status, count(*) c from public.quality_action_plans where company_id = v_co group by status) s)
  ) into r;
  return r;
end $$;

-- ---------------------------------------------------------------------
-- 10. Droits d'exécution
-- ---------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'public.quality_defect_code_save(text, text, text, text)',
    'public.quality_inspection_open(text, uuid, uuid, uuid, uuid, text, numeric, text)',
    'public.quality_defect_add(uuid, text, numeric, text, text)',
    'public.quality_inspection_decide(uuid, text, text)',
    'public.quality_nc_open(text, text, text, date)',
    'public.quality_nc_contain(uuid, text, text)',
    'public.quality_plan_create(text, text, uuid, date, date)',
    'public.quality_plan_activate(uuid)',
    'public.quality_plan_close(uuid)',
    'public.quality_ca_add(uuid, text, text, uuid, date, uuid)',
    'public.quality_ca_progress(uuid, text)',
    'public.quality_ca_verify(uuid, boolean)',
    'public.quality_ca_cancel(uuid, text)',
    'public.quality_nc_close(uuid, text)',
    'public.quality_dashboard()'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
